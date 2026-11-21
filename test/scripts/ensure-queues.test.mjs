import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { missingCredentials, parseJsonc, queueNames } from '../../scripts/ensure-queues.mjs';

const SCRIPT = new URL('../../scripts/ensure-queues.mjs', import.meta.url).pathname;
const ROOT = new URL('../../', import.meta.url).pathname;
const config = () => parseJsonc(readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8'));
const FAKE_TOKEN = 'fake-token-value-0123456789';
const FAKE_ACCOUNT = 'fake-account-id-9876543210';

// The CD used to fail five times with a per-queue wrangler error when the Cloudflare credentials were not set.
// The script now refuses once, before any wrangler call, and names the missing variable (never a value).
describe('missingCredentials', () => {
  it('names only what is empty, undefined or blank', () => {
    expect(missingCredentials({})).toEqual(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
    expect(missingCredentials({ CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '   ' })).toEqual(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
    expect(missingCredentials({ CLOUDFLARE_API_TOKEN: FAKE_TOKEN })).toEqual(['CLOUDFLARE_ACCOUNT_ID']);
    expect(missingCredentials({ CLOUDFLARE_ACCOUNT_ID: FAKE_ACCOUNT })).toEqual(['CLOUDFLARE_API_TOKEN']);
    expect(missingCredentials({ CLOUDFLARE_API_TOKEN: FAKE_TOKEN, CLOUDFLARE_ACCOUNT_ID: FAKE_ACCOUNT })).toEqual([]);
  });
});

// A PATH with no executables proves wrangler (npx) is never spawned when the credentials are missing.
const run = (args, env) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { PATH: mkdtempSync(join(tmpdir(), 'empty-path-')), ...env }, encoding: 'utf8' });

describe('ensure-queues CLI without credentials', () => {
  it('queue creation stops at once with one message naming both variables and the environment', () => {
    const result = run(['staging'], {});
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    const lines = result.stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('CLOUDFLARE_API_TOKEN');
    expect(lines[0]).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(lines[0]).toContain('"staging"');
    expect(result.stderr).not.toContain('FAILED');
  });

  it('names only the variable that is missing and never prints a value', () => {
    const result = run(['staging'], { CLOUDFLARE_API_TOKEN: FAKE_TOKEN });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(result.stderr).not.toContain('CLOUDFLARE_API_TOKEN');
    expect(result.stderr).not.toContain(FAKE_TOKEN);
  });

  it('--check-credentials: exit 2 with the same message, exit 0 and silent when both are set', () => {
    const missing = run(['--check-credentials', 'production'], { CLOUDFLARE_ACCOUNT_ID: FAKE_ACCOUNT });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('CLOUDFLARE_API_TOKEN');
    expect(missing.stderr).toContain('"production"');
    expect(missing.stderr).not.toContain(FAKE_ACCOUNT);
    const ok = run(['--check-credentials', 'staging'], { CLOUDFLARE_API_TOKEN: FAKE_TOKEN, CLOUDFLARE_ACCOUNT_ID: FAKE_ACCOUNT });
    expect(ok.status).toBe(0);
    expect(`${ok.stdout}${ok.stderr}`).toBe('');
  });

  it('--list still needs no credentials and prints the names from wrangler.jsonc', () => {
    const result = run(['--list', 'staging'], {});
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(queueNames(config(), 'staging'));
  });
});

// The names the script creates come from the wrangler config, so the expectations are derived from it too.
describe('staging queues declared in wrangler.jsonc', () => {
  it('are the production queues with the -staging suffix, each with a producer and a consumer', () => {
    const production = queueNames(config(), 'production');
    const staging = queueNames(config(), 'staging');
    expect(staging.length).toBeGreaterThan(0);
    expect([...staging].sort()).toEqual(production.map((name) => `${name}-staging`).sort());
    const block = config().env.staging.queues;
    const producers = block.producers.map((entry) => entry.queue).sort();
    const consumers = block.consumers.map((entry) => entry.queue).sort();
    expect(producers).toEqual([...staging].sort());
    expect(consumers).toEqual([...staging].sort());
  });
});

// The internal repository silenced this finding with a commit-specific .gitleaksignore entry; the public
// history is different, so the allowlist in .gitleaks.toml has to cover it by path and by value.
describe('.gitleaks.toml', () => {
  it('allowlists the public Slack signing example in the provider fixtures', () => {
    const toml = readFileSync(new URL('../../.gitleaks.toml', import.meta.url), 'utf8');
    const fixtures = readFileSync(new URL('../fixtures/providers.ts', import.meta.url), 'utf8');
    const pathRegex = /paths = \['''(.+?)'''\]/.exec(toml)?.[1];
    const valueRegex = /regexes = \['''(.+?)'''\]/.exec(toml)?.[1];
    expect(pathRegex && new RegExp(pathRegex).test('test/fixtures/providers.ts')).toBe(true);
    expect(valueRegex && new RegExp(valueRegex).test(fixtures)).toBe(true);
    expect(toml).toContain('useDefault = true');
  });
});

describe('README Deploy section', () => {
  it('lists by name the two secrets and the variable of the staging environment, the token permissions and the isolation warning', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const section = readme.split(/^## /m).find((part) => part.startsWith('Deploy'));
    expect(section).toBeDefined();
    for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'WORKER_URL', 'staging', 'Workers', 'Queues', 'KV', 'D1']) expect(section).toContain(name);
    expect(section).toMatch(/does not isolate staging/i);
  });
});
