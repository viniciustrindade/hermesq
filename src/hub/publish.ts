import type { Env, EventMessage, ServiceName } from '../types';
import { deriveTags } from './tags';

/** Services whose events go to the Hub. Stripe and Slack carry payment and chat data that no machine subscribes to. */
const PUBLISHED: readonly ServiceName[] = ['github', 'linear'];

export const hubStub = (env: Env) => env.HUB.getByName('global');

/**
 * Pushes an accepted event through the Hub. Best effort on purpose: the event is already stored for the poll path,
 * so a Hub failure is logged and must not turn an accepted webhook into a 500 (the provider would not retry it).
 */
export async function publishToHub(env: Env, msg: EventMessage): Promise<void> {
  if (!PUBLISHED.includes(msg.service)) return;
  try {
    await hubStub(env).publish({
      eventKey: msg.eventKey,
      source: msg.service,
      eventTypes: msg.eventTypes,
      tags: deriveTags(msg.service, msg.eventTypes, msg.payload, env.LINEAR_TEAM_KEYS),
      payload: msg.payload,
      receivedAt: msg.receivedAt,
    });
  } catch (err) {
    console.error(JSON.stringify({ msg: 'hub publish failed', eventKey: msg.eventKey, error: String(err) }));
  }
}
