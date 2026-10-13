# Design

This document explains the decisions behind the editor and the guarantees each layer provides.
Sections are added as milestones land; anything not yet built is marked as such.

## 1. CRDT vs. OT

Both let several users edit one document concurrently without locking. They differ in where
correctness lives.

**Operational Transformation (OT)** sends position-based ops (`insert "x" at 5`) and _transforms_
each incoming op against the concurrent ops that were applied before it (`insert at 5` becomes
`insert at 6` because someone inserted before position 5). Getting the transformation functions
right for every pair of concurrent ops is notoriously subtle, and practical OT systems (Google Docs,
for instance) depend on a central server to impose a single order on ops. That makes
offline-first editing and peer-to-peer sync awkward.

**CRDTs (Conflict-free Replicated Data Types)** [Shapiro et al. 2011] give every element a unique,
immutable identity. Ops refer to identities (`insert "x" after element (12, alice)`), not to
positions, so they don't need transforming. If integration is commutative, associative and
idempotent, any two replicas that have seen the same set of ops are in the same state, whatever
the order of arrival. This is _strong eventual consistency_. The server becomes a relay and a
store, not an arbiter of order.

**Why CRDT here.** Offline editing is a requirement. A replica that has been offline for an hour
must be able to merge without the server re-sequencing its history. CRDTs also make correctness
_testable in isolation_: the core is a pure library, and convergence can be checked with
property-based tests that don't need a network at all.

**What it costs.**

- **Metadata per character.** Each character carries an ID and an origin; deleted characters
  become tombstones (see §4).
- **Intent can be surprising.** CRDTs guarantee convergence, not that the merged result is what
  either user meant. The interleaving anomaly (§3) is one example.

## 2. Which sequence CRDT: RGA

The two serious candidates were **RGA** [Roh et al. 2011] and **YATA** [Nicolaescu et al. 2016],
the algorithm behind Yjs.

### Model

Each element has an ID `(clock, replica)`, where `clock` is a Lamport timestamp [Lamport 1978].
IDs are totally ordered: by clock, then by replica ID. Replica IDs are compared by UTF-16 code
unit, never `localeCompare`, since two replicas with different locale data could otherwise order
the same pair differently.

An insert names one **origin**: the element it was typed directly after, or `ROOT` for the start
of the document.

### The integration rule

Conceptually, elements form a tree. Each element is a child of its origin, siblings are ordered by
ID with the greatest first, and the document is the depth-first, pre-order traversal of that tree.
The traversal is a function of the set of ops alone, which is why replicas converge.

Implemented over a flat sequence, the rule becomes: _start just right of the origin, and skip every
element whose ID is greater than the new element's ID_ (`Doc.#integrateInsert`).

### Why skipping by ID is enough

This step relies on the Lamport property: an element created by a replica that had already seen
element `S` has a clock greater than `S`'s.

Scanning right from the origin `O`, the scan meets three kinds of element:

1. **A newer sibling `S`** (`S > X`). It is skipped. So is every element in `S`'s subtree: each was
   created after seeing `S`, so its clock is larger than `S`'s and therefore larger than `X`'s.
2. **An older sibling** (`< X`). The scan stops before it, as required.
3. **The end of `O`'s subtree.** Whatever follows is an older sibling of `O` or of one of `O`'s
   ancestors. All of those are smaller than `O`, which is smaller than `X`, so the scan stops
   there too.

A local insert takes the same path. Its clock exceeds every clock the replica has seen, so nothing
is skipped and it lands directly after its origin. The skip loop and the tree definition agree in
every case.

### Why RGA over YATA

- **Simpler integration.** RGA integrates with one comparison against one reference. YATA records
  both a left and a right origin and resolves conflicts by comparing the origins of competing
  elements, a subtler procedure whose correctness argument is harder to state (and Yjs's
  implementation differs from the paper in places). RGA's rule is ten lines, and the argument
  above fits on a page.
- **Typed runs stay together.** Each character's origin is the previous character, so a typed run
  is a chain in the tree. That suits run-length encoding (milestone 3), and it is also why forward
  typing doesn't interleave (§3).
- **What we give up.** YATA avoids some interleaving cases RGA has (§3). Fugue
  [Weidner & Kleppmann 2025] does better than both. That gain is real but modest for typical
  editing, so it is documented as a limitation rather than paid for in complexity.

### Ops and delivery

