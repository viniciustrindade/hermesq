import { evictDurableObject } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { adminSetSecrets, env, HERMES_SECRET } from './helpers';
import { sendPush, subscribe } from './hub-helpers';

// Own file on purpose: eviction waits for the object to drain and must not share a run with the other sockets.
beforeAll(async () => {
  await adminSetSecrets({ HERMES_WEBHOOK_SECRET: HERMES_SECRET });
});

it('a socket survives the Durable Object being evicted from memory: its filters live in the attachment', async () => {
  const s = await subscribe('hibernating', ['repo:sleepy,ref:main']);
  await evictDurableObject(env.HUB.getByName('global'));
  await sendPush('hibernation-1', 'sleepy', 'main');
  expect((await s.next('event')).tags).toContain('repo:sleepy');
  await sendPush('hibernation-2', 'sleepy', 'feature/y');
  await new Promise((r) => setTimeout(r, 300));
  expect(s.inbox.filter((m) => m.op === 'event')).toEqual([]);
  s.ws.close(1000, 'done');
});
