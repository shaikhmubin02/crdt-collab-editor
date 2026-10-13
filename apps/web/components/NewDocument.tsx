'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function NewDocument() {
  const router = useRouter();
  const [existing, setExisting] = useState('');
  const create = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const id = Array.from(bytes, (b) => b.toString(36).padStart(2, '0'))
      .join('')
      .slice(0, 12);
    router.push(`/d/${id}`);
  };
  return (
    <div className="actions">
      <button type="button" onClick={create}>
        New document
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const id = existing.trim();
          if (/^[A-Za-z0-9_-]{1,128}$/.test(id)) router.push(`/d/${id}`);
        }}
      >
        <input
          value={existing}
          onChange={(e) => {
            setExisting(e.target.value);
          }}
          placeholder="or open a document ID"
          aria-label="Document ID"
        />
      </form>
    </div>
  );
}
