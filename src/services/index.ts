import { hmacSha256Hex, timingSafeEqual } from '../utils/hmac';
import type { Env, EventMessage, ServiceName, StorableSecret } from '../types';

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export interface VerifyInput {
  headers: Headers;
  raw: string;
  secret: string;
  /** Unix seconds. */
  now: number;
}

/**
 * One adapter per provider. The core owns the pipeline (verify, dedupe, store, enqueue);
 * an adapter only knows the provider's signature scheme and where the delivery id and event type live.
 */
export interface ServiceAdapter {
  service: ServiceName;
  secretName: StorableSecret;
  queue: (env: Env) => Queue<EventMessage>;
  verify(input: VerifyInput, payload: unknown): Promise<VerifyResult>;
  /** Optional short-circuit after a valid signature (e.g. Slack url_verification). */
  preflight?(payload: unknown): Response | undefined;
  deliveryId(headers: Headers, payload: unknown): string | undefined;
  eventTypes(headers: Headers, payload: unknown): string[];
}

/** Max clock skew for providers that sign a timestamp (seconds). */
export const REPLAY_WINDOW_SECONDS = 300;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

const fail = (reason: string): VerifyResult => ({ ok: false, reason });

export const github: ServiceAdapter = {
  service: 'github',
  secretName: 'GITHUB_WEBHOOK_SECRET',
  queue: (env) => env.EVENT_QUEUE_GITHUB,
  async verify({ headers, raw, secret }) {
    const sig = headers.get('x-hub-signature-256');
    if (!sig) return fail('missing_signature');
    const expected = `sha256=${await hmacSha256Hex(secret, raw)}`;
    return timingSafeEqual(sig, expected) ? { ok: true } : fail('bad_signature');
  },
  deliveryId: (headers) => headers.get('x-github-delivery') ?? undefined,
  eventTypes(headers, payload) {
    const event = headers.get('x-github-event');
    if (!event) return [];
    const action = str(obj(payload).action);
    return action ? [event, `${event}.${action}`, `${event}_${action}`] : [event];
  },
};

const LINEAR_ACTIONS: Record<string, string> = { create: 'created', update: 'updated', remove: 'removed' };
const LINEAR_TYPE = /^[A-Z][A-Za-z0-9]*$/;
const LINEAR_ACTION = /^[a-z][A-Za-z0-9]*$/;

export const linear: ServiceAdapter = {
  service: 'linear',
  secretName: 'LINEAR_WEBHOOK_SECRET',
  queue: (env) => env.EVENT_QUEUE_LINEAR,
  async verify({ headers, raw, secret, now }, payload) {
    const sig = headers.get('linear-signature');
    if (!sig) return fail('missing_signature');
    if (!timingSafeEqual(sig, await hmacSha256Hex(secret, raw))) return fail('bad_signature');
    // Linear puts the send time (ms) in the body; the signature covers it.
    const ts = obj(payload).webhookTimestamp;
    if (typeof ts !== 'number') return fail('missing_timestamp');
    if (Math.abs(now - ts / 1000) > REPLAY_WINDOW_SECONDS) return fail('stale_timestamp');
    return { ok: true };
  },
  deliveryId: (headers) => headers.get('linear-delivery') ?? undefined,
  eventTypes(_headers, payload) {
    const p = obj(payload);
    const type = str(p.type);
    const action = str(p.action);
    // The type and action become event names (and `<agent>/` prefixes are added by the route), so
    // anything that is not a plain identifier matches no subscription: a workspace secret cannot forge agent-prefixed events.
    if (!type || !LINEAR_TYPE.test(type)) return [];
    if (p.action !== undefined && p.action !== null && !(typeof p.action === 'string' && LINEAR_ACTION.test(p.action))) return [];
    const types = [type];
    if (action) {
      types.push(`${type}.${action}`);
      const mapped = LINEAR_ACTIONS[action];
      if (mapped) types.push(`${type}.${mapped}`);
      if (type === 'Issue' && action === 'update' && 'assigneeId' in obj(p.updatedFrom)) types.push('Issue.assigned');
    }
    return types;
  },
};

export const stripe: ServiceAdapter = {
  service: 'stripe',
  secretName: 'STRIPE_WEBHOOK_SECRET',
  queue: (env) => env.EVENT_QUEUE_STRIPE,
  async verify({ headers, raw, secret, now }) {
    const header = headers.get('stripe-signature');
    if (!header) return fail('missing_signature');
    let t: string | undefined;
    const v1: string[] = [];
    for (const part of header.split(',')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k === 't') t = v;
      else if (k === 'v1') v1.push(v);
    }
    if (!t || v1.length === 0) return fail('malformed_signature');
    const tn = Number(t);
    if (!Number.isFinite(tn) || Math.abs(now - tn) > REPLAY_WINDOW_SECONDS) return fail('stale_timestamp');
    const expected = await hmacSha256Hex(secret, `${t}.${raw}`);
    return v1.some((s) => timingSafeEqual(s, expected)) ? { ok: true } : fail('bad_signature');
  },
  deliveryId: (_h, payload) => str(obj(payload).id),
  eventTypes: (_h, payload) => {
    const t = str(obj(payload).type);
    return t ? [t] : [];
  },
};

export const slack: ServiceAdapter = {
  service: 'slack',
  secretName: 'SLACK_SIGNING_SECRET',
  queue: (env) => env.EVENT_QUEUE_SLACK,
  async verify({ headers, raw, secret, now }) {
    const sig = headers.get('x-slack-signature');
    const ts = headers.get('x-slack-request-timestamp');
    if (!sig || !ts) return fail('missing_signature');
    const tn = Number(ts);
    if (!Number.isFinite(tn) || Math.abs(now - tn) > REPLAY_WINDOW_SECONDS) return fail('stale_timestamp');
    const expected = `v0=${await hmacSha256Hex(secret, `v0:${ts}:${raw}`)}`;
    return timingSafeEqual(sig, expected) ? { ok: true } : fail('bad_signature');
  },
  preflight(payload) {
    const p = obj(payload);
    if (p.type === 'url_verification' && typeof p.challenge === 'string') {
      return new Response(JSON.stringify({ challenge: p.challenge }), { headers: { 'content-type': 'application/json' } });
    }
    return undefined;
  },
  deliveryId: (_h, payload) => str(obj(payload).event_id),
  eventTypes(_h, payload) {
    const p = obj(payload);
    if (p.type === 'event_callback') {
      const t = str(obj(p.event).type);
      return t ? [t] : [];
    }
    const t = str(p.type);
    return t ? [t] : [];
  },
};

export const ADAPTERS: Record<ServiceName, ServiceAdapter> = { github, linear, stripe, slack };
