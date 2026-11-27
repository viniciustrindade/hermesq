#!/usr/bin/env node
// HermesQ filterScript: fetch repository events without agent turns.
import { execFile, spawn } from 'node:child_process';
import { readdir, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const originPattern = (org: string) => new RegExp(`^(?:https://github\\.com/|git@github\\.com:|ssh://git@github\\.com/)(${org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[a-z0-9_.-]+?)(?:\\.git)?/?$`, 'i');
const BRANCH = /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/;
type Event = { tags?: unknown; payload?: unknown; source?: unknown };
type Deps = {
  root: string;
  env: NodeJS.ProcessEnv;
  git: (cwd: string, ...args: string[]) => string | Promise<string>;
  card: (repo: string, branch: string, reason: string) => Promise<void>;
};

function fields(event: Event, org: string): { repo: string; branch: string } | null {
  const tags = Array.isArray(event.tags) ? event.tags.filter((t): t is string => typeof t === 'string') : [];
  const repo = tags.find(t => t.startsWith('repo:'))?.slice('repo:'.length);
  const branch = tags.find(t => t.startsWith('ref:'))?.slice('ref:'.length);
  const payload = event.payload as { repository?: { full_name?: string }; ref?: string; deleted?: boolean } | undefined;
  const originalBranch = payload?.ref?.startsWith('refs/heads/') ? payload.ref.slice('refs/heads/'.length) : '';
  if (!tags.includes('source:github') || !repo || !/^[a-z0-9_.-]+$/i.test(repo) || !branch || payload?.deleted) return null;
  if (!BRANCH.test(originalBranch) || originalBranch.includes('..') || originalBranch.endsWith('/') || originalBranch.includes('//')) return null;
  if (payload?.repository?.full_name?.toLowerCase() !== `${org}/${repo}`.toLowerCase()) return null;
  if (originalBranch.toLowerCase() !== branch.toLowerCase()) return null;
  return { repo, branch: originalBranch };
}

function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_APP_ID', 'GH_APP_PEM_B64']) delete clean[key];
  return clean;
}
function helperArgs(env: NodeJS.ProcessEnv): string[] {
  const helper = env.HERMESQ_SYNC_CREDENTIAL_HELPER;
  if (!helper || !existsSync(helper)) return ['-c', 'credential.helper=']; // Never use a personal gh/keyring helper.
  if (!helper.startsWith('/') || !/^[\w./-]+$/.test(helper)) throw new Error('credential helper path invalid');
  return ['-c', 'credential.helper=', '-c', `credential.helper=!node ${helper}`];
}
function defaultGit(env: NodeJS.ProcessEnv) {
  return async (cwd: string, ...args: string[]): Promise<string> => {
    const { stdout } = await exec('git', [...helperArgs(env), '-c', 'http.extraHeader=', '-c', 'http.https://github.com/.extraHeader=', '-c', 'url.https://github.com/.insteadOf=git@github.com:', '-c', 'url.https://github.com/.insteadOf=ssh://git@github.com/', '-C', cwd, ...args], { env: gitEnv(env), timeout: 60_000 });
    return stdout.trim();
  };
}
function owner(repo: string, env: NodeJS.ProcessEnv): string {
  const entries = (env.HERMESQ_REPO_OWNERS ?? '').split(',').map(v => v.split('='));
  const name = entries.find(([r]) => r === repo)?.[1] ?? entries.find(([r]) => r === '*')?.[1];
  if (!name) throw new Error(`HERMESQ_REPO_OWNERS: no owner for ${repo}`);
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('HERMESQ_REPO_OWNERS: invalid owner');
  return name;
}
async function createCard(repo: string, branch: string, reason: string, env: NodeJS.ProcessEnv): Promise<void> {
  const assignee = owner(repo, env);
  const prefix = env.HERMESQ_SYNC_CARD_PREFIX ? `${env.HERMESQ_SYNC_CARD_PREFIX} ` : '';
  const org = env.HERMESQ_SYNC_ORG!;
  const title = `${prefix}${assignee}: resolve repository sync for ${org}/${repo} (${branch})`;
  const body = `${prefix}Sync of ${org}/${repo}, branch ${branch}, failed at ${reason}. Check the local clone and origin access; do not discard local changes.`;
  await new Promise<void>((ok, fail) => {
    const child = spawn('hermes', ['kanban', 'create', title, '--body-file', '-', '--assignee', assignee, '--idempotency-key', `sync-${repo}-${branch}`, '--created-by', 'sync-repo', '--json'], { env: gitEnv(env), stdio: ['pipe', 'ignore', 'ignore'], timeout: 15_000 });
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('close', code => code === 0 ? ok() : fail(new Error(`kanban create exit ${code}`)));
    child.stdin.end(body);
  });
}

