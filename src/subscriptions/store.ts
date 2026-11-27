import type { Subscription } from '../types';
import { DEFAULT_SUBSCRIPTIONS } from './defaults';

export const SUBSCRIPTIONS_KEY = 'subscriptions:list';

export class SubscriptionError extends Error {}

const MAX_STARS = 8; // a glob with many separate `*` backtracks polynomially (ReDoS in the Worker)
const CONSUMER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MATCH_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/** `{ path: pattern | pattern[] }` → `{ path: pattern[] }` (throws SubscriptionError). */
function parseMatch(name: string, raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SubscriptionError(`${name}.match must be an object`);
  const out: Record<string, string[]> = {};
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!MATCH_PATH.test(path)) throw new SubscriptionError(`${name}.match has an invalid path: ${JSON.stringify(path)}`);
    const patterns = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(patterns) || patterns.length === 0 || !patterns.every((p) => typeof p === 'string')) {
      throw new SubscriptionError(`${name}.match.${path} must be a string or a list of strings`);
    }
    for (const p of patterns as string[]) {
      if ((p.replace(/\*+/g, '*').match(/\*/g) ?? []).length > MAX_STARS) throw new SubscriptionError(`${name}.match.${path} has a pattern with more than ${MAX_STARS} *`);
    }
    out[path] = patterns as string[];
  }
  return out;
}

/** Validates and normalizes untrusted input into a subscription list (throws SubscriptionError). */
export function parseSubscriptions(input: unknown): Subscription[] {
  if (!Array.isArray(input)) throw new SubscriptionError('subscriptions must be an array');
  const seen = new Set<string>();
  return input.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new SubscriptionError(`subscriptions[${i}] must be an object`);
    const s = raw as Record<string, unknown>;
    const name = s.name;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new SubscriptionError(`subscriptions[${i}].name is invalid`);
    if (seen.has(name)) throw new SubscriptionError(`duplicate subscription name: ${name}`);
    seen.add(name);
    const strings = (v: unknown, field: string): string[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new SubscriptionError(`${name}.${field} must be a list of strings`);
      return v as string[];
    };
    const events = strings(s.events, 'events');
    if (events.length === 0) throw new SubscriptionError(`${name}.events must not be empty`);
    if (typeof s.prompt !== 'string') throw new SubscriptionError(`${name}.prompt must be a string`);
    const optStr = (v: unknown, field: string): string | undefined => {
      if (v === undefined || v === null || v === '') return undefined;
      if (typeof v !== 'string') throw new SubscriptionError(`${name}.${field} must be a string`);
      return v;
    };
    const sub: Subscription = {
      name,
      events,
      prompt: s.prompt,
      skills: strings(s.skills, 'skills'),
      deliver: optStr(s.deliver, 'deliver') ?? 'log',
      enabled: s.enabled === undefined ? true : s.enabled === true,
    };
    const chat = optStr(s.deliverChatId, 'deliverChatId');
    if (chat) sub.deliverChatId = chat;
    const filter = optStr(s.filterScript, 'filterScript');
    if (filter) sub.filterScript = filter;
    const consumer = optStr(s.consumer, 'consumer');
    if (consumer !== undefined) {
      if (!CONSUMER.test(consumer)) throw new SubscriptionError(`${name}.consumer is invalid (lowercase letters, digits and -, 1 to 64 characters)`);
      sub.consumer = consumer;
    }
    if (s.match !== undefined) sub.match = parseMatch(name, s.match);
    return sub;
  });
}

export async function loadSubscriptions(kv: KVNamespace): Promise<Subscription[]> {
  const stored = await kv.get(SUBSCRIPTIONS_KEY, 'json');
  if (stored === null) return DEFAULT_SUBSCRIPTIONS;
  return parseSubscriptions(stored);
}

export async function saveSubscriptions(kv: KVNamespace, input: unknown): Promise<Subscription[]> {
  const subs = parseSubscriptions(input);
  await kv.put(SUBSCRIPTIONS_KEY, JSON.stringify(subs));
  return subs;
}
