/** Minimal Prometheus-style metrics: counters, gauges and a latency histogram, no dependencies. */
export class Metrics {
  readonly #counters = new Map<string, number>();
  readonly #gauges = new Map<string, () => number>();
  readonly #histograms = new Map<string, Histogram>();

  inc(name: string, by = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  gauge(name: string, read: () => number): void {
    this.#gauges.set(name, read);
  }

  observe(name: string, valueMs: number): void {
    let h = this.#histograms.get(name);
    if (!h) this.#histograms.set(name, (h = new Histogram()));
    h.observe(valueMs);
  }

  counter(name: string): number {
    return this.#counters.get(name) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, value] of this.#counters)
      lines.push(`# TYPE ${name} counter`, `${name} ${String(value)}`);
    for (const [name, read] of this.#gauges)
      lines.push(`# TYPE ${name} gauge`, `${name} ${String(read())}`);
    for (const [name, h] of this.#histograms) lines.push(...h.render(name));
    return `${lines.join('\n')}\n`;
  }
}

const BUCKETS_MS = [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

class Histogram {
  readonly #counts = BUCKETS_MS.map(() => 0);
  #sum = 0;
  #count = 0;

  observe(value: number): void {
    this.#sum += value;
    this.#count++;
    const i = BUCKETS_MS.findIndex((b) => value <= b);
    if (i >= 0) this.#counts[i] = (this.#counts[i] ?? 0) + 1;
  }

  render(name: string): string[] {
    const lines = [`# TYPE ${name} histogram`];
    let cumulative = 0;
    BUCKETS_MS.forEach((b, i) => {
      cumulative += this.#counts[i] ?? 0;
      lines.push(`${name}_bucket{le="${String(b)}"} ${String(cumulative)}`);
    });
    lines.push(`${name}_bucket{le="+Inf"} ${String(this.#count)}`);
    lines.push(`${name}_sum ${String(this.#sum)}`, `${name}_count ${String(this.#count)}`);
    return lines;
  }
}
