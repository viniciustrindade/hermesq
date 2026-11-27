import { Hono } from 'hono';
import { DeliveryStore } from '../deliveries/store';
import { resolveSecret } from '../secrets';
import { type Env, intVar } from '../types';
import { hmacSha256Hex, timingSafeEqual } from '../utils/hmac';

export const HERMES_REPLAY_WINDOW_SECONDS = 300;
export const DEFAULT_LONG_POLL_MS = 5000;
export const DEFAULT_LEASE_SECONDS = 300;
const POLL_INTERVAL_MS = 250;
const MAX_LIMIT = 50;

/**
 * Hermes request signature (the poller computes the same):
 *   X-Hermes-Timestamp: <unix seconds>
 *   X-Hermes-Signature: sha256=hex(HMAC_SHA256(HERMES_WEBHOOK_SECRET, `${ts}.${METHOD}.${path?query}.${body}`))
 */
export function hermesSigningString(ts: string, method: string, pathWithQuery: string, body: string): string {
  return `${ts}.${method.toUpperCase()}.${pathWithQuery}.${body}`;
}

export async function verifyHermes(env: Env, req: Request, body: string): Promise<string | null> {
  const secret = await resolveSecret(env, 'HERMES_WEBHOOK_SECRET');
  if (!secret) return 'not_configured';
  const ts = req.headers.get('x-hermes-timestamp');
  const sig = req.headers.get('x-hermes-signature');
  if (!ts || !sig) return 'missing_signature';
  const tn = Number(ts);
  if (!Number.isFinite(tn) || Math.abs(Date.now() / 1000 - tn) > HERMES_REPLAY_WINDOW_SECONDS) return 'stale_timestamp';
  const url = new URL(req.url);
  const expected = `sha256=${await hmacSha256Hex(secret, hermesSigningString(ts, req.method, url.pathname + url.search, body))}`;
  return timingSafeEqual(sig, expected) ? null : 'bad_signature';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const hermes = new Hono<{ Bindings: Env }>();

/**
 * GET /hermes/poll?limit=10&wait=5000&lastDeliveryId=...
 * Long-poll: holds up to `wait` ms (capped by HERMES_LONG_POLL_MS) until a delivery is ready, claims it
 * for this consumer (header X-Hermes-Consumer) and returns it. Unacked claims return to the queue when the lease ends.
 * `lastDeliveryId` is echoed back as the cursor when nothing new arrives; ordering and exclusivity come from the claim.
 */
hermes.get('/poll', async (c) => {
  const err = await verifyHermes(c.env, c.req.raw, '');
  if (err) return c.json({ error: 'unauthorized', reason: err }, err === 'not_configured' ? 503 : 401);
  const limit = Math.min(MAX_LIMIT, Math.max(1, intVar(c.req.query('limit'), 10)));
  const maxWait = intVar(c.env.HERMES_LONG_POLL_MS, DEFAULT_LONG_POLL_MS);
  const wait = Math.min(maxWait, intVar(c.req.query('wait'), maxWait));
  const leaseMs = intVar(c.env.HERMES_LEASE_SECONDS, DEFAULT_LEASE_SECONDS) * 1000;
  const consumer = c.req.header('x-hermes-consumer') || 'default';
  const store = new DeliveryStore(c.env.DB, c.env.EVENT_STORE);

  await store.reclaimExpired();
  const deadline = Date.now() + wait;
  for (;;) {
    const deliveries = await store.claim(consumer, limit, leaseMs);
    if (deliveries.length) {
      return c.json({ deliveries, cursor: deliveries[deliveries.length - 1]!.deliveryId });
    }
    if (Date.now() + POLL_INTERVAL_MS > deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }
  return c.json({ deliveries: [], cursor: c.req.query('lastDeliveryId') ?? null });
});

/** POST /hermes/ack {deliveryId, status: 'delivered'|'failed', result?} */
hermes.post('/ack', async (c) => {
  const raw = await c.req.text();
  const err = await verifyHermes(c.env, c.req.raw, raw);
  if (err) return c.json({ error: 'unauthorized', reason: err }, err === 'not_configured' ? 503 : 401);
  let body: { deliveryId?: unknown; status?: unknown; result?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  if (typeof body.deliveryId !== 'string' || (body.status !== 'delivered' && body.status !== 'failed')) {
    return c.json({ error: 'invalid_body', detail: 'expected {deliveryId, status: delivered|failed, result?}' }, 400);
  }
  const store = new DeliveryStore(c.env.DB, c.env.EVENT_STORE);
  const res = await store.ack(body.deliveryId, body.status, body.result, c.req.header('x-hermes-consumer') ?? null);
  if (!res.ok) return c.json({ error: res.reason }, res.reason === 'not_found' ? 404 : 409);
  return c.json({ deliveryId: body.deliveryId, status: res.status });
});
