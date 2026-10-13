#!/usr/bin/env bash
# Download the real-world editing traces used by the CRDT benchmarks into bench/traces/ (gitignored).
#
# Source: https://github.com/josephg/editing-traces (sequential_traces/ascii_only). The ASCII-only
# variants are used so the traces' code-point positions equal this CRDT's UTF-16 indices.
#   - automerge-paper: Martin Kleppmann typing an academic paper (from automerge-perf).
#   - seph-blog1: Joseph Gentle writing a blog post; CC BY 4.0.
set -euo pipefail
dir="$(dirname "$0")/traces"
mkdir -p "$dir"
base=https://raw.githubusercontent.com/josephg/editing-traces/master/sequential_traces/ascii_only
for name in automerge-paper seph-blog1; do
  if [ ! -f "$dir/$name.json.gz" ]; then
    echo "fetching $name"
    curl -fsSL -o "$dir/$name.json.gz" "$base/$name.json.gz"
  fi
done
