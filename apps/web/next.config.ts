import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@collab/client', '@collab/crdt', '@collab/protocol'],
  reactStrictMode: true,
};

export default config;
