import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DeliveryStore } from '../../src/deliveries/store';
import { ensureSchema } from '../../src/db/schema';
import worker from '../../src/index';
import { SUBSCRIPTIONS_KEY } from '../../src/subscriptions/store';
import type { EventMessage, HermesDelivery, QueueMessageBody } from '../../src/types';
import { ack, ADMIN, adminSetSecrets, call, env, HERMES_SECRET, poll, waitFor } from './helpers';

const store = () => new DeliveryStore(env.DB, env.EVENT_STORE);

let n = 0;
function delivery(over: Partial<HermesDelivery> = {}): HermesDelivery {
  n += 1;
  return {
    deliveryId: `route-${Date.now()}-${n}`,
    subscriptionName: 'route-sub',
    event: 'push',
    prompt: 'p',
    skills: [],
    deliver: 'log',
    payload: {},
    sourceDeliveryId: `route:${n}`,
    createdAt: new Date().toISOString(),
    attempts: 0,
    maxAttempts: 3,
    status: 'pending',
    ...over,
  };
}

async function drain() {
  for (;;) {
    const { body } = await poll('limit=50&wait=0', 'drainer');
    if (body.deliveries.length === 0) return;
    for (const d of body.deliveries) await ack(d.deliveryId as string, 'delivered', null, 'drainer');
  }
}

async function runEvent(eventKey: string) {
  const msg: EventMessage = { kind: 'event', service: 'github', eventKey, deliveryId: eventKey, eventTypes: ['push'], payload: { ref: 'refs/heads/main' }, receivedAt: new Date().toISOString() };
  const message = { id: 'm', timestamp: new Date(), attempts: 1, body: msg as QueueMessageBody, ack() {}, retry() {} };
  await worker.queue({ queue: 'webhook-github', messages: [message], ackAll() {}, retryAll() {} } as unknown as MessageBatch<QueueMessageBody>, env);
}

beforeAll(async () => {
  await ensureSchema(env.DB);
  await adminSetSecrets({ HERMES_WEBHOOK_SECRET: HERMES_SECRET });
});

afterEach(async () => {
  await env.EVENT_STORE.delete(SUBSCRIPTIONS_KEY);
});

