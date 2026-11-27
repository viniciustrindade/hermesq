import type { Context } from 'hono';
import { publishToHub } from '../hub/publish';
import { resolveSecret } from '../secrets';
import { ADAPTERS, type ServiceAdapter } from '../services';
import type { Env, EventMessage, ServiceName } from '../types';
import { claimEvent, EVENT_TTL_SECONDS, releaseEvent } from '../utils/idempotency';

export const MAX_BODY_BYTES = 1024 * 1024;
export const eventRecordKey = (eventKey: string) => `event:${eventKey}`;

/**
 * POST /<service>: verify signature -> dedupe by provider delivery id -> KV record -> service queue.
 * Answers after enqueue; the queue consumer does the rest.
 */
export async function ingest(c: Context<{ Bindings: Env }>, service: ServiceName, adapter: ServiceAdapter = ADAPTERS[service], acceptedStatus: 200 | 202 = 202): Promise<Response> {
  const env = c.env;
  const len = Number(c.req.header('content-length') ?? '0');
  if (len > MAX_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413);
  const raw = await c.req.text();
  if (raw.length > MAX_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413);

  const secret = await resolveSecret(env, adapter.secretName);
  if (!secret) return c.json({ error: 'not_configured', detail: `${adapter.secretName} is not set; open /setup` }, 503);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = undefined;
  }
  const headers = c.req.raw.headers;
  const verdict = await adapter.verify({ headers, raw, secret, now: Math.floor(Date.now() / 1000) }, payload);
  if (!verdict.ok) {
    console.warn(JSON.stringify({ msg: 'webhook rejected', service, reason: verdict.reason }));
    return c.json({ error: 'unauthorized', reason: verdict.reason }, 401);
  }
  if (payload === undefined) return c.json({ error: 'invalid_json' }, 400);

  const early = adapter.preflight?.(payload);
  if (early) return early;

  const deliveryId = adapter.deliveryId(headers, payload);
  if (!deliveryId) return c.json({ error: 'missing_delivery_id' }, 400);
  const eventKey = `${service}:${deliveryId}`;

  if (!(await claimEvent(env.DB, eventKey, service))) {
    return c.json({ status: 'duplicate', eventKey }, 200);
  }

  const msg: EventMessage = {
    kind: 'event',
    service,
    eventKey,
    deliveryId,
    eventTypes: adapter.eventTypes(headers, payload),
    payload,
    receivedAt: new Date().toISOString(),
  };
  try {
    await env.EVENT_STORE.put(eventRecordKey(eventKey), JSON.stringify({ status: 'queued', service, eventTypes: msg.eventTypes, receivedAt: msg.receivedAt }), {
      expirationTtl: EVENT_TTL_SECONDS,
    });
    await adapter.queue(env).send(msg, { contentType: 'json' });
  } catch (err) {
    await releaseEvent(env.DB, eventKey);
    console.error(JSON.stringify({ msg: 'enqueue failed', service, eventKey, error: String(err) }));
    return c.json({ error: 'enqueue_failed' }, 500);
  }
  console.log(JSON.stringify({ msg: 'webhook accepted', service, eventKey, eventTypes: msg.eventTypes }));
  await publishToHub(env, msg);
  return c.json({ status: 'accepted', eventKey }, acceptedStatus);
}
