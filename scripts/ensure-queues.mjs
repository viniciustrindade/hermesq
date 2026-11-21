#!/usr/bin/env node
// Creates the Cloudflare Queues named in wrangler.jsonc for one environment if they do not exist yet.
// `wrangler deploy` provisions KV and D1 by itself but stops with "Queue X does not exist" for queues.
// Usage (needs CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID; exits 2 at once, naming what is missing, if they are not set):
//        node scripts/ensure-queues.mjs [staging|production]
//        node scripts/ensure-queues.mjs --check-credentials <env>   (only check the credentials; used first in cd.yml)
//        node scripts/ensure-queues.mjs --list <env>   (print the names only; no API call)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function queueNames(config, env) {
  const block = env && env !== 'production' ? config.env?.[env] : config;
  if (!block) throw new Error(`environment "${env}" not found in wrangler.jsonc`);
  const q = block.queues ?? {};
  return [...new Set([...(q.producers ?? []).map((p) => p.queue), ...(q.consumers ?? []).map((c) => c.queue)])];
}

/** wrangler.jsonc -> object (drops // and /* *\/ comments outside strings, then trailing commas). */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const wrangler = (...args) => spawnSync('npx', ['wrangler', ...args], { encoding: 'utf8' });

const CREDENTIALS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];

/** Names (never values) of the Cloudflare credentials that are unset or blank. Without them wrangler fails once per queue. */
export function missingCredentials(env) {
  return CREDENTIALS.filter((name) => !(env[name] ?? '').trim());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const listOnly = args[0] === '--list';
  const checkOnly = args[0] === '--check-credentials';
  const env = (listOnly || checkOnly ? args[1] : args[0]) ?? 'production';
  if (!listOnly) {
    // One early, clear failure instead of one confusing wrangler error per queue (and per later step).
    const missing = missingCredentials(process.env);
    if (missing.length) {
      console.error(`ensure-queues: ${missing.join(' and ')} not set for the "${env}" environment: add ${missing.length > 1 ? 'them' : 'it'} as secret${missing.length > 1 ? 's' : ''} of that GitHub Environment (README, "Deploy"). Nothing was created.`);
      process.exit(2);
    }
    if (checkOnly) process.exit(0);
  }
  const names = queueNames(parseJsonc(readFileSync('wrangler.jsonc', 'utf8')), env);
  if (listOnly) {
    console.log(names.join('\n'));
    process.exit(0);
  }
  let failed = 0;
  for (const name of names) {
    if (wrangler('queues', 'info', name).status === 0) {
      console.log(`exists   ${name}`);
      continue;
    }
    const created = wrangler('queues', 'create', name);
    if (created.status === 0) console.log(`created  ${name}`);
    else {
      failed++;
      console.error(`FAILED   ${name}\n${created.stderr || created.stdout}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
