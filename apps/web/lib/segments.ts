import type { PeerView } from '@collab/client';

export interface Caret {
  readonly name: string;
  readonly color: string;
}

export interface Segment {
  readonly text: string;
  /** Colors of the remote selections covering this text. */
  readonly highlights: readonly string[];
  /** Remote carets positioned right before this segment's text. */
  readonly carets: readonly Caret[];
}

/**
 * Split `text` into runs with uniform remote-selection coverage, with carets at peers' heads.
 * Rendered in a backdrop layer under a transparent textarea using identical font metrics, so
 * highlights and carets line up with the real text without any pixel measurement.
 */
export function buildSegments(text: string, peers: readonly PeerView[]): Segment[] {
  const clamp = (i: number) => Math.max(0, Math.min(text.length, i));
  const ranges: { start: number; end: number; color: string }[] = [];
  const caretsAt = new Map<number, Caret[]>();
  const cuts = new Set<number>([0, text.length]);
  for (const peer of peers) {
    if (!peer.selection) continue;
    const a = clamp(peer.selection.anchor);
    const h = clamp(peer.selection.head);
    const start = Math.min(a, h);
    const end = Math.max(a, h);
    if (end > start) ranges.push({ start, end, color: peer.user.color });
    cuts.add(start).add(end).add(h);
    const list = caretsAt.get(h) ?? [];
    list.push({ name: peer.user.name, color: peer.user.color });
    caretsAt.set(h, list);
  }
  const points = [...cuts].sort((x, y) => x - y);
  const segments: Segment[] = [];
  for (let i = 0; i < points.length; i++) {
    const start = points[i] ?? 0;
    const end = points[i + 1] ?? start;
    const carets = caretsAt.get(start) ?? [];
    if (end === start && carets.length === 0) continue;
    segments.push({
      text: text.slice(start, end),
      highlights: ranges
        .filter((r) => r.start <= start && end <= r.end && end > start)
        .map((r) => r.color),
      carets,
    });
  }
  return segments;
}
