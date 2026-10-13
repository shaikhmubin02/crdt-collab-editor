import { ROOT, type DocSnapshot, type Op } from '@collab/crdt';
import pg from 'pg';
import { buildSnapshot } from './snapshot-builder.ts';
import type { CompactResult, DocStore, OpsPage, StoredDoc } from './store.ts';

/**
 * Schema. One row per op, with the character stored as an integer UTF-16 code unit: an element
 * can be half of a surrogate pair, which Postgres `text` (UTF-8) cannot represent and node-pg
 * would silently replace with U+FFFD.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS ops (
  id          bigserial PRIMARY KEY,
  doc_id      text     NOT NULL,
  replica     text     NOT NULL,
  seq         integer  NOT NULL,
  clock       bigint   NOT NULL,
  kind        smallint NOT NULL,  -- 0 = insert, 1 = delete
  ref_replica text     NOT NULL,  -- insert: origin ('' = ROOT); delete: target
  ref_clock   bigint   NOT NULL,
  code_unit   integer,            -- insert only
  UNIQUE (doc_id, replica, seq)
);
CREATE INDEX IF NOT EXISTS ops_doc_id_id ON ops (doc_id, id);

CREATE TABLE IF NOT EXISTS snapshots (
  doc_id     text        NOT NULL,
  upto_id    bigint      NOT NULL,  -- covers every op of this doc with id <= upto_id
  op_count   bigint      NOT NULL,
  data       text        NOT NULL,  -- JSON DocSnapshot; JSON escapes lone surrogates
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, upto_id)
);
`;

/** Snapshots kept per document (older ones are deleted on compaction). */
const KEEP_SNAPSHOTS = 2;

interface OpRow {
  id: string;
  replica: string;
  seq: number;
  clock: string;
  kind: number;
  ref_replica: string;
  ref_clock: string;
  code_unit: number | null;
}

/**
 * Op log + snapshots in PostgreSQL.
 *
 * Correctness hinges on one invariant: **for each document, ops commit in id order.** Appends take
 * a per-document advisory lock before allocating ids, so a reader's MVCC snapshot always sees a
 * prefix of the document's log in id order. That makes "snapshot covers ids <= upto_id, load the
 * ops with id > upto_id" exact, even with several server instances appending to one document.
 * Without the lock, a transaction holding id 100 could commit after one holding id 101, and a
 * snapshot taken in between would skip op 100 forever.
 */
export class PostgresStore implements DocStore {
  readonly #pool: pg.Pool;

  constructor(connectionString: string, poolSize = 10) {
    this.#pool = new pg.Pool({ connectionString, max: poolSize });
  }

  async migrate(): Promise<void> {
    await this.#pool.query(SCHEMA);
  }

