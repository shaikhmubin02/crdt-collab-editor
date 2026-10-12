/**
 * Number of cases for the heavy property tests. CI sets FC_NUM_RUNS=10000; the local default keeps
 * the edit-test loop fast. `scale` shrinks the count for tests whose cases are much heavier.
 */
export function numRuns(localDefault: number, scale = 1): number {
  const fromEnv = Number(process.env.FC_NUM_RUNS);
  return Number.isSafeInteger(fromEnv) && fromEnv > 0
    ? Math.max(1, Math.round(fromEnv * scale))
    : localDefault;
}

/** Per-test timeout for the heavy property tests (vitest's default of 5s is too short at 10K runs). */
export const PROPERTY_TIMEOUT_MS = 600_000;
