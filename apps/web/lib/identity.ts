import type { User } from '@collab/protocol';

const KEY = 'collab:user';
const ADJECTIVES = ['Swift', 'Quiet', 'Bright', 'Clever', 'Brave', 'Calm', 'Lucky', 'Bold'];
const ANIMALS = ['Otter', 'Falcon', 'Lynx', 'Heron', 'Panda', 'Fox', 'Koala', 'Orca'];
/** Distinguishable on light and dark backgrounds. */
export const COLORS = [
  '#e5484d',
  '#0090ff',
  '#30a46c',
  '#f76b15',
  '#8e4ec6',
  '#d6409f',
  '#12a594',
  '#ab6400',
];

function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(Math.random() * items.length)];
  if (item === undefined) throw new Error('empty list');
  return item;
}

/** The local user's display identity, persisted per browser. */
export function loadUser(): User {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<User>;
      if (typeof parsed.name === 'string' && typeof parsed.color === 'string') {
        return { name: parsed.name, color: parsed.color };
      }
    }
  } catch {
    // Storage unavailable (private mode): fall through to a session-only identity.
  }
  const user = { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(COLORS) };
  saveUser(user);
  return user;
}

export function saveUser(user: User): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(user));
  } catch {
    // Best effort.
  }
}

/** Sync server WebSocket URL: NEXT_PUBLIC_SYNC_URL, else the page's host on port 8787. */
export function syncUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SYNC_URL;
  if (configured) return configured;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.hostname}:8787/sync`;
}
