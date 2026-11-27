import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { adminSetSecrets, call, env, HERMES_SECRET, hermesHeaders, LINEAR_SECRET, signedLinear } from './helpers';
import { expectSilence, type HubClient, openHub, sendGithubEvent, sendPush, subscribe } from './hub-helpers';

/**
 * hermesQ as publisher: GET /ws upgrades to the Hub Durable Object (WebSocket Hibernation); POST /github and /linear
 * append the event to the Hub log and push it to the sockets whose filters match. Every test uses its own repo and
 * consumer names, because the Hub is one global object shared by the whole file.
 */
let n = 0;
const uniq = (prefix: string) => `${prefix}${++n}`;
const open: HubClient[] = [];
const track = (c: HubClient) => (open.push(c), c);
const sub = async (consumer: string, filters: string[], lastId?: number) => track(await subscribe(consumer, filters, lastId));
const hub = () => env.HUB.getByName('global');

beforeAll(async () => {
  await adminSetSecrets({ HERMES_WEBHOOK_SECRET: HERMES_SECRET, LINEAR_WEBHOOK_SECRET: LINEAR_SECRET });
});

afterEach(async () => {
  // Wait for the Close handshake so no socket outlives its test.
  const sockets = open.splice(0);
  for (const c of sockets) c.ws.close(1000, 'test over');
  await Promise.all(sockets.map((c) => c.closed));
});

describe('GET /ws: authentication and validation', () => {
  it('answers 426 to a signed request that is not a WebSocket upgrade', async () => {
    const path = '/ws?consumer=a&filter=repo:x';
    const res = await call(path, { headers: await hermesHeaders('GET', path, '') });
    expect(res.status).toBe(426);
  });

  it('rejects a request with no signature or a wrong one with 401', async () => {
    const path = '/ws?consumer=a&filter=repo:x';
    expect((await call(path, { headers: { upgrade: 'websocket' } })).status).toBe(401);
    const bad = { ...(await hermesHeaders('GET', path, '')), 'x-hermes-signature': 'sha256=00', upgrade: 'websocket' };
    expect((await call(path, { headers: bad })).status).toBe(401);
  });

  it('the signature covers the query: a signed consumer/filter cannot be swapped for another', async () => {
    const signedFor = await hermesHeaders('GET', '/ws?consumer=a&filter=repo:x', '');
    const res = await call('/ws?consumer=a&filter=repo:*', { headers: { ...signedFor, upgrade: 'websocket' } });
    expect(res.status).toBe(401);
  });

  it('a valid signature with a bad consumer or no filter is a 400, not a socket', async () => {
    for (const q of ['consumer=Bad_Name&filter=repo:x', 'consumer=ok', 'consumer=ok&filter=nokey']) {
      const { res } = await openHub(q, { ...(await hermesHeaders('GET', `/ws?${q}`, '')), upgrade: 'websocket' });
      expect(res.status).toBe(400);
    }
  });
});

