import { Hono } from 'hono';
import { DeliveryStore } from './deliveries/store';
import { admin } from './routes/admin';
import { hermes } from './routes/hermes';
import { ingest } from './routes/ingest';
import { oauth, setup } from './routes/oauth';
import { ws } from './routes/ws';
import { oauthStore, resolveSecret } from './secrets';
import { linear } from './services';
import type { Env } from './types';
import { pruneEvents } from './utils/idempotency';

// Kept out of src/index.ts on purpose: workerd treats every named export of the entry module as an
// entrypoint (handler or Durable Object class) and refuses to start on anything else.
export const VERSION = '0.1.0';

export const app = new Hono<{ Bindings: Env }>();
const AGENT = /^[a-z][a-z0-9-]{0,31}$/;

app.use('*', async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
  if (c.req.path.startsWith('/setup') || c.req.path.startsWith('/oauth')) {
    c.header('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'");
  }
});

app.get('/health', (c) => c.json({ ok: true, service: 'hermesq', version: VERSION }));
app.post('/github', (c) => ingest(c, 'github'));
app.post('/linear', (c) => ingest(c, 'linear'));
app.post('/linear/:agent', async (c) => {
  const agent = c.req.param('agent');
  if (!AGENT.test(agent)) return c.json({ error: 'not_found' }, 404);
  const secretName = `LINEAR_WEBHOOK_SECRET_${agent.toUpperCase().replaceAll('-', '_')}` as const;
  if (!(await resolveSecret(c.env, secretName))) return c.json({ error: 'not_found' }, 404);
  const adapter = {
    ...linear,
    secretName,
    eventTypes(headers: Headers, payload: unknown) {
      // Only the `<agent>/` labels: this secret belongs to one agent's app and must not fabricate workspace events.
      return linear.eventTypes(headers, payload).map((type) => `${agent}/${type}`);
    },
  };
  return ingest(c, 'linear', adapter, 200);
});
app.post('/stripe', (c) => ingest(c, 'stripe'));
app.post('/slack', (c) => ingest(c, 'slack'));
app.route('/hermes', hermes);
app.route('/ws', ws);
app.route('/setup', setup);
app.route('/oauth', oauth);
app.route('/admin', admin);
app.notFound((c) => c.json({ error: 'not_found' }, 404));
app.onError((err, c) => {
  console.error(JSON.stringify({ msg: 'unhandled', path: c.req.path, error: String(err) }));
  return c.json({ error: 'internal_error' }, 500);
});

/** Hourly cron: proactive OAuth refresh, expired-lease reclaim, dedupe-index pruning. */
export async function runScheduled(env: Env, now: number): Promise<{ refreshed: number; reclaimed: number; pruned: number }> {
  const refreshed = await oauthStore(env).refreshAllIfNeeded(now);
  const reclaimed = await new DeliveryStore(env.DB, env.EVENT_STORE).reclaimExpired(now);
  const pruned = await pruneEvents(env.DB, now);
  const summary = { refreshed: refreshed.length, reclaimed: reclaimed.length, pruned };
  console.log(JSON.stringify({ msg: 'scheduled', ...summary, errors: refreshed.filter((h) => h.last_refresh_error).map((h) => h.service) }));
  return summary;
}
