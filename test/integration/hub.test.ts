import { createHmac } from 'node:crypto';
import { describe, expect, inject, it } from 'vitest';

/**
 * hermesQ as publisher against a real `wrangler dev --local` (test/integration/global-setup.ts): two subscribers
 * open an outbound WebSocket, the Worker pushes a webhook to the one whose filter matches, the subscriber acks,
 * disconnects, and the reconnect gets what it missed. Nothing in this test polls the Worker.
 */
const URL_ = inject('workerUrl');
const VARS = inject('vars');
const WS_URL = URL_.replace(/^http/, 'ws');
const hmac = (secret: string, msg: string) => createHmac('sha256', secret).update(msg).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Msg = { op: string; [k: string]: unknown };

/** Opens `/ws` signed with the shared secret (headers are how a machine authenticates its upgrade). */
async function open(consumer: string, filters: string[], secret = VARS.HERMES_WEBHOOK_SECRET!) {
  const path = `/ws?consumer=${consumer}&${filters.map((f) => `filter=${f}`).join('&')}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = { 'x-hermes-timestamp': ts, 'x-hermes-signature': `sha256=${hmac(secret, `${ts}.GET.${path}.`)}` };
  const ws = new WebSocket(WS_URL + path, { headers } as unknown as string[]);
  const inbox: Msg[] = [];
  ws.addEventListener('message', (e) => {
    const text = String(e.data);
    inbox.push(text === 'pong' ? { op: 'pong' } : (JSON.parse(text) as Msg));
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('upgrade refused')));
  });
  const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
  const next = async (op: string, timeoutMs = 10_000): Promise<Msg> => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const i = inbox.findIndex((m) => m.op === op);
      if (i >= 0) return inbox.splice(i, 1)[0]!;
      if (Date.now() > end) throw new Error(`timed out waiting for ${op}`);
      await sleep(25);
    }
  };
  const hello = async (lastId?: number) => {
    ws.send(JSON.stringify(lastId === undefined ? { op: 'hello' } : { op: 'hello', last_id: lastId }));
    return next('ready');
  };
  return { ws, inbox, closed, next, hello, ack: (id: unknown) => ws.send(JSON.stringify({ op: 'ack', id })) };
}

async function push(delivery: string, repo: string, branch: string, message = 'work') {
  const raw = JSON.stringify({ ref: `refs/heads/${branch}`, repository: { name: repo }, commits: [{ message }] });
  const res = await fetch(`${URL_}/github`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': delivery, 'x-hub-signature-256': `sha256=${hmac(VARS.GITHUB_WEBHOOK_SECRET!, raw)}` },
    body: raw,
  });
  expect(res.status).toBe(202);
}

describe('hub over a real WebSocket', () => {
  it('refuses an upgrade signed with another secret', async () => {
    await expect(open('it-x', ['repo:x'], 'not-the-secret')).rejects.toThrow('upgrade refused');
  });

  it('2 subscribers: push to the matching one, ack, disconnect, reconnect and replay what was missed', async () => {
    const repo = `it-hub-${Date.now()}`;
    const a = await open('it-a', [`repo:${repo},ref:main`]);
    const b = await open('it-b', ['linear:abc-4242']);
    await a.hello();
    await b.hello();

    // A branch named after a task: only B follows linear:abc-4242. A follows main of the repo.
    await push(`it-d1-${repo}`, repo, 'main');
    await push(`it-d2-${repo}`, repo, 'feature/abc-4242-thing');
    const first = await a.next('event');
    expect(first).toMatchObject({ source: 'github', tags: ['source:github', 'type:push', `repo:${repo}`, 'ref:main'] });
    const forB = await b.next('event');
    expect(forB.tags).toEqual(expect.arrayContaining([`repo:${repo}`, 'ref:feature/abc-4242-thing', 'linear:abc-4242']));
    await sleep(300);
    expect(a.inbox.filter((m) => m.op === 'event')).toEqual([]); // A does not follow that branch
    expect(b.inbox.filter((m) => m.op === 'event')).toEqual([]); // B does not follow main

    // keepalive answered by the runtime
    a.ws.send('ping');
    expect((await a.next('pong')).op).toBe('pong');

    // A acks, goes offline; two more pushes to main happen meanwhile
    a.ack(first.id);
    await sleep(200);
    a.ws.close(1000, 'bye');
    await a.closed;
    await push(`it-d3-${repo}`, repo, 'main', 'm1');
    await push(`it-d4-${repo}`, repo, 'main', 'm2');

    // reconnect: hello without last_id continues from the cursor, in order
    const a2 = await open('it-a', [`repo:${repo},ref:main`]);
    const ready = await a2.hello();
    const replayed = a2.inbox.filter((m) => m.op === 'event');
    expect(ready).toMatchObject({ last_ack: first.id, replayed: 2 });
    expect(replayed.map((e) => (e.payload as { commits: { message: string }[] }).commits[0]!.message)).toEqual(['m1', 'm2']);
    expect(replayed[0]!.id as number).toBeGreaterThan(first.id as number);
    expect(replayed[1]!.id as number).toBeGreaterThan(replayed[0]!.id as number);

    // and the socket is live again
    a2.inbox.length = 0;
    await push(`it-d5-${repo}`, repo, 'main', 'm3');
    expect(((await a2.next('event')).payload as { commits: { message: string }[] }).commits[0]!.message).toBe('m3');

    a2.ws.close(1000, 'bye');
    b.ws.close(1000, 'bye');
  });
});