Ops are per character:

- **`InsertOp { id, seq, origin, char }`** inserts a single UTF-16 code unit, so indices match
  `<textarea>` selection offsets. Surrogate pairs are two elements; the editor never places a
  cursor between them.
- **`DeleteOp { id, seq, target }`** tombstones one element.

Every op, deletes included, also carries **`seq`**, a contiguous per-replica counter (1, 2, 3, …).
The two counters do different jobs:

- **`id` orders the element** within the document.
- **`seq` tracks delivery.** Lamport clocks jump when a replica observes remote ops (1, 2, 51,
  52, …), so "the highest clock seen from Alice" cannot tell you whether you are missing one of
  her ops. Contiguous `seq` values make a **version vector** (`{replica: highest seq}`) exact:
  "everything from Alice up to 7" means ops 1..7, so sync is "send me what's after my version
  vector".

`Doc.apply` accepts ops in any order and with duplicates:

- **Idempotence.** An op whose `seq` is already covered by the version vector, or that is already
  buffered, is a no-op. Concurrent deletes of the same element tombstone it once.
- **Buffering.** An op whose dependencies are missing is parked in a `PendingBuffer`, indexed by
  the one dependency it is blocked on. The dependencies are:
  - the previous op from the same replica (per-replica FIFO, which keeps the version vector
    contiguous);
  - the insert's origin, or the delete's target.

  Integrating an op releases exactly the ops waiting on it, which are then re-checked. The cost is
  proportional to the number of waiters, not the buffer size, and it runs as an iterative worklist,
  so a long chain cannot overflow the stack.

- **Validation at the boundary.** `parseOp` checks the shape of untrusted input. It also enforces
  `origin.clock < id.clock` (and `target.clock < id.clock` for deletes), because the integration
  argument above assumes no op references an element its creator could not have seen.

### Replica identity

Two live replicas sharing an ID would issue colliding element IDs and diverge silently. The client
(milestone 6) therefore generates a fresh replica ID per session rather than resuming a persisted
one. Its earlier offline ops remain valid ops under the old ID. As a cheap tripwire, `Doc.apply`
rejects an op that claims this replica's ID with a `seq` it never issued.

## 3. The interleaving anomaly

When two users type at the same position concurrently, a merge can interleave their characters
(`"Alice"` + `"Bob"` → `"ABloibce"`) [Kleppmann et al. 2019]. Convergence is preserved, but the
result is garbage. How RGA behaves depends on the direction of typing:

- **Forward typing (the common case) does not interleave.** Each character's origin is the one
  before it, so Alice's run is one chain hanging off the shared origin, and Bob's is another. The
  two chains are siblings and are ordered as whole subtrees. Tested in
  `does not interleave concurrently typed runs at the same position`.
- **Backward typing can interleave.** This is what happens when a user repeatedly inserts at the
  same position, e.g. typing and then pressing ← each time. Every character is then a sibling
  under the same origin, ordered purely by ID, so concurrent runs mix: `"abc"` and `"xyz"` merge to
  `"xaybzc"`. The test
  `known RGA limitation: text typed backwards ... can interleave` pins down this exact output.
  YATA and Fugue handle this better; this project accepts it as a known limitation.

## 4. Representation, tombstones and garbage collection

### From the naive model to runs

The first implementation, kept as `test/reference/naive-doc.ts`, stored one object per character
in a flat array. That made every op O(n):

- `indexOf` to find the origin;
- a scan over the array to map a visible index to an element;
- a `splice` to insert.

Replaying the 260K-op `automerge-paper` trace took about 61 s and retained 269 bytes per inserted
character.

The shipped `Doc` keeps the same algorithm over a different representation:

- **Runs.** A run is a maximal chain of characters typed one after another by one replica.
  Character _k_ has ID `(clock + k, replica)`, seq `seq + k`, and origin character _k − 1_.
  - A local or remote insert whose origin is the last character of a run, and whose clock and seq
    continue that run, appends to the run's string.
  - A delete splits a run around the deleted character. Runs re-merge when their neighbours share
    the tombstone flag again.
  - On `automerge-paper`, 182,315 inserted characters become 12,490 runs.
- **Blocks.** Runs sit in a doubly linked list of blocks holding up to 128 runs each. Every block
  caches its visible length, so mapping a visible index skips whole blocks.