describe('push: the event goes to every socket whose filter matches', () => {
  it('delivers a push with id, tags and payload, only to matching subscribers', async () => {
    const repo = uniq('infra');
    const [a, b, c] = [await sub(uniq('a'), [`repo:${repo},ref:main`]), await sub(uniq('b'), [`repo:${uniq('other')}`]), await sub(uniq('c'), [`repo:${repo},ref:develop`])];
    await sendPush(uniq('d'), repo, 'main');
    const ev = await a.next('event');
    expect(ev).toMatchObject({ op: 'event', source: 'github', tags: ['source:github', 'type:push', `repo:${repo}`, 'ref:main'] });
    expect(ev.id).toEqual(expect.any(Number));
    expect(ev.payload).toMatchObject({ ref: 'refs/heads/main' });
    await expectSilence(b);
    await expectSilence(c);
  });

  it('accepts a branch nobody planned for; a repo:* subscriber gets it', async () => {
    const repo = uniq('infra');
    const all = await sub(uniq('all'), [`repo:${repo}`]);
    const mains = await sub(uniq('mains'), [`repo:${repo},ref:main`]);
    await sendPush(uniq('d'), repo, 'weird/x');
    expect((await all.next('event')).tags).toContain('ref:weird/x');
    await expectSilence(mains);
  });

  it('one subscriber with several filters gets main, develop and release/x but not feature/y (OR between filters)', async () => {
    const repo = uniq('infra');
    const s = await sub(uniq('s'), [`repo:${repo},ref:main`, `repo:${repo},ref:develop`, `repo:${repo},ref:release/*`]);
    for (const branch of ['main', 'develop', 'release/x', 'feature/y']) await sendPush(uniq('d'), repo, branch);
    const refs = [(await s.next('event')).tags, (await s.next('event')).tags, (await s.next('event')).tags].map((t) => (t as string[]).find((x) => x.startsWith('ref:')));
    expect(refs).toEqual(['ref:main', 'ref:develop', 'ref:release/x']);
    await expectSilence(s);
  });

  it('a branch named after a task reaches a subscriber that only follows linear:abc-123', async () => {
    const repo = uniq('infra');
    const task = await sub(uniq('task'), ['linear:abc-123']);
    await sendPush(uniq('d'), repo, 'feature/abc-123-foo');
    expect((await task.next('event')).tags).toContain('linear:abc-123');
  });

  it('a PR with [ABC-123] in the title reaches it too; an event without EXT-N does not', async () => {
    const repo = uniq('infra');
    const task = await sub(uniq('task'), ['linear:abc-123']);
    await sendPush(uniq('d'), repo, 'main', ['no task here']);
    await sendGithubEvent('pull_request', uniq('d'), { action: 'opened', repository: { name: repo }, pull_request: { title: '[ABC-123] fix', body: '', head: { ref: 'fix/it' } } });
    const ev = await task.next('event');
    expect(ev.tags).toEqual(expect.arrayContaining(['type:pull_request', 'linear:abc-123']));
    await expectSilence(task);
  });

  it('Linear events are published too, tagged with the issue identifier', async () => {
    const task = await sub(uniq('lin'), ['source:linear,linear:abc-777']);
    const res = await signedLinear({ type: 'Issue', action: 'update', data: { identifier: 'ABC-777' } }, uniq('lin-delivery'));
    expect(res.status).toBe(202);
    expect((await task.next('event')).tags).toEqual(['source:linear', 'type:issue', 'linear:abc-777']);
  });

  it('ids grow with each event', async () => {
    const repo = uniq('infra');
    const s = await sub(uniq('s'), [`repo:${repo}`]);
    await sendPush(uniq('d'), repo, 'main');
    await sendPush(uniq('d'), repo, 'main');
    const [first, second] = [await s.next('event'), await s.next('event')];
    expect(second.id as number).toBeGreaterThan(first.id as number);
  });

  it('pushes nothing before the subscriber says hello, and the hello replays what it missed', async () => {
    const repo = uniq('infra');
    const consumer = uniq('late');
    const { client } = await openHub(`consumer=${consumer}&filter=repo:${repo}`);
    const c = track(client!);
    await sendPush(uniq('d'), repo, 'main');
    await expectSilence(c);
    c.send({ op: 'hello', last_id: 0 });
    expect((await c.next('event')).tags).toContain(`repo:${repo}`);
    await c.next('ready');
  });

  it('keepalive: ping is answered with pong', async () => {
    const s = await sub(uniq('s'), ['repo:x']);
    s.ws.send('ping');
    expect((await s.next('text')).data).toBe('pong');
  });
});

describe('one socket per consumer', () => {
  it('a new connection with the same consumer closes the old one (4001) and takes over', async () => {
    const repo = uniq('infra');
    const consumer = uniq('host');
    const oldOne = await sub(consumer, [`repo:${repo}`]);
    const newOne = await sub(consumer, [`repo:${repo}`]);
    expect(await oldOne.closed).toBe(4001);
    await sendPush(uniq('d'), repo, 'main');
    await newOne.next('event');
    await expectSilence(oldOne);
  });
});

