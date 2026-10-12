import { describe, expect, it } from 'vitest';
import { LamportClock } from '../src/clock.ts';

describe('LamportClock', () => {
  it('starts at 0 and ticks to 1, 2, 3', () => {
    const c = new LamportClock();
    expect(c.time).toBe(0);
    expect([c.tick(), c.tick(), c.tick()]).toEqual([1, 2, 3]);
    expect(c.time).toBe(3);
  });

  it('orders local events after any observed remote event', () => {
    const c = new LamportClock();
    c.tick();
    c.observe(10);
    expect(c.tick()).toBe(11);
  });

  it('never moves backwards when observing an older timestamp', () => {
    const c = new LamportClock(5);
    c.observe(2);
    expect(c.time).toBe(5);
    expect(c.tick()).toBe(6);
  });

  it('observing its own current time is a no-op', () => {
    const c = new LamportClock(5);
    c.observe(5);
    expect(c.tick()).toBe(6);
  });

  it('rejects invalid remote timestamps', () => {
    const c = new LamportClock();
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => {
        c.observe(bad);
      }).toThrow(RangeError);
    }
    expect(c.time).toBe(0);
  });

  it('rejects an invalid starting time', () => {
    expect(() => new LamportClock(-1)).toThrow(RangeError);
  });
});
