import { Doc } from '@collab/crdt';
import { describe, expect, it } from 'vitest';
import {
  encode,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  ProtocolError,
  type ClientMessage,
} from '../src/index.ts';

const hello: ClientMessage = {
  type: 'hello',
  protocol: PROTOCOL_VERSION,
  doc: 'design-doc',
  replica: 'abc123',
  owns: ['old-session'],
  user: { name: 'Ada', color: '#e5484d' },
  vv: { abc123: 0, other: 4 },
};

describe('client messages', () => {
  it('round-trip hello, ops and presence', () => {
    expect(parseClientMessage(encode(hello))).toEqual(hello);
    const doc = new Doc('abc123');
    const ops = doc.insert(0, 'hi');
    expect(parseClientMessage(encode({ type: 'ops', ops, trace: 12.5 }))).toEqual({
      type: 'ops',
      ops,
      trace: 12.5,
    });
    const cursor = { anchor: doc.anchorAt(1), head: doc.anchorAt(0) };
    expect(parseClientMessage(encode({ type: 'presence', cursor }))).toEqual({
      type: 'presence',
      cursor,
    });
  });

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['unknown type', '{"type":"nope"}'],
    ['wrong protocol', encode({ ...hello, protocol: 99 })],
    ['reserved server replica', encode({ ...hello, replica: '_server' })],
    ['bad doc id', encode({ ...hello, doc: '../etc' })],
    ['bad color', encode({ ...hello, user: { name: 'x', color: 'red' } })],
    ['negative vv', encode({ ...hello, vv: { a: -1 } })],
    ['malformed op', '{"type":"ops","ops":[{"type":"insert"}]}'],
    ['non-numeric trace', '{"type":"ops","ops":[],"trace":"x"}'],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseClientMessage(raw)).toThrow(ProtocolError);
  });

  it('strips unknown fields', () => {
    const raw = JSON.stringify({ ...hello, admin: true });
    expect(parseClientMessage(raw)).not.toHaveProperty('admin');
  });
});

describe('server messages', () => {
  it('round-trip welcome with a snapshot', () => {
    const doc = new Doc('a');
    doc.insert(0, 'hello');
    const welcome = {
      type: 'welcome' as const,
      vv: doc.versionVector(),
      snapshot: doc.toSnapshot(),
      ops: [],
      peers: [{ replica: 'b', user: { name: 'Bo', color: '#000000' }, cursor: null }],
    };
    expect(parseServerMessage(encode(welcome))).toEqual(welcome);
  });
});
