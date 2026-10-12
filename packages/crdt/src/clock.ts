/**
 * Lamport logical clock. Guarantees: if event A could have influenced event B (B's replica had
 * seen A when it created B), then clock(A) < clock(B).
 */
export class LamportClock {
  #time: number;

  constructor(time = 0) {
    assertClockValue(time);
    this.#time = time;
  }

  /** The highest clock value issued or observed so far. */
  get time(): number {
    return this.#time;
  }

  /** Advance the clock for a new local event and return its timestamp. */
  tick(): number {
    const next = this.#time + 1;
    assertClockValue(next);
    this.#time = next;
    return next;
  }

  /**
   * Merge in a timestamp seen on a remote event, so that every later local event is ordered after
   * it. Throws RangeError (leaving the clock unchanged) for invalid values.
   */
  observe(remote: number): void {
    assertClockValue(remote);
    if (remote > this.#time) this.#time = remote;
  }
}

/** Clock values are non-negative safe integers. Throws RangeError otherwise. */
export function assertClockValue(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`invalid clock value: ${String(value)}`);
  }
}
