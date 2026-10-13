// Library entry point (for embedding the server, e.g. in end-to-end tests). `main.ts` is the
// process entry point.
export { startServer, type ServerOptions, type SyncServer } from './server.ts';
export { MemoryStore } from './store/memory.ts';
export { PostgresStore } from './store/postgres.ts';
export type { DocStore } from './store/store.ts';