describe('ack and cursor', () => {
  it('a new consumer starts at the head: no history, last_ack is null', async () => {
    const repo = uniq('infra');
    await sendPush(uniq('d'), repo, 'main');
    const { client } = await openHub(`consumer=${uniq('fresh')}&filter=repo:${repo}`);
    const c = track(client!);
    c.send({ op: 'hello' });
    const ready = await c.next('ready');
    expect(ready).toMatchObject({ consumer: expect.any(String), filters: [[`repo:${repo}`]], replayed: 0 });
    await expectSilence(c);
  });

  it('without ack, an event comes again at the reconnect; after ack it does not', async () => {
    const repo = uniq('infra');
    const consumer = uniq('host');
    const first = await sub(consumer, [`repo:${repo}`]);
    await sendPush(uniq('d'), repo, 'main');
    const ev = await first.next('event');
    first.ws.close(1000, 'bye');
    await first.closed;

    const again = await sub(consumer, [`repo:${repo}`], (ev.id as number) - 1);
    expect((await again.next('event')).id).toBe(ev.id);
    again.send({ op: 'ack', id: ev.id });
    again.ws.close(1000, 'bye');
    await again.closed;

    const third = await sub(consumer, [`repo:${repo}`]);
    await expectSilence(third);
    expect(third.inbox).toEqual([]);
  });

  it('the cursor is kept per consumer: ack by one does not move another', async () => {
    const repo = uniq('infra');
    const [x, y] = [uniq('x'), uniq('y')];
    const cx = await sub(x, [`repo:${repo}`]);
    const cy = await sub(y, [`repo:${repo}`]);
    await sendPush(uniq('d'), repo, 'main');
    const ev = await cx.next('event');
    await cy.next('event');
    cx.send({ op: 'ack', id: ev.id });
    cx.ws.close(1000, 'bye');
    cy.ws.close(1000, 'bye');
    await Promise.all([cx.closed, cy.closed]);

    // A hello without last_id continues from the consumer's own cursor: x acked, y did not.
    const ry = track(await subscribe(y, [`repo:${repo}`]));
    const rx = track(await subscribe(x, [`repo:${repo}`]));
    expect(ry.inbox.filter((m) => m.op === 'event').map((e) => e.id)).toEqual([ev.id]);
    expect(rx.inbox.filter((m) => m.op === 'event')).toEqual([]);
  });

  it('the cursor only moves forward, and a bad ack gets an error without closing the socket', async () => {
    const repo = uniq('infra');
    const consumer = uniq('host');
    const s = await sub(consumer, [`repo:${repo}`]);
    await sendPush(uniq('d'), repo, 'main');
    await sendPush(uniq('d'), repo, 'main');
    const [e1, e2] = [await s.next('event'), await s.next('event')];
    s.send({ op: 'ack', id: e2.id });
    s.send({ op: 'ack', id: e1.id }); // late, out of order
    s.send({ op: 'ack', id: 'x' });
    expect((await s.next('error')).reason).toBe('invalid_ack');
    s.ws.close(1000, 'bye');
    await s.closed;

    const back = await sub(consumer, [`repo:${repo}`]);
    expect(back.inbox.filter((m) => m.op === 'event')).toEqual([]);
  });

  it('ready reports the last ack of the consumer', async () => {
    const repo = uniq('infra');
    const consumer = uniq('host');
    const s = await sub(consumer, [`repo:${repo}`]);
    await sendPush(uniq('d'), repo, 'main');
    const ev = await s.next('event');
    s.send({ op: 'ack', id: ev.id });
    s.ws.close(1000, 'bye');
    await s.closed;
    const { client } = await openHub(`consumer=${consumer}&filter=repo:${repo}`);
    const c = track(client!);
    c.send({ op: 'hello' });
    expect(await c.next('ready')).toMatchObject({ last_ack: ev.id });
  });
});

describe('replay on reconnect (hello)', () => {
  it('sends what was missed, in order, and only what the filters accept', async () => {
    const repo = uniq('infra');
    const consumer = uniq('host');
    const online = await sub(consumer, [`repo:${repo},ref:main`, 'linear:abc-900']);
    await sendPush(uniq('d'), repo, 'main');
    const seen = await online.next('event');
    online.send({ op: 'ack', id: seen.id });
    online.ws.close(1000, 'bye');
    await online.closed;

    await sendPush(uniq('d'), repo, 'main', ['m1']);
    await sendPush(uniq('d'), repo, 'feature/y'); // no filter wants it
    await sendPush(uniq('d'), uniq('elsewhere'), 'feature/abc-900-z'); // linear:abc-900 does
    await sendPush(uniq('d'), repo, 'main', ['m2']);

    const back = track((await openHub(`consumer=${consumer}&filter=repo:${repo},ref:main&filter=linear:abc-900`)).client!);
    back.send({ op: 'hello' });
    const ready = await back.next('ready');
    const events = back.inbox.filter((m) => m.op === 'event');
    expect(events.map((e) => (e.tags as string[]).find((t) => t.startsWith('ref:')))).toEqual(['ref:main', 'ref:feature/abc-900-z', 'ref:main']);
    expect(events.map((e) => e.id as number)).toEqual([...events.map((e) => e.id as number)].sort((a, b) => a - b));
    expect(events[0]!.id as number).toBeGreaterThan(seen.id as number);
    expect(ready).toMatchObject({ replayed: 3, last_ack: seen.id });
  });

  it('after the replay the socket goes live', async () => {
    const repo = uniq('infra');
    const s = await sub(uniq('s'), [`repo:${repo}`]);
    await sendPush(uniq('d'), repo, 'main');
    expect((await s.next('event')).tags).toContain(`repo:${repo}`);
  });
});

describe('retention: 7 days, cleaned by the Durable Object alarm', () => {
  it('an alarm is armed once events exist, and the purge drops only events older than 7 days', async () => {
    const repo = uniq('infra');
    await sendPush(uniq('d'), repo, 'main');
    expect(await runInDurableObject(hub(), (_i, state) => state.storage.getAlarm())).not.toBeNull();

    const day = 24 * 3600 * 1000;
    const replay = async () => {
      const c = track((await openHub(`consumer=${uniq('r')}&filter=repo:${repo}`)).client!);
      c.send({ op: 'hello', last_id: 0 });
      await c.next('ready');
      return c.inbox.filter((m) => m.op === 'event').length;
    };
    expect(await replay()).toBe(1);
    await hub().purge(Date.now() + 6 * day);
    expect(await replay()).toBe(1);
    await hub().purge(Date.now() + 8 * day);
    expect(await replay()).toBe(0);
  });
});