describe('delivery routing by consumer', () => {
  it('two subscriptions with consumer a and b make two deliveries; each poll gets only its own', async () => {
    await drain();
    await env.EVENT_STORE.put(
      SUBSCRIPTIONS_KEY,
      JSON.stringify([
        { name: 'sync-a', events: ['push'], prompt: 'a', consumer: 'a' },
        { name: 'sync-b', events: ['push'], prompt: 'b', consumer: 'b' },
      ]),
    );
    await runEvent('github:route-1');
    await waitFor(async () => {
      const { results } = await env.DB.prepare("SELECT 1 FROM deliveries WHERE source_event_key = 'github:route-1'").all();
      return results.length === 2;
    });

    const asA = await poll('limit=10&wait=0', 'a');
    expect(asA.body.deliveries.map((d) => [d.subscriptionName, d.consumer])).toEqual([['sync-a', 'a']]);
    const asB = await poll('limit=10&wait=0', 'b');
    expect(asB.body.deliveries.map((d) => [d.subscriptionName, d.consumer])).toEqual([['sync-b', 'b']]);
    expect((await poll('limit=10&wait=0', 'c')).body.deliveries).toEqual([]);

    await ack(asA.body.deliveries[0]!.deliveryId as string, 'delivered', null, 'a');
    await ack(asB.body.deliveries[0]!.deliveryId as string, 'delivered', null, 'b');
  });

  it('a subscription without consumer is claimed by whichever consumer polls (compatibility)', async () => {
    await drain();
    const d = delivery();
    await store().insert(d);
    const row = await env.DB.prepare('SELECT consumer FROM deliveries WHERE delivery_id = ?').bind(d.deliveryId).first<{ consumer: string | null }>();
    expect(row?.consumer).toBeNull();
    const got = await poll('limit=10&wait=0', 'whoever');
    expect(got.body.deliveries.map((x) => x.deliveryId)).toEqual([d.deliveryId]);
    await ack(d.deliveryId, 'delivered', null, 'whoever');
  });

  it('a delivery for consumer a is never claimed by b, and /admin/deliveries shows the consumer', async () => {
    await drain();
    const d = delivery({ consumer: 'a' });
    await store().insert(d);
    expect((await poll('limit=10&wait=0', 'b')).body.deliveries).toEqual([]);
    const list = (await (await call('/admin/deliveries?limit=200', { headers: ADMIN })).json()) as { deliveries: { deliveryId: string; consumer?: string }[] };
    expect(list.deliveries.find((x) => x.deliveryId === d.deliveryId)?.consumer).toBe('a');
    const asA = await poll('limit=10&wait=0', 'a');
    expect(asA.body.deliveries.map((x) => x.deliveryId)).toEqual([d.deliveryId]);
    await ack(d.deliveryId, 'delivered', null, 'a');
  });

  it('a lease that expires returns the delivery to pending with its consumer intact', async () => {
    await drain();
    const d = delivery({ consumer: 'a' });
    const s = store();
    await s.insert(d);
    const now = Date.now();
    expect((await s.claim('a', 1, 1000, now)).map((x) => x.deliveryId)).toEqual([d.deliveryId]);
    expect(await s.reclaimExpired(now + 1001)).toEqual([{ deliveryId: d.deliveryId, status: 'pending' }]);
    const row = await env.DB.prepare('SELECT status, consumer FROM deliveries WHERE delivery_id = ?').bind(d.deliveryId).first();
    expect(row).toEqual({ status: 'pending', consumer: 'a' });
    expect(await s.claim('b', 1, 1000, now + 1002)).toEqual([]);
    expect((await s.claim('a', 1, 1000, now + 1002)).map((x) => x.attempts)).toEqual([2]);
    await ack(d.deliveryId, 'delivered', null, 'a');
  });
});

describe('D1 created before the consumer column existed', () => {
  const OLD_DELIVERIES = `CREATE TABLE deliveries (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT NOT NULL UNIQUE, subscription_name TEXT NOT NULL, event TEXT NOT NULL,
     source_event_key TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
     available_at INTEGER NOT NULL, lease_until INTEGER, claimed_by TEXT, body TEXT NOT NULL, result TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`;

  async function downgrade() {
    await env.DB.prepare('DROP TABLE deliveries').run();
    await env.DB.prepare(OLD_DELIVERIES).run();
  }

  afterAll(async () => {
    await env.DB.prepare('DROP TABLE deliveries').run();
    await ensureSchema(env.DB);
  });

  it('claim migrates on first access (no such column), keeps the old rows claimable, and ensureSchema twice is harmless', async () => {
    await downgrade();
    const legacy = delivery();
    await env.DB.prepare(
      `INSERT INTO deliveries (delivery_id, subscription_name, event, source_event_key, status, attempts, max_attempts, available_at, body, created_at, updated_at)
       VALUES (?, 's', 'push', 'k', 'pending', 0, 3, 0, ?, 0, 0)`,
    )
      .bind(legacy.deliveryId, JSON.stringify(legacy))
      .run();

    const got = await store().claim('a', 10, 1000);
    expect(got.map((x) => x.deliveryId)).toEqual([legacy.deliveryId]);
    const cols = await env.DB.prepare("SELECT name FROM pragma_table_info('deliveries')").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain('consumer');

    await ensureSchema(env.DB);
    await ensureSchema(env.DB);
  });

  it('insert migrates too and the new row routes by consumer', async () => {
    await downgrade();
    const d = delivery({ consumer: 'a' });
    expect(await store().insert(d)).toBe(true);
    expect(await store().claim('b', 10, 1000)).toEqual([]);
    expect((await store().claim('a', 10, 1000)).map((x) => x.deliveryId)).toEqual([d.deliveryId]);
  });
});
