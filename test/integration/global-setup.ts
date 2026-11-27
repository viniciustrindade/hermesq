import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { startMockProvider } from './mock-provider.ts';

/**
 * Starts the scripted OAuth provider and `wrangler dev --local` with a throwaway state directory.
 * Every value below is a local test value; nothing reaches Cloudflare.
 */
export const WORKER_PORT = Number(process.env.IT_WORKER_PORT ?? 8787);
export const PROVIDER_PORT = Number(process.env.IT_PROVIDER_PORT ?? 8788);

export default async function setup(project: TestProject) {
  const provider = await startMockProvider(PROVIDER_PORT);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'wt-it-'));
  const base = `http://127.0.0.1:${PROVIDER_PORT}/linear`;
  const vars: Record<string, string> = {
    ADMIN_TOKEN: 'it-admin-token',
    HERMES_WEBHOOK_SECRET: 'it-hermes-secret',
    LINEAR_WEBHOOK_SECRET: 'it-linear-secret',
    LINEAR_WEBHOOK_SECRET_WORKER_A: 'it-worker-a-app-secret',
    LINEAR_TEAM_KEYS: 'abc',
    GITHUB_WEBHOOK_SECRET: 'it-github-secret',
    STRIPE_WEBHOOK_SECRET: 'it-stripe-secret',
    SLACK_SIGNING_SECRET: 'it-slack-secret',
    PUBLIC_URL: `http://127.0.0.1:${WORKER_PORT}`,
    OAUTH_PROVIDER_OVERRIDES: JSON.stringify({ linear: { authorizeUrl: `${base}/authorize`, tokenUrl: `${base}/token`, revokeUrl: `${base}/revoke` } }),
  };
  const envFile = join(dir, 'it.env');
  writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}='${v}'`).join('\n') + '\n');

  const worker: ChildProcess = spawn(
    'npx',
    ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(WORKER_PORT), '--persist-to', join(dir, 'state'), '--env-file', envFile, '--test-scheduled', '--show-interactive-dev-session=false', '--log-level', 'warn'],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } },
  );
  let log = '';
  worker.stdout?.on('data', (d) => (log += d));
  worker.stderr?.on('data', (d) => (log += d));

  const url = `http://127.0.0.1:${WORKER_PORT}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (worker.exitCode !== null || Date.now() > deadline) {
      throw new Error(`wrangler dev did not start (exit ${worker.exitCode}):\n${log.slice(-4000)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  project.provide('workerUrl', url);
  project.provide('providerUrl', `http://127.0.0.1:${PROVIDER_PORT}`);
  project.provide('vars', vars);

  return async () => {
    if (worker.pid) {
      try {
        process.kill(-worker.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    await new Promise<void>((r) => provider.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
    if (process.env.IT_SHOW_WORKER_LOG) console.log(log);
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    workerUrl: string;
    providerUrl: string;
    vars: Record<string, string>;
  }
}