- **Per-replica index.** Each replica's runs are kept in an array sorted by clock, and their clock
  ranges are disjoint, so finding an element by ID is a binary search.
- **The integrate rule works on whole runs.** IDs increase along a run, so if a run's first
  character is newer than the incoming element, all of it is, and the RGA skip loop can skip it
  in one step. The one special case is an origin in the middle of a run: the next element is then
  the next character of that run, and if it is older, the run is split there.

### The document is the op log

There is no array of op objects:

- **Inserts** are reconstructed from runs.
- **Deletes** are kept as run-length-encoded records. A record holds consecutive clocks and seqs
  from one replica whose targets step through consecutive clocks (+1 for forward delete, −1 for
  backspace). 77,463 deletes become 7,334 records.
- **`opsSince(vv)`** rebuilds exactly the original ops and sorts them by ID. That order is causal,
  because every op's clock exceeds the clocks of everything it depends on, so a receiver never
  has to buffer them.
- **Snapshots** therefore contain the full history (792 KB of JSON for `automerge-paper`). A
  replica restored from one can still serve any peer.

A differential property test (`differential.property.test.ts`) runs the optimized `Doc` and the
naive reference side by side on the same random scenarios. It requires identical text, version
vectors, buffered-op counts and `opsSince` output at every step.

### Tombstones

Deleted characters stay in the sequence because concurrent and future ops may reference them:

- an insert whose origin was concurrently deleted must still find its place;
- a delete that arrives late must still find its target.

This is inherent to the design, and tombstones are why memory is measured per _inserted_ character
(26 B) as well as per _visible_ character (45 B on `automerge-paper`, 136 B on the delete-heavy
`seph-blog1`). In the run representation a tombstone costs nothing extra beyond the run boundaries
it creates. Deleted text is kept so that inserts can still be served to peers that never saw them.

### Garbage collection (not implemented)

A tombstone could be discarded once it is **causally stable**: every replica that will ever send
an op has already seen the delete, so nobody can reference the element again. Detecting that
requires knowing the version vector of every replica that might still be offline with unsynced
edits. In an offline-first system that set is unbounded; a laptop can reappear after a month.

Two practical options exist:

- **Epoch-based compaction.** The server declares a cut-off. Clients older than the epoch must
  discard local state and reload, and their unsynced ops are rebased as plain text inserts.
- **Server-side GC with stubs, as Yjs does.** Deleted content is dropped but a placeholder keeps
  the IDs, so the structure stays valid.

Both trade a rare, user-visible failure mode for bounded growth. At the measured cost of tens of
bytes per character ever typed, a 1M-keystroke document stays in the tens of megabytes, so this
project accepts unbounded tombstones and documents the trade-off.

## 5. Persistence and snapshots

### Storage model

Postgres holds an **append-only op log** (`ops`, one row per op) and **snapshots** (`snapshots`,
the serialized `DocSnapshot` plus `upto_id`). To load a document, read the latest snapshot, then
the ops with `id > upto_id`.

- **Characters are stored as integer UTF-16 code units, not `text`.** An element can be one half
  of a surrogate pair (emoji are two elements). A lone surrogate is not valid UTF-8, and node-pg
  would silently turn it into U+FFFD. Snapshot JSON is safe because `JSON.stringify` escapes lone
  surrogates (`"\ud83d"`). The same holds for WebSocket frames, which are always JSON.
- **Appends are idempotent:** `UNIQUE (doc_id, replica, seq)` with `ON CONFLICT DO NOTHING`. A
  client resending after a lost ack, or two instances racing, can't duplicate an op.

### The invariant that makes "snapshot + ops after it" correct

**Per document, ops commit in id order.** Each append transaction takes
`pg_advisory_xact_lock(hash(doc))` before allocating ids. Without the lock, transaction T1 could
hold id 100 while T2 holds 101 and commits first; a snapshot taken in between would record
`upto_id = 101` and op 100 would never be loaded again. With the lock, every MVCC snapshot sees a
prefix of the document's log, so:

- **Compaction runs in a REPEATABLE READ transaction without the append lock.** It reads a
  consistent prefix and never blocks writers. Concurrent compactions of one document (two server
  instances) are serialized by a second, try-lock; the loser skips. The race test found this: two
  compactions deleting the same old snapshot rows hit a serialization failure.
- **Snapshots are built from the database, never from a server's in-memory `Doc`.** With several
  instances, any one room may lag ops persisted elsewhere; its state could not honestly claim an
  `upto_id`.
