import { NewDocument } from '../components/NewDocument';

export default function Home() {
  return (
    <main className="home">
      <h1>collab</h1>
      <p>
        A real-time collaborative editor built on a from-scratch RGA sequence CRDT. Edits merge
        without locks, work offline, and every replica converges.
      </p>
      <NewDocument />
    </main>
  );
}
