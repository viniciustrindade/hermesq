import type { EventMessage, HermesDelivery, Subscription } from '../types';
import { stableId } from '../utils/hmac';
import { lookup, renderTemplate } from './renderer';

/** Glob with `*` only, anchored; every other character is literal. Consecutive `*` count as one (no stacked `.*` to backtrack on). */
export function globMatches(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.replace(/\*+/g, '*').split('*').map((part) => part.replace(/[\\^$.+?()[\]{}|/-]/g, '\\$&')).join('.*')}$`, 's');
  return re.test(value);
}

/** True when every `match` path holds a scalar that matches one of its patterns. A missing field never matches. */
export function payloadMatches(match: Record<string, string[]> | undefined, payload: unknown): boolean {
  if (!match) return true;
  return Object.entries(match).every(([path, patterns]) => {
    const v = lookup(payload, path);
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return false;
    return patterns.some((p) => globMatches(p, String(v)));
  });
}

/** Returns each enabled subscription with the first event type it matched (and whose payload filter passes). */
export function matchSubscriptions(subs: Subscription[], eventTypes: string[], payload?: unknown): { sub: Subscription; event: string }[] {
  const out: { sub: Subscription; event: string }[] = [];
  for (const sub of subs) {
    if (!sub.enabled) continue;
    const event = eventTypes.find((t) => sub.events.includes(t) || sub.events.includes('*'));
    if (event && payloadMatches(sub.match, payload)) out.push({ sub, event });
  }
  return out;
}

/** Builds the delivery. The id is derived from (event, subscription), so a retried batch never duplicates work. */
export async function buildDelivery(msg: EventMessage, sub: Subscription, event: string, maxAttempts: number, now: Date): Promise<HermesDelivery> {
  const delivery: HermesDelivery = {
    deliveryId: await stableId(`${msg.eventKey}|${sub.name}`),
    subscriptionName: sub.name,
    event,
    prompt: renderTemplate(sub.prompt, msg.payload),
    skills: sub.skills,
    deliver: sub.deliver,
    payload: msg.payload,
    sourceDeliveryId: msg.eventKey,
    createdAt: now.toISOString(),
    attempts: 0,
    maxAttempts,
    status: 'pending',
  };
  if (sub.deliverChatId) delivery.deliverChatId = sub.deliverChatId;
  if (sub.filterScript) delivery.filterScript = sub.filterScript;
  if (sub.consumer) delivery.consumer = sub.consumer;
  return delivery;
}