export async function syncRepo(event: Event, deps: Deps = {
  root: process.env.HERMESQ_SYNC_ROOT ?? '',
  env: process.env,
  git: defaultGit(process.env),
  card: (repo, branch, reason) => createCard(repo, branch, reason, process.env),
}): Promise<void> {
  const org = deps.env.HERMESQ_SYNC_ORG;
  if (!org) throw new Error('HERMESQ_SYNC_ORG is required');
  if (!deps.root) throw new Error('HERMESQ_SYNC_ROOT is required');
  const target = fields(event, org);
  if (!target) return;
  let names: string[];
  try { names = await readdir(deps.root); } catch { return; }
  let configError: Error | undefined;
  for (const name of names) {
    const dir = join(deps.root, name);
    try {
      if (!(await lstat(dir)).isDirectory()) continue;
      const origin = (await deps.git(dir, 'config', '--get', 'remote.origin.url')).trim();
      if (originPattern(org).exec(origin)?.[1]?.toLowerCase() !== `${org}/${target.repo}`.toLowerCase()) continue;
    } catch { continue; } // Not a clone with a matching origin.
    let stage = 'fetch';
    try {
      await deps.git(dir, 'fetch', '--prune', 'origin');
      if (target.branch !== 'main' && target.branch !== 'develop') continue;
      const ref = `refs/heads/${target.branch}`;
      const remote = `refs/remotes/origin/${target.branch}`;
      let old: string, next: string;
      try {
        old = (await deps.git(dir, 'rev-parse', '--verify', ref)).trim();
        next = (await deps.git(dir, 'rev-parse', '--verify', remote)).trim();
      } catch { continue; } // Never create a missing branch.
      if (old === next) continue;
      stage = 'clone sujo';
      if ((await deps.git(dir, 'status', '--porcelain')).trim()) throw new Error(stage);
      stage = 'branch divergida';
      try { await deps.git(dir, 'merge-base', '--is-ancestor', old, next); }
      catch {
        // A local branch ahead of origin is already up to date; only a true fork needs a card.
        await deps.git(dir, 'merge-base', '--is-ancestor', next, old);
        continue;
      }
      stage = 'fast-forward local';
      const current = (await deps.git(dir, 'branch', '--show-current')).trim();
      if (current === target.branch) {
        // read-tree updates the clean index/worktree; update-ref then advances HEAD. No reset/merge/checkout.
        await deps.git(dir, 'read-tree', '-u', '-m', 'HEAD', remote);
        await deps.git(dir, 'update-ref', ref, next, old);
      } else {
        // Git itself rejects updating a branch checked out in another worktree.
        await deps.git(dir, 'branch', '-f', target.branch, next);
      }
    } catch {
      try { await deps.card(target.repo, target.branch, stage); }
      catch (error) {
        console.error('sync-repo:', error instanceof Error ? error.message : 'Kanban failed');
        if (error instanceof Error && error.message.startsWith('HERMESQ_')) configError = error;
      }
    }
  }
  if (configError) throw configError;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  try {
    await syncRepo(JSON.parse(data));
    process.stdout.write('[SILENT]\n');
  } catch (error) {
    console.error('sync-repo:', error instanceof Error ? error.message : 'error');
    process.exit(1);
  }
}
