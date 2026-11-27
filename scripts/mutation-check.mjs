#!/usr/bin/env node
// Proves the unit tests exercise each mechanism (RED): breaks one thing at a time, requires the named
// test file to FAIL, then restores the source byte for byte (sha256 checked). Run: npm run test:mutation
// Optional filter: npm run test:mutation -- <id> [<id>...]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const MUTANTS = [
  ['github-hmac', 'src/services/index.ts', "const expected = `sha256=${await hmacSha256Hex(secret, raw)}`;\n    return timingSafeEqual(sig, expected) ? { ok: true } : fail('bad_signature');", "return { ok: true };", 'test/unit/signatures.test.ts'],
  ['slack-replay-window', 'src/services/index.ts', "if (!Number.isFinite(tn) || Math.abs(now - tn) > REPLAY_WINDOW_SECONDS) return fail('stale_timestamp');\n    const expected = `v0=", "if (!Number.isFinite(tn)) return fail('stale_timestamp');\n    const expected = `v0=", 'test/unit/signatures.test.ts'],
  ['dedupe', 'src/utils/idempotency.ts', 'return (res.meta.changes ?? 0) > 0;', 'return true;', 'test/unit/ingest.test.ts'],
  ['hermes-hmac', 'src/routes/hermes.ts', "return timingSafeEqual(sig, expected) ? null : 'bad_signature';", 'return null;', 'test/unit/hermes.test.ts'],
  ['long-poll-hold', 'src/routes/hermes.ts', 'if (Date.now() + POLL_INTERVAL_MS > deadline) break;', 'break;', 'test/unit/hermes.test.ts'],
  ['claim-exclusive', 'src/deliveries/store.ts', "WHERE status = 'pending' AND available_at <= ?", "WHERE status IN ('pending', 'processing') AND available_at <= ?", 'test/unit/hermes.test.ts'],
  ['delivery-backoff', 'src/deliveries/store.ts', 'return 1000 * 2 ** Math.max(0, attempts - 1);', 'return 0;', 'test/unit/hermes.test.ts'],
  ['delivery-dead-letter', 'src/deliveries/store.ts', 'else if (current.attempts >= current.maxAttempts) next = ', 'else if (current.attempts > current.maxAttempts) next = ', 'test/unit/hermes.test.ts'],
  ['consumer-dead-letter', 'src/queue/consumer.ts', 'if (message.attempts >= maxAttempts) {', 'if (message.attempts > maxAttempts) {', 'test/unit/consumer.test.ts'],
  ['consumer-backoff', 'src/queue/consumer.ts', 'message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });\n      }\n    }', 'message.retry();\n      }\n    }', 'test/unit/consumer.test.ts'],
  ['oauth-at-rest', 'src/durable-objects/oauth-store.ts', 'return encryptString((await this.loadKeys()).encrypt, JSON.stringify(value));', 'return JSON.stringify(value);', 'test/unit/oauth.test.ts'],
  ['oauth-state-single-use', 'src/durable-objects/oauth-store.ts', 'await this.ctx.storage.delete(key); // single use', '', 'test/unit/oauth.test.ts'],
  ['oauth-refresh-window', 'src/durable-objects/oauth-store.ts', 'export const REFRESH_REMAINING_FRACTION = 0.2;', 'export const REFRESH_REMAINING_FRACTION = 0;', 'test/unit/oauth.test.ts'],
  ['oauth-rotation', 'src/durable-objects/oauth-store.ts', 'if (!next.refresh_token) next.refresh_token = t.refresh_token;', 'next.refresh_token = t.refresh_token;', 'test/unit/oauth.test.ts'],
  ['oauth-reconnect-errors', 'src/oauth/providers.ts', "'invalid_grant', 'invalid_refresh_token', ", "'invalid_grant', ", 'test/unit/oauth.test.ts'],
  ['cron-refresh', 'src/app.ts', 'const refreshed = await oauthStore(env).refreshAllIfNeeded(now);', 'const refreshed: { last_refresh_error: string | null; service: string }[] = [];', 'test/unit/oauth.test.ts'],
  ['match-ignored', 'src/subscriptions/matcher.ts', 'if (event && payloadMatches(sub.match, payload)) out.push', 'if (event) out.push', 'test/unit/github.test.ts'],
  ['match-unanchored', 'src/subscriptions/matcher.ts', "const re = new RegExp(`^${", "const re = new RegExp(`${", 'test/unit/subscriptions.test.ts'],
  ['match-missing-field', 'src/subscriptions/matcher.ts', "if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return false;", "if (v === undefined) return patterns.includes('*');", 'test/unit/github.test.ts'],
  ['github-queued-only', 'src/subscriptions/defaults.ts', "'check_run.status': ['queued'] ", "'check_run.status': ['*'] ", 'test/unit/github.test.ts'],
  ['admin-auth', 'src/routes/admin.ts', "if (!given || !timingSafeEqual(given, token)) return c.json({ error: 'unauthorized' }, 401);", '', 'test/unit/ingest.test.ts'],
  ['ws-auth', 'src/routes/ws.ts', "if (err) return c.json({ error: 'unauthorized', reason: err }, err === 'not_configured' ? 503 : 401);", '', 'test/unit/hub.test.ts'],
  ['hub-push-filter', 'src/hub/hub.ts', 'if (att?.ready && matchesAnyFilter(att.filters, input.tags)) ws.send(message);', 'if (att?.ready) ws.send(message);', 'test/unit/hub.test.ts'],
  ['hub-live-after-hello', 'src/hub/hub.ts', 'if (att?.ready && matchesAnyFilter(att.filters, input.tags)) ws.send(message);', 'if (att && matchesAnyFilter(att.filters, input.tags)) ws.send(message);', 'test/unit/hub.test.ts'],
  ['hub-replay-filter', 'src/hub/hub.ts', 'if (!matchesAnyFilter(att.filters, event.tags)) continue;', '', 'test/unit/hub.test.ts'],
  ['hub-cursor-forward', 'src/hub/hub.ts', 'MAX(last_ack, excluded.last_ack)', 'excluded.last_ack', 'test/unit/hub.test.ts'],
  ['hub-one-socket-per-consumer', 'src/hub/hub.ts', "for (const old of this.ctx.getWebSockets(consumerTag(sub.consumer))) old.close(CLOSE_REPLACED, 'replaced');", '', 'test/unit/hub.test.ts'],
  ['hub-retention', 'src/hub/hub.ts', "sql.exec('DELETE FROM log WHERE received_at < ?', now - RETENTION_MS);", "sql.exec('DELETE FROM log WHERE received_at < ?', now - 30 * RETENTION_MS);", 'test/unit/hub.test.ts'],
  ['hub-new-consumer-at-head', 'src/hub/hub.ts', 'const requested = typeof lastId === \'number\' && Number.isInteger(lastId) && lastId >= 0 ? lastId : (cursor ?? head);', 'const requested = typeof lastId === \'number\' && Number.isInteger(lastId) && lastId >= 0 ? lastId : (cursor ?? 0);', 'test/unit/hub.test.ts'],
  ['tags-task-boundary', 'src/hub/tags.ts', '`(?<![a-z0-9])(?:${valid.join(\'|\')})-\\\\d+`', '`(?:${valid.join(\'|\')})-\\\\d+`', 'test/unit/hub-tags.test.ts'],
  ['tags-glob', 'src/hub/tags.ts', 'globMatches(value, tag.slice(key.length + 1))', 'value === tag.slice(key.length + 1)', 'test/unit/hub-tags.test.ts'],
  ['tags-or-between-filters', 'src/hub/tags.ts', 'return filters.some((filter) => filter.length > 0 && filter.every(', 'return filters.every((filter) => filter.length > 0 && filter.every(', 'test/unit/hub-tags.test.ts'],
];

const only = process.argv.slice(2);
const sha = (s) => createHash('sha256').update(s).digest('hex');
let failed = 0;
for (const [id, file, from, to, test] of MUTANTS) {
  if (only.length && !only.includes(id)) continue;
  const original = readFileSync(file, 'utf8');
  const count = original.split(from).length - 1;
  if (count !== 1) {
    console.log(`ERROR  ${id}: expected the target text once in ${file}, found ${count}`);
    failed++;
    continue;
  }
  const before = sha(original);
  writeFileSync(file, original.replace(from, to));
  let status;
  try {
    status = spawnSync('npx', ['vitest', 'run', test], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status;
  } finally {
    writeFileSync(file, original);
  }
  if (sha(readFileSync(file, 'utf8')) !== before) throw new Error(`restore of ${file} failed`);
  const red = status !== 0;
  if (!red) failed++;
  console.log(`${red ? 'RED  ' : 'ALIVE'}  ${id}  (${file} -> ${test}, exit ${status})`);
}
if (failed) {
  console.log(`\n${failed} mutant(s) survived or could not be applied`);
  process.exit(1);
}
console.log('\nall mutants killed');