- **A snapshot is refused if any stored op fails to integrate.** The snapshot would claim to cover
  that op by position without containing it.

### Cadence

A snapshot is taken every `SNAPSHOT_EVERY = 1000` persisted ops per document, and when an idle
room is unloaded. Measured on `automerge-paper` (260K ops, local Postgres 17 in Docker, two runs;
see the README):

| Load path               | Time                                   |
| ----------------------- | -------------------------------------- |
| Full log replay         | 2.46–2.82 s                            |
| Snapshot + 0-op tail    | 39–41 ms                               |
| Snapshot + 1000-op tail | 65–82 ms                               |
| Incremental compaction  | 151 ms per 1000 ops (off the hot path) |

The cadence bounds the worst-case load at "parse one snapshot + replay 999 ops", which is tens of
milliseconds. Compaction costs about 0.15 ms per op amortized, and runs in the background after a
group commit. Snapshotting more often would barely change load time but would rewrite the ~0.8 MB
snapshot more often. Much less often, and the tail replay starts to dominate loads. Two snapshots
are kept per document. The op log itself is kept in full: it is the audit trail, and pruning it
is a later optimization, since snapshots already contain full history.

## 6. Server delivery guarantees

The server is a relay plus durable store. Correctness of the merged document never depends on it:
the CRDT converges under any delivery order. What the server does guarantee:

1. **Durable acknowledgement.** An `ack {vv}` is sent only after the acknowledged ops are
   committed to Postgres. Clients keep unacked ops in their outbox and resend them on reconnect;
   resends are deduplicated by the server `Doc` and by the unique constraint.
2. **Persist-before-broadcast.** Other clients receive an op only after it is durable. If the
   server crashes, no client can hold an op the server has lost.
3. **Exact catch-up.** On connect, the client sends its version vector; the server replies with
   exactly `opsSince(vv)` (or a snapshot, if the client is empty). The client then uploads
   `opsSince(serverVv)`. Because version vectors over contiguous `seq`s are exact, after both
   steps each side has everything the other had.
4. **Causal, at-least-once delivery while connected.** Ops are integrated before they are
   broadcast, so the stream a client receives is in an order that integrates without buffering.
   An op may arrive twice (for example after a reconnect); it is then a no-op.
5. **Isolation from slow clients.** Each connection has its own queue, written only while the
   socket's buffered bytes are under a high-water mark, so a slow reader costs bounded memory and
   never delays other clients. A client is disconnected (close code 4008) when either:
   - its backlog exceeds a cap, or
   - its socket makes **no write progress** for a configured number of timer ticks.

   Disconnecting is safe because of (3): the client reconnects and receives exactly what it
   missed. Two details came from the backpressure test:
   - "Backlog non-empty for N ms" wrongly kills a healthy client draining a large burst, so the
     rule is "no progress".
   - Progress is counted in ticks, not wall-clock time, so the server's own event-loop pauses are
     never blamed on clients.

6. **Best-effort presence.** Cursors and the user list are latest-wins per peer, coalesced, and
   sent only when the reliable queue is empty. Losing a presence update is harmless.

Not guaranteed: anything about clients that never reconnect (their unsynced ops are lost with the
device), or authentication. Any client may open any document, and a connection may upload ops only
for replica IDs it declared, which prevents accidents, not malice.

## 7. Offline client

`packages/client` (`SyncClient`) is framework-agnostic; the web app is a thin view over it.

- **Local-first editing.** An edit is applied to the in-memory `Doc` immediately. It is then
  appended to an IndexedDB **outbox** and, if connected, sent. The UI never waits on the network.
- **What is durable on the device:**
  - the outbox: every unacknowledged local op, written on every edit;
  - a document snapshot, written debounced (at most one per second).

  Recovery after a crash or reload is _snapshot + outbox_. Every local op is in one of the two or
  has been acked, and remote ops missing from an older snapshot are re-fetched by version vector.

- **A fresh replica ID per session, never resumed.** Resuming an ID after a crash risks reissuing
  a `seq` the server already holds from before the crash, which would silently corrupt the
  version vectors. Ops from earlier sessions keep their old IDs. The client declares those IDs
  in `hello.owns`, so the server accepts them from this connection. A side benefit: two tabs on
  one document are just two replicas. Their outbox keys `[doc, replica, seq]` never collide, and
  no cross-tab locking is needed. The cost is one version-vector entry per session.
