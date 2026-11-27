import { hmacSha256Hex } from '../../src/utils/hmac';
import { GITHUB_VECTOR } from '../fixtures/providers';
import { call, hermesHeaders, waitFor } from './helpers';

export type HubMessage = { op: string; [key: string]: unknown };

export interface HubClient {
  ws: WebSocket;
  inbox: HubMessage[];
  /** Waits for the next message with this `op` that was not consumed yet. */
  next(op: string): Promise<HubMessage>;
  send(msg: unknown): void;
  /** Resolves with the close code once the server closed the socket. */
  closed: Promise<number>;
}

/** Opens `GET /ws?<query>` signed like any /hermes request (HMAC of the path with the query). */
export async function openHub(query: string, headers?: Record<string, string>) {
  const path = `/ws?${query}`;
  const signed = headers ?? { ...(await hermesHeaders('GET', path, '')), upgrade: 'websocket' };
  const res = await call(path, { headers: signed });
  if (res.status !== 101 || !res.webSocket) return { res, client: undefined };
  const ws = res.webSocket;
  ws.accept();
  const inbox: HubMessage[] = [];
  const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
  ws.addEventListener('message', (e) => {
    try {
      inbox.push(JSON.parse(e.data as string) as HubMessage);
    } catch {
      inbox.push({ op: 'text', data: e.data }); // the keepalive answer is a bare `pong`
    }
  });
  const client: HubClient = {
    ws,
    inbox,
    closed,
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    next: (op) =>
      waitFor(async () => {
        const i = inbox.findIndex((m) => m.op === op);
        return i < 0 ? null : inbox.splice(i, 1)[0];
      }),
  };
  return { res, client };
}

/** Connects, says hello (optionally from `last_id`) and waits for `ready`. Replayed events are in `inbox` before `ready`. */
export async function subscribe(consumer: string, filters: string[], lastId?: number): Promise<HubClient> {
  const query = [`consumer=${consumer}`, ...filters.map((f) => `filter=${f}`)].join('&');
  const { client } = await openHub(query);
  if (!client) throw new Error('subscribe: upgrade refused');
  client.send(lastId === undefined ? { op: 'hello' } : { op: 'hello', last_id: lastId });
  await client.next('ready');
  return client;
}

export async function sendPush(delivery: string, repo: string, branch: string, messages: string[] = []) {
  return sendGithubEvent('push', delivery, { ref: `refs/heads/${branch}`, repository: { name: repo }, commits: messages.map((message) => ({ message })) });
}

export async function sendGithubEvent(event: string, delivery: string, payload: unknown) {
  const raw = JSON.stringify(payload);
  const res = await call('/github', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': `sha256=${await hmacSha256Hex(GITHUB_VECTOR.secret, raw)}` },
    body: raw,
  });
  if (res.status !== 202) throw new Error(`/github ${res.status} ${await res.text()}`);
}

/** Asserts that nothing with this `op` arrives in `ms` (a negative check needs a bounded wait, not a poll of the system under test). */
export async function expectSilence(client: HubClient, op = 'event', ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  if (client.inbox.some((m) => m.op === op)) throw new Error(`unexpected ${op}: ${JSON.stringify(client.inbox.filter((m) => m.op === op))}`);
}
