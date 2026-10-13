import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@collab/client', '@collab/crdt', '@collab/protocol'],
  reactStrictMode: true,
  // Self-contained server bundle for the Docker image (apps/web/Dockerfile).
  ...(process.env.NEXT_STANDALONE === '1'
    ? { output: 'standalone', outputFileTracingRoot: path.join(import.meta.dirname, '../..') }
    : {}),
};

export default config;
