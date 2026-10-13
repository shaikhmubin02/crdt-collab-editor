'use client';

import { IndexedDbStorage, SyncClient, type PeerView, type Status } from '@collab/client';
import type { Id } from '@collab/crdt';
import type { User } from '@collab/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadUser, saveUser, syncUrl } from '../lib/identity';
import { buildSegments } from '../lib/segments';
import { diffText } from '../lib/text-diff';

/**
 * A plain textarea bound to a CRDT replica.
 *
 * Local input is diffed against the replica's text and turned into CRDT ops. Remote changes
 * replace the textarea's value; the local selection is kept as CRDT anchors (element IDs), not
 * indices, so it stays put when others type before it. Remote selections render in a backdrop
 * layer behind the transparent textarea.
 */
export function Editor({ docId }: { docId: string }) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const clientRef = useRef<SyncClient | null>(null);
  const selection = useRef<{ start: Id; end: Id } | null>(null);
  const composing = useRef(false);
  const remoteWhileComposing = useRef(false);

  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>('connecting');
  const [unsynced, setUnsynced] = useState(0);
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [simulatedOffline, setSimulatedOffline] = useState(false);

  /** Remember the selection as anchors and publish it as presence. */
  const captureSelection = useCallback(() => {
    const client = clientRef.current;
    const el = textarea.current;
    if (!client || !el) return;
    const start = Math.min(el.selectionStart, client.length);
    const end = Math.min(el.selectionEnd, client.length);
    selection.current = { start: client.anchorAt(start), end: client.anchorAt(end) };
    const backward = el.selectionDirection === 'backward';
    client.setSelection(backward ? end : start, backward ? start : end);
  }, []);

  const renderRemote = useCallback(() => {
    const client = clientRef.current;
    const el = textarea.current;
    if (!client || !el) return;
    if (composing.current) {
      // Replacing the value mid-composition would break the IME; catch up when it ends.
      remoteWhileComposing.current = true;
      return;
    }
    const value = client.text;
    if (el.value !== value) {
      const focused = document.activeElement === el;
      const sel = selection.current;
      const { scrollTop } = el;
      el.value = value;
      if (sel && focused) {
        const start = client.indexOfAnchor(sel.start) ?? 0;
        const end = client.indexOfAnchor(sel.end) ?? start;
        el.setSelectionRange(start, Math.max(start, end));
      }
      el.scrollTop = scrollTop;
    }
    setText(value);
    setPeers(client.peers());
  }, []);

  useEffect(() => {
    const me = loadUser();
    let disposed = false;
    let opened: SyncClient | null = null;
    const unsubscribe: (() => void)[] = [];

    void SyncClient.open({ url: syncUrl(), docId, user: me, storage: new IndexedDbStorage() }).then(
      (client) => {
        if (disposed) {
          void client.close();
          return;
        }
        opened = client;
        clientRef.current = client;
        setUser(me);
        if (textarea.current) textarea.current.value = client.text;
        setText(client.text);
        setStatus(client.status);
        setUnsynced(client.unsyncedCount);
        setReady(true);
        unsubscribe.push(
          client.on('change', (e) => {
            setUnsynced(client.unsyncedCount);
            if (e.remote) renderRemote();
            else setText(client.text);
          }),
          client.on('status', (s) => {
            setStatus(s);
            setUnsynced(client.unsyncedCount);
          }),
          client.on('presence', () => {
            setPeers(client.peers());
          }),
        );
      },
    );
    const flush = () => {
      void opened?.flushStorage();
    };
    window.addEventListener('pagehide', flush);
    return () => {
      disposed = true;
      window.removeEventListener('pagehide', flush);
      for (const off of unsubscribe) off();
      clientRef.current = null;
      void opened?.close();
    };
  }, [docId, renderRemote]);

  /** Turn whatever the input event did to the textarea into CRDT ops. */
  const syncLocal = useCallback(() => {
    const client = clientRef.current;
    const el = textarea.current;
    if (!client || !el) return;
    const edit = diffText(client.text, el.value, el.selectionEnd);
    if (edit.deleteCount > 0) client.delete(edit.index, edit.deleteCount);
    if (edit.insert.length > 0) client.insert(edit.index, edit.insert);
    captureSelection();
  }, [captureSelection]);

  const segments = useMemo(() => buildSegments(text, peers), [text, peers]);
  const syncScroll = () => {
    if (backdrop.current && textarea.current)
      backdrop.current.scrollTop = textarea.current.scrollTop;
  };

  const toggleOffline = () => {
    const client = clientRef.current;
    if (!client) return;
    if (simulatedOffline) client.goOnline();
    else client.goOffline();
    setSimulatedOffline(!simulatedOffline);
  };

  const rename = (name: string) => {
    if (!user || name.trim().length === 0) return;
    const next = { ...user, name: name.slice(0, 64) };
    setUser(next);
    saveUser(next);
  };

  return (
    <div className="editor-page">
      <header className="toolbar">
        <a href="/" className="brand">
          collab
        </a>
        <span className="doc-id" title="Share this URL to collaborate">
          {docId}
        </span>
        <StatusPill status={status} unsynced={unsynced} />
        <button type="button" className="ghost" onClick={toggleOffline} disabled={!ready}>
          {simulatedOffline ? 'Go online' : 'Simulate offline'}
        </button>
        <div className="presence" aria-label="People in this document">
          {user && (
            <input
              className="me"
              style={{ borderColor: user.color }}
              defaultValue={user.name}
              aria-label="Your display name (applies on reload)"
              onBlur={(e) => {
                rename(e.target.value);
              }}
            />
          )}
          {peers.map((p) => (
            <span
              key={p.replica}
              className="avatar"
              style={{ background: p.user.color }}
              title={p.user.name}
            >
              {p.user.name.slice(0, 1)}
            </span>
          ))}
        </div>
      </header>

      <div className="surface">
        <div ref={backdrop} className="backdrop" aria-hidden="true">
          {segments.map((s, i) => (
            <span key={i}>
              {s.carets.map((c) => (
                <span key={c.name} className="caret" style={{ borderColor: c.color }}>
                  <span className="caret-label" style={{ background: c.color }}>
                    {c.name}
                  </span>
                </span>
              ))}
              {s.highlights.length > 0 ? (
                <mark style={{ background: `${s.highlights[0] ?? '#888888'}33` }}>{s.text}</mark>
              ) : (
                s.text
              )}
            </span>
          ))}
          {'​'}
        </div>
        <textarea
          ref={textarea}
          className="text"
          spellCheck={false}
          disabled={!ready}
          placeholder={
            ready ? 'Start typing. Open this URL in another window to collaborate.' : 'Loading…'
          }
          onInput={() => {
            if (!composing.current) syncLocal();
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
            syncLocal();
            if (remoteWhileComposing.current) {
              remoteWhileComposing.current = false;
              renderRemote();
            }
          }}
          onSelect={captureSelection}
          onKeyUp={captureSelection}
          onMouseUp={captureSelection}
          onScroll={syncScroll}
        />
      </div>
    </div>
  );
}

function StatusPill({ status, unsynced }: { status: Status; unsynced: number }) {
  const label =
    status === 'online'
      ? unsynced > 0
        ? `Syncing ${String(unsynced)}…`
        : 'Saved'
      : status === 'connecting'
        ? 'Connecting…'
        : `Offline${unsynced > 0 ? ` · ${String(unsynced)} unsynced` : ''}`;
  return (
    <span className={`status status-${status}`} role="status" data-testid="status">
      {label}
    </span>
  );
}
