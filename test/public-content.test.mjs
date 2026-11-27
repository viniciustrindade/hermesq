import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const scanner = resolve('scripts/check-public-content.mjs');
const fixture = (content) => {
  const cwd = mkdtempSync(join(tmpdir(), 'public-content-'));
  execFileSync('git', ['init', '-q', cwd]);
  writeFileSync(join(cwd, 'public.md'), content);
  execFileSync('git', ['-C', cwd, 'add', 'public.md']);
  return cwd;
};
const check = (cwd, env = {}) => spawnSync(process.execPath, [scanner], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

// Samples are concatenated so this file does not match the patterns it tests.
const rejected = [
  ['absolute user home', '/home' + '/dev/workspace/repo'],
  ['private repository reference', 'squad' + '-alpha'],
  ['private repository reference', 'hermesq' + '-internal'],
  ['tailnet host', 'host.example.' + 'ts.net'],
  ['internal network label', 'alpha' + '-city'],
  ['non-example email', 'dev@internal' + '.test'],
  ['Slack channel link', 'https://acme.sla' + 'ck.com/archives/C0123'],
];

for (const [name, sample] of rejected) {
  test(`public content gate rejects ${name}: ${sample}`, () => {
    const result = check(fixture(`see ${sample}\n`));
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `public.md: ${name}\n`);
  });
}

test('public content gate accepts git SSH remotes, example addresses and GitHub noreply', () => {
  const result = check(fixture([
    'git@github.com:example-org/repo.git', 'dev@example.com', 'bot@users.noreply.github.com',
    'https://github.com/example-org/repo', 'https://example.com/archives/1',
  ].join('\n')));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('public content gate checks custom host patterns without storing host names in the repo', () => {
  const cwd = fixture('test-host-lab\n');
  writeFileSync(join(cwd, 'patterns.json'), JSON.stringify([{ name: 'host', regex: 'test-host-lab' }]));
  assert.equal(check(cwd).status, 0);
  const result = check(cwd, { HERMESQ_PUBLIC_PATTERNS_FILE: join(cwd, 'patterns.json') });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'public.md: host\n');
});