- **Reconnect** uses exponential backoff with full jitter, so a server restart doesn't trigger a
  thundering herd. Then comes the two-way version-vector diff of §6. A client with an empty
  version vector adopts the server's snapshot wholesale, which makes first loads fast.
- **Storage failures** (quota, private browsing) are logged and editing continues. The session
  still syncs; only crash-safety is lost.

The end-to-end test (`packages/client/test/offline.e2e.test.ts`) runs a real server, with Postgres
when `DATABASE_URL` is set, two clients over real WebSockets, and an IndexedDB implementation per
"browser":

1. Both clients sync, then the server is stopped.
2. Both clients edit offline.
3. One client reloads its page while still offline and keeps editing under a new replica ID.
4. The server restarts from storage on the same port.
5. Both clients reconnect by themselves and converge.
6. A third client opening fresh sees the merged text.
7. Both outboxes are empty on disk.

## 8. Scale-out

Several stateless server instances can serve the same document. There is no sticky routing and
no document ownership:

- **Postgres is the source of truth.** Every instance appends its clients' ops (idempotently,
  under the per-document append lock of §5).
- **Redis pub/sub is the fast path.** After committing, an instance publishes the batch on
  `collab:doc:<id>`. Other instances hosting the document integrate it into their room's `Doc`
  and forward it to their clients. They don't persist it again; it is already durable.
- **Storage catch-up is the reliable path.** Pub/sub is at-most-once: a subscriber that
  reconnects misses messages. Each room therefore also polls `ops WHERE id > cursor` every 2 s. By
  the commit-order invariant the cursor is exact: no op can later commit below it. Duplicates from
  the two paths are no-ops. A test drops 100% of fan-out messages and still converges.
- **Subscribe, then load.** A room subscribes before reading storage, so ops committed in between
  arrive by one path or the other.
- **Presence across instances.**
  - A newly opened room publishes `who`, and other instances re-announce their users.
  - Remote users appear in welcomes.
  - Remote presence expires unless it is re-announced every 15 s (expiry at 45 s), because a
    crashed instance never sends `leave`.

Why not route each document to one owner instance (consistent hashing)? That gives cheaper
fan-out and no cross-instance presence, but needs a routing layer and handoff on rebalancing.
Since the CRDT makes multi-writer safe, any-instance routing behind a plain load balancer is the
simpler operational choice at this scale. Ownership would be the next step if a single hot
document's fan-out dominated.

Load-test results are in the README. On one laptop, 100 concurrent editors on one document split
across two instances measured p99 166 ms end to end, and Postgres commit latency is the first
server-side limit.

## References

- Lamport, L. (1978). Time, clocks, and the ordering of events in a distributed system.
  _Communications of the ACM_, 21(7), 558–565. https://doi.org/10.1145/359545.359563
- Shapiro, M., Preguiça, N., Baquero, C., & Zawirski, M. (2011). Conflict-free replicated data
  types. In _Stabilization, Safety, and Security of Distributed Systems (SSS 2011)_, LNCS 6976,
  386–400. Springer. https://doi.org/10.1007/978-3-642-24550-3_29
- Roh, H.-G., Jeon, M., Kim, J.-S., & Lee, J. (2011). Replicated abstract data types: Building
  blocks for collaborative applications. _Journal of Parallel and Distributed Computing_, 71(3),
  354–368. https://doi.org/10.1016/j.jpdc.2010.12.006
- Nicolaescu, P., Jahns, K., Derntl, M., & Klamma, R. (2016). Near real-time peer-to-peer shared
  editing on extensible data types. In _Proceedings of GROUP '16_. ACM.
  https://doi.org/10.1145/2957276.2957310
- Kleppmann, M., Gomes, V. B. F., Mulligan, D. P., & Beresford, A. R. (2019). Interleaving
  anomalies in collaborative text editors. In _Proceedings of PaPoC '19 (EuroSys workshop)_. ACM.
  https://doi.org/10.1145/3301419.3323972
- Weidner, M., & Kleppmann, M. (2025). The art of the Fugue: Minimizing interleaving in
  collaborative text editing. _IEEE Transactions on Parallel and Distributed Systems_, 36(11),
  2425–2437. https://doi.org/10.1109/TPDS.2025.3611880
