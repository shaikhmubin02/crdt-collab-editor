import { defineConfig } from '@playwright/test';

const SYNC_PORT = 18787;
const WEB_PORT = 3100;

/**
 * Browser end-to-end tests: a real sync server (in-memory storage) and a production build of the
 * web app, driven through Chromium.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${String(WEB_PORT)}`, trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'node apps/server/src/main.ts',
      env: { PORT: String(SYNC_PORT), HOST: '127.0.0.1', LOG_LEVEL: 'warn', DATABASE_URL: '' },
      url: `http://127.0.0.1:${String(SYNC_PORT)}/healthz`,
      reuseExistingServer: false,
    },
    {
      command: `pnpm --filter @collab/web build && pnpm --filter @collab/web exec next start --port ${String(WEB_PORT)} --hostname 127.0.0.1`,
      env: {
        NEXT_PUBLIC_SYNC_URL: `ws://127.0.0.1:${String(SYNC_PORT)}/sync`,
        NEXT_TELEMETRY_DISABLED: '1',
      },
      url: `http://127.0.0.1:${String(WEB_PORT)}`,
      timeout: 300_000,
      reuseExistingServer: false,
    },
  ],
});
