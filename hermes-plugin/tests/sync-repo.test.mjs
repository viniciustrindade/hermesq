import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { syncRepo } from '../sync-repo.ts';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' } }).trim();
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sync-repo-'));
  const root = join(dir, 'workspace', 'example-org');
  mkdirSync(root, { recursive: true });
  const bare = join(dir, 'upstream.git');
  git(dir, 'init', '--bare', bare);
  const sender = join(dir, 'sender');
  git(dir, 'clone', bare, sender);
  git(sender, 'checkout', '-b', 'main');
  writeFileSync(join(sender, 'file'), 'one\n');
  git(sender, 'add', '.'); git(sender, 'commit', '-m', 'one'); git(sender, 'push', '-u', 'origin', 'main');
  const clone = join(root, 'my-local-name');
  git(dir, 'clone', '-b', 'main', bare, clone);
  // Both SSH and HTTPS forms must identify the org repo by *raw origin*, not by directory name.
  git(clone, 'config', 'remote.origin.url', 'git@github.com:example-org/repo.git');
  git(clone, 'config', `url.${bare}.insteadOf`, 'git@github.com:example-org/repo.git');
  function push(value, branch = 'main') {
    git(sender, 'checkout', branch);
    writeFileSync(join(sender, 'file'), value);
    git(sender, 'add', '.'); git(sender, 'commit', '-m', value.trim()); git(sender, 'push', 'origin', branch);
  }
  const cards = [];
  const deps = { root, git, card: async (repo, branch, reason) => cards.push({ repo, branch, reason }), env: { HERMESQ_SYNC_ORG: 'example-org' } };
  const event = (branch = 'main', repo = 'repo') => ({ op: 'event', tags: [`source:github`, `repo:${repo}`, `ref:${branch}`], payload: { repository: { full_name: `example-org/${repo}` }, ref: `refs/heads/${branch}` } });
  return { root, clone, sender, push, deps, event, cards };
}

test('sync-repo: branch atrasada em clone encontrado por origin avança sem checkout ou reset; sucesso não cria cartão', async () => {
  const f = fixture(); f.push('two\n');
  await syncRepo(f.event(), f.deps);
  assert.equal(readFileSync(join(f.clone, 'file'), 'utf8'), 'two\n');
  assert.equal(git(f.clone, 'branch', '--show-current'), 'main');
  assert.deepEqual(f.cards, []);
});

test('sync-repo: clone sujo não altera nada e abre um cartão; branch divergida também', async () => {
  const f = fixture(); f.push('two\n'); writeFileSync(join(f.clone, 'file'), 'dirty\n');
  await syncRepo(f.event(), f.deps);
  assert.equal(readFileSync(join(f.clone, 'file'), 'utf8'), 'dirty\n');
  assert.equal(f.cards.length, 1);
  git(f.clone, 'add', '.'); git(f.clone, 'commit', '-m', 'local');
  await syncRepo(f.event(), f.deps);
  assert.equal(readFileSync(join(f.clone, 'file'), 'utf8'), 'dirty\n');
  assert.equal(f.cards.length, 2);
});

test('sync-repo: clone local à frente do origin não cria cartão nem descarta commits', async () => {
  const f = fixture();
  writeFileSync(join(f.clone, 'file'), 'local only\n');
  git(f.clone, 'add', '.'); git(f.clone, 'commit', '-m', 'local only');
  const local = git(f.clone, 'rev-parse', 'main');
  await syncRepo(f.event(), f.deps);
  assert.equal(git(f.clone, 'rev-parse', 'main'), local);
  assert.equal(readFileSync(join(f.clone, 'file'), 'utf8'), 'local only\n');
  assert.deepEqual(f.cards, []);
});

test('sync-repo: outra branch só fetch; branch local ausente não é criada', async () => {
  const f = fixture(); f.push('two\n');
  await syncRepo(f.event('feature/x'), f.deps);
  assert.equal(readFileSync(join(f.clone, 'file'), 'utf8'), 'one\n');
  assert.equal(git(f.clone, 'rev-parse', 'refs/remotes/origin/main'), git(f.sender, 'rev-parse', 'main'));
  assert.deepEqual(f.cards, []);
});

