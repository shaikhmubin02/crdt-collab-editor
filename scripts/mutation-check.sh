#!/usr/bin/env bash
# Sanity check for the property tests: inject known bugs into the CRDT one at a time and confirm the
# convergence properties catch each one. A mutant that survives means the tests are too weak.
#
# Usage: scripts/mutation-check.sh   (from the repo root, with a clean packages/crdt/src)
set -euo pipefail
cd "$(dirname "$0")/../packages/crdt"

if ! git diff --quiet -- src; then
  echo "packages/crdt/src has uncommitted changes; refusing to mutate it" >&2
  exit 2
fi
trap 'git checkout -q -- src' EXIT

survivors=0
mutate() {
  local name=$1 file=$2 expr=$3
  sed -i "$expr" "$file"
  if git diff --quiet -- "$file"; then
    echo "ERROR  $name: mutation did not apply (source changed?)" >&2
    exit 2
  fi
  if FC_NUM_RUNS="${FC_NUM_RUNS:-1000}" npx vitest run test/convergence.property.test.ts >/dev/null 2>&1; then
    echo "SURVIVED  $name"
    survivors=$((survivors + 1))
  else
    echo "killed    $name"
  fi
  git checkout -q -- "$file"
}

mutate "no Lamport observe on remote ops" src/doc.ts \
  's/    this.#clock.observe(op.id.clock);/    void op.id.clock;/'
mutate "ignore replica tie-break" src/id.ts \
  's/  if (a.replica === b.replica) return 0;/  return 0;/'
mutate "skip smaller IDs instead of greater" src/doc.ts \
  's/compareIds(next.id, op.id) > 0/compareIds(next.id, op.id) < 0/'
mutate "deletes not buffered until target arrives" src/doc.ts \
  "s/    const ref = op.type === 'insert' ? op.origin : op.target;/    if (op.type === 'delete') return null;\n    const ref = op.origin;/"
mutate "no per-replica FIFO" src/doc.ts \
  's/    if ((this.#vv.get(replica) ?? 0) < previous) return/    if (false) return/'

echo "$survivors mutant(s) survived"
[ "$survivors" -eq 0 ]