  async load(docId: string): Promise<StoredDoc> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snap = await client.query<{ upto_id: string; data: string }>(
        'SELECT upto_id, data FROM snapshots WHERE doc_id = $1 ORDER BY upto_id DESC LIMIT 1',
        [docId],
      );
      const row = snap.rows[0];
      const upto = row?.upto_id ?? '0';
      const ops = await this.#opsAfter(client, docId, upto);
      await client.query('COMMIT');
      return {
        snapshot: row ? (JSON.parse(row.data) as DocSnapshot) : null,
        ops: ops.map(toOp),
        cursor: ops.at(-1)?.id ?? upto,
      };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async append(docId: string, ops: readonly Op[]): Promise<void> {
    if (ops.length === 0) return;
    const cols = {
      replica: [] as string[],
      seq: [] as number[],
      clock: [] as number[],
      kind: [] as number[],
      refReplica: [] as string[],
      refClock: [] as number[],
      codeUnit: [] as (number | null)[],
    };
    for (const op of ops) {
      const ref = op.type === 'insert' ? op.origin : op.target;
      cols.replica.push(op.id.replica);
      cols.seq.push(op.seq);
      cols.clock.push(op.id.clock);
      cols.kind.push(op.type === 'insert' ? 0 : 1);
      cols.refReplica.push(ref.replica);
      cols.refClock.push(ref.clock);
      cols.codeUnit.push(op.type === 'insert' ? op.char.charCodeAt(0) : null);
    }
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // Seed 0 = append lock (seed 1 is the compaction lock).
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [docId]);
      await client.query(
        `INSERT INTO ops (doc_id, replica, seq, clock, kind, ref_replica, ref_clock, code_unit)
         SELECT $1, u.replica, u.seq, u.clock, u.kind, u.ref_replica, u.ref_clock, u.code_unit
         FROM unnest($2::text[], $3::int[], $4::bigint[], $5::smallint[], $6::text[], $7::bigint[], $8::int[])
           WITH ORDINALITY AS u(replica, seq, clock, kind, ref_replica, ref_clock, code_unit, ord)
         ORDER BY u.ord
         ON CONFLICT (doc_id, replica, seq) DO NOTHING`,
        [
          docId,
          cols.replica,
          cols.seq,
          cols.clock,
          cols.kind,
          cols.refReplica,
          cols.refClock,
          cols.codeUnit,
        ],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async compact(docId: string): Promise<CompactResult | null> {
    const client = await this.#pool.connect();
    try {
      // A consistent read (a prefix of the log, by the invariant above), so compaction doesn't
      // need the append lock and never blocks writers. Concurrent compactions of one document
      // (e.g. two instances) are serialized by a separate lock; the loser just skips.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const lock = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 1)) AS ok',
        [docId],
      );
      if (!lock.rows[0]?.ok) {
        await client.query('COMMIT');
        return null;
      }
      const snap = await client.query<{ upto_id: string; op_count: string; data: string }>(
        'SELECT upto_id, op_count, data FROM snapshots WHERE doc_id = $1 ORDER BY upto_id DESC LIMIT 1',
        [docId],
      );
      const prev = snap.rows[0];
      const rows = await this.#opsAfter(client, docId, prev?.upto_id ?? '0');
      const last = rows.at(-1);
      if (!last) {
        await client.query('COMMIT');
        return null;
      }
      const previous = prev ? (JSON.parse(prev.data) as DocSnapshot) : null;
      const snapshot = buildSnapshot(previous, rows.map(toOp));
      const opCount = Number(prev?.op_count ?? 0) + rows.length;
      await client.query(
        `INSERT INTO snapshots (doc_id, upto_id, op_count, data) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [docId, last.id, opCount, JSON.stringify(snapshot)],
      );
      await client.query(
        `DELETE FROM snapshots WHERE doc_id = $1 AND upto_id NOT IN (
           SELECT upto_id FROM snapshots WHERE doc_id = $1 ORDER BY upto_id DESC LIMIT $2)`,
        [docId, KEEP_SNAPSHOTS],
      );
      await client.query('COMMIT');
      return { ops: opCount, replayed: rows.length };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Ops with id > `cursor`. Exact by the commit-order invariant: no op can later commit with an
   * id below a cursor we have already returned.
   */
  async opsAfter(docId: string, cursor: string): Promise<OpsPage> {
    const rows = await this.#opsAfter(this.#pool, docId, cursor);
    return { ops: rows.map(toOp), cursor: rows.at(-1)?.id ?? cursor };
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #opsAfter(db: pg.Pool | pg.PoolClient, docId: string, afterId: string): Promise<OpRow[]> {
    const result = await db.query<OpRow>(
      `SELECT id, replica, seq, clock, kind, ref_replica, ref_clock, code_unit
       FROM ops WHERE doc_id = $1 AND id > $2 ORDER BY id`,
      [docId, afterId],
    );
    return result.rows;
  }
}

function toOp(row: OpRow): Op {
  const id = { clock: Number(row.clock), replica: row.replica };
  const ref =
    row.ref_replica === '' ? ROOT : { clock: Number(row.ref_clock), replica: row.ref_replica };
  if (row.kind === 0) {
    return {
      type: 'insert',
      id,
      seq: row.seq,
      origin: ref,
      char: String.fromCharCode(row.code_unit ?? 0),
    };
  }
  return { type: 'delete', id, seq: row.seq, target: ref };
}
