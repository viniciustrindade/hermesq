import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { GITHUB_VECTOR, SLACK_VECTOR, STRIPE_VECTOR } from './test/fixtures/providers.ts';

export default defineConfig({
  test: {
    projects: [
      {
        // Unit tests run inside workerd (miniflare) with real KV, D1, Queues and Durable Object bindings.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc', environment: '' },
            miniflare: {
              bindings: {
                ADMIN_TOKEN: 'test-admin-token',
                GITHUB_WEBHOOK_SECRET: GITHUB_VECTOR.secret,
                STRIPE_WEBHOOK_SECRET: STRIPE_VECTOR.secret,
                SLACK_SIGNING_SECRET: SLACK_VECTOR.secret,
                // LINEAR_WEBHOOK_SECRET and HERMES_WEBHOOK_SECRET are left out on purpose: tests store them
                // through /setup so the Durable Object secret path is exercised.
                HERMES_LONG_POLL_MS: '5000',
                HERMES_LEASE_SECONDS: '300',
                MAX_ATTEMPTS: '3',
              },
            },
          }),
        ],
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          testTimeout: 20_000,
        },
      },
      {
        // Scripts that run in Node (CD helpers): plain Node, no Worker bindings.
        test: {
          name: 'scripts',
          include: ['test/scripts/**/*.test.mjs'],
          environment: 'node',
        },
      },
      {
        // Integration tests run in Node against a real `wrangler dev --local` (started by global-setup.ts)
        // and a scripted OAuth provider on localhost.
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/integration/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
