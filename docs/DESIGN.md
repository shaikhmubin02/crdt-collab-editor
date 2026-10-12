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

## 4. Tombstones and garbage collection

_Milestone 3 / 5. To be written with the measured memory-per-character numbers._

## 5. Snapshots

_Milestone 5._

## 6. Server delivery guarantees

_Milestone 4._

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