test('sync-repo: feature local existente e atrasada NÃO avança, somente fetch', async () => {
  const f = fixture();
  git(f.sender, 'checkout', '-b', 'feature/x');
  f.push('feature one\n', 'feature/x');
  git(f.clone, 'fetch', 'origin');
  git(f.clone, 'branch', 'feature/x', 'origin/feature/x');
  const old = git(f.clone, 'rev-parse', 'feature/x');
  f.push('feature two\n', 'feature/x');
  await syncRepo(f.event('feature/x'), f.deps);
  assert.equal(git(f.clone, 'rev-parse', 'feature/x'), old);
  assert.equal(git(f.clone, 'rev-parse', 'origin/feature/x'), git(f.sender, 'rev-parse', 'feature/x'));
  assert.deepEqual(f.cards, []);
});

test('sync-repo: sem clone e repo de fora da org são ignorados, sem fetch nem cartão', async () => {
  const f = fixture(); f.push('two\n');
  await syncRepo(f.event('main', 'unknown'), f.deps);
  await syncRepo({ ...f.event(), payload: { repository: { full_name: 'other/repo' }, ref: 'refs/heads/main' } }, f.deps);
  assert.equal(readFileSync(join(f.clone, 'file'), 'utf8'), 'one\n');
  assert.deepEqual(f.cards, []);
});

test('sync-repo: branch main não ativa avança somente se limpa; origin HTTPS também casa', async () => {
  const f = fixture();
  git(f.clone, 'config', 'remote.origin.url', 'https://github.com/example-org/repo.git');
  git(f.clone, 'config', `url.${join(f.root, '..', '..', 'upstream.git')}.insteadOf`, 'https://github.com/example-org/repo.git');
  git(f.clone, 'checkout', '-b', 'other');
  f.push('two\n');
  await syncRepo(f.event(), f.deps);
  assert.equal(git(f.clone, 'branch', '--show-current'), 'other');
  assert.equal(readFileSync(join(f.clone, 'file'), 'utf8'), 'one\n');
  assert.equal(git(f.clone, 'rev-parse', 'main'), git(f.sender, 'rev-parse', 'main'));
  assert.deepEqual(f.cards, []);
});

test('sync-repo: falha de fetch vira cartão; ref com maiúscula não se perde', async () => {
  const f = fixture();
  const broken = { ...f.deps, git: async (cwd, ...args) => {
    if (args[0] === 'fetch') throw new Error('no access');
    return f.deps.git(cwd, ...args);
  } };
  await syncRepo(f.event(), broken);
  assert.deepEqual(f.cards, [{ repo: 'repo', branch: 'main', reason: 'fetch' }]);
  const uppercase = f.event('Feature/XYZ');
  uppercase.tags[2] = 'ref:feature/xyz';
  await syncRepo(uppercase, f.deps);
  assert.equal(git(f.clone, 'rev-parse', 'refs/remotes/origin/main'), git(f.sender, 'rev-parse', 'main'));
  assert.equal(f.cards.length, 1);
});

test('sync-repo: invoca hermes kanban create apenas na falha com chave idempotente e assignee configurado', async () => {
  const f = fixture(); f.push('two\n'); writeFileSync(join(f.clone, 'file'), 'dirty\n');
  const bin = join(f.root, 'bin'); mkdirSync(bin);
  const argsLog = join(f.root, 'args');
  writeFileSync(join(bin, 'hermes'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CARD_LOG"\ncat > "$BODY_LOG"\n', { mode: 0o755 });
  const keys = ['PATH', 'CARD_LOG', 'BODY_LOG', 'HERMESQ_SYNC_ROOT', 'HERMESQ_SYNC_ORG', 'HERMESQ_REPO_OWNERS'];
  const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, CARD_LOG: argsLog, BODY_LOG: join(f.root, 'body'), HERMESQ_SYNC_ROOT: f.root, HERMESQ_SYNC_ORG: 'example-org', HERMESQ_REPO_OWNERS: '*=worker-a' });
  try { await syncRepo(f.event()); }
  finally { for (const key of keys) { if (prev[key] === undefined) delete process.env[key]; else process.env[key] = prev[key]; } }
  const args = readFileSync(argsLog, 'utf8');
  assert.match(args, /--idempotency-key\nsync-repo-main\n/);
  assert.match(args, /--assignee\nworker-a\n/);
  assert.match(readFileSync(join(f.root, 'body'), 'utf8'), /example-org\/repo/);
});

