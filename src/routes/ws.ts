import { Hono } from 'hono';
import { hubStub } from '../hub/publish';
import type { Env } from '../types';
import { verifyHermes } from './hermes';

export const ws = new Hono<{ Bindings: Env }>();

/**
 * GET /ws?consumer=<name>&filter=repo:infra,ref:main&filter=linear:abc-123
 * Same signature as /hermes/* (X-Hermes-Timestamp and X-Hermes-Signature over `GET /ws?<query>`), so the consumer
 * and the filters cannot be changed in transit. `consumer` names the socket; it routes, it does not authorize.
 */
ws.get('/', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return c.json({ error: 'upgrade_required' }, 426);
  const err = await verifyHermes(c.env, c.req.raw, '');
  if (err) return c.json({ error: 'unauthorized', reason: err }, err === 'not_configured' ? 503 : 401);
  return hubStub(c.env).fetch(c.req.raw);
});
