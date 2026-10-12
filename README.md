# CRDT Collaborative Editor

A real-time collaborative text editor built on a **custom sequence CRDT** in TypeScript, with
a Node.js WebSocket sync server, offline editing, and PostgreSQL persistence.

> Status: in development.

## Goals
- **Custom CRDT:** a sequence CRDT (RGA / simplified YATA). Concurrent edits converge on every replica
  without a central lock.
- **Sync server:** a Node.js WebSocket server with rooms, presence/cursors and backpressure-aware broadcast.
- **Persistence:** an operation log in PostgreSQL plus periodic snapshots, for fast document loads.
- **Offline editing:** keep editing while disconnected, then merge on reconnect.
- **Verification:** fuzz tests asserting convergence across randomized concurrent-edit runs,
  and k6 load tests for concurrent editors and p99 sync latency.

## Architecture (planned)
```
browser (React/Next.js editor + CRDT replica)
   ⇅ WebSocket (ops, presence)
sync server (Node.js) ─► op log + snapshots (PostgreSQL)
   └─ (later) Redis pub/sub for horizontal scaling
```

## Design decisions
_To fill in: CRDT vs. OT, the choice of sequence CRDT, tombstone garbage collection, and the snapshot cadence._

## Benchmarks
_To fill in from measured results: convergence fuzz runs, concurrent editors, p99 sync latency,
and document load time with vs. without snapshots. Scripts will live in `bench/`._

## Limitations
_To fill in._