test('sync-repo: missing org and root fail before fetching or creating a card', async () => {
  const f = fixture();
  await assert.rejects(syncRepo(f.event(), { ...f.deps, env: {} }), /HERMESQ_SYNC_ORG/);
  await assert.rejects(syncRepo(f.event(), { ...f.deps, root: '', env: { HERMESQ_SYNC_ORG: 'example-org' } }), /HERMESQ_SYNC_ROOT/);
  assert.deepEqual(f.cards, []);
});

test('sync-repo: fetch só recebe helper configurado, nunca GH_TOKEN ou helper pessoal', async () => {
  const f = fixture(); f.push('two\n');
  const bin = join(f.root, 'bin'); mkdirSync(bin);
  const helper = join(f.root, 'sync-helper.ts'); writeFileSync(helper, '// fake helper: local origin never invokes it\n');
  const log = join(f.root, 'git-args');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = "-c" ]; then printf '%s\\n' "$@" > "$ARGS_LOG"; printf '%s\\n' "\${GH_TOKEN:-absent}" > "$TOKEN_LOG"; fi\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const keys = ['PATH', 'HERMESQ_SYNC_ROOT', 'HERMESQ_SYNC_ORG', 'HERMESQ_SYNC_CREDENTIAL_HELPER', 'GH_TOKEN', 'ARGS_LOG', 'TOKEN_LOG'];
  const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, HERMESQ_SYNC_ROOT: f.root, HERMESQ_SYNC_ORG: 'example-org', HERMESQ_SYNC_CREDENTIAL_HELPER: helper, GH_TOKEN: 'fake-personal-token', ARGS_LOG: log, TOKEN_LOG: join(f.root, 'token') });
  try { await syncRepo(f.event()); }
  finally { for (const key of keys) { if (prev[key] === undefined) delete process.env[key]; else process.env[key] = prev[key]; } }
  assert.match(readFileSync(log, 'utf8'), /credential.helper=\n/);
  assert.match(readFileSync(log, 'utf8'), /credential.helper=!node .*sync-helper.ts\n/);
  assert.equal(readFileSync(join(f.root, 'token'), 'utf8'), 'absent\n');
  assert.equal(readFileSync(join(f.clone, 'file'), 'utf8'), 'two\n');
});

test('sync-repo: repo with no owner entry and no `*` is a loud error, not a silent card failure', async () => {
  const f = fixture(); f.push('two\n'); writeFileSync(join(f.clone, 'file'), 'dirty\n');
  const keys = ['HERMESQ_SYNC_ROOT', 'HERMESQ_SYNC_ORG', 'HERMESQ_REPO_OWNERS'];
  const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { HERMESQ_SYNC_ROOT: f.root, HERMESQ_SYNC_ORG: 'example-org', HERMESQ_REPO_OWNERS: 'other=worker-a' });
  try { await assert.rejects(syncRepo(f.event()), /HERMESQ_REPO_OWNERS/); }
  finally { for (const key of keys) { if (prev[key] === undefined) delete process.env[key]; else process.env[key] = prev[key]; } }
});

test('sync-repo CLI: missing HERMESQ_SYNC_ORG exits 1 with one stderr line naming it and prints no [SILENT]', () => {
  const script = join(import.meta.dirname, '..', 'sync-repo.ts');
  const env = { ...process.env, HERMESQ_SYNC_ROOT: tmpdir() };
  delete env.HERMESQ_SYNC_ORG;
  const run = spawnSync('node', [script], { input: '{}', env, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stderr.trim().split('\n').length, 1);
  assert.match(run.stderr, /HERMESQ_SYNC_ORG/);
  assert.equal(run.stdout, '');
});
