import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { matchesAnyFilter, parseSubscription } from './tags';

export const RETENTION_MS = 7 * 24 * 3600 * 1000;
/** How often the alarm looks for expired events (it only runs while the log has events). */
export const PURGE_EVERY_MS = 24 * 3600 * 1000;
/** WebSocket close code (4000-4999 is application space) sent to a socket replaced by a newer one of the same consumer. */
export const CLOSE_REPLACED = 4001;
const MAX_CLIENT_MESSAGE = 1024;

/** What the Worker hands to the Hub for one verified, deduplicated webhook. The Hub adds the `id`. */
export interface HubInput {
  eventKey: string;
  source: string;
  eventTypes: string[];
  tags: string[];
  payload: unknown;
  receivedAt: string;
}

export type HubEvent = HubInput & { id: number };

/** State kept on each socket (at most 2048 bytes): the Hibernation API restores it after the object slept. */
interface Attachment {
  consumer: string;
  filters: string[][];
  /** False until the hello was answered, so a live event never overtakes the replay. */
  ready: boolean;
}

const consumerTag = (consumer: string) => `consumer:${consumer}`;

/**
 * The hub of hermesQ: one global instance (`getByName('global')`). Publishers (the Worker routes) append events to
 * one SQLite log and push them to the sockets whose filters match; subscribers (machines) connect outbound over
 * WebSocket and keep one cursor each. Hibernation keeps the sockets open while the object sleeps; the keepalive
 * `ping`/`pong` is answered by the runtime without waking it. Nothing here polls: delivery is the publish itself,
 * recovery is the replay answered to `hello`.
 */
export class Hub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, received_at INTEGER NOT NULL, event TEXT NOT NULL)');
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS cursors (consumer TEXT PRIMARY KEY, last_ack INTEGER NOT NULL)');
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** Upgrade of `GET /ws` (the Worker already verified the signature). Query: `consumer` and one `filter` per interest. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('expected a WebSocket upgrade', { status: 426 });
    const sub = parseSubscription(new URL(request.url).searchParams);
    if (!sub.ok) return Response.json({ error: sub.reason }, { status: 400 });
    for (const old of this.ctx.getWebSockets(consumerTag(sub.consumer))) old.close(CLOSE_REPLACED, 'replaced');
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [consumerTag(sub.consumer)]);
    server.serializeAttachment({ consumer: sub.consumer, filters: sub.filters, ready: false } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Appends the event to the log and pushes it to every ready socket whose filters match. */
  async publish(input: HubInput): Promise<number> {
    const sql = this.ctx.storage.sql;
    const id = sql.exec<{ id: number }>('INSERT INTO log (received_at, event) VALUES (?, ?) RETURNING id', Date.now(), JSON.stringify(input)).one().id;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + PURGE_EVERY_MS);
    const message = JSON.stringify({ op: 'event', id, ...input });
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.ready && matchesAnyFilter(att.filters, input.tags)) ws.send(message);
    }
    return id;
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    let msg: { op?: unknown; last_id?: unknown; id?: unknown } = {};
    try {
      if (typeof message === 'string' && message.length <= MAX_CLIENT_MESSAGE) msg = JSON.parse(message) as typeof msg;
    } catch {
      // answered below as an unknown op
    }
    if (!att) return ws.close(1011, 'no state');
    if (msg.op === 'hello') this.hello(ws, att, msg.last_id);
    else if (msg.op === 'ack') this.ack(ws, att, msg.id);
    else ws.send(JSON.stringify({ op: 'error', reason: 'unknown_op' }));
  }

  /** Replays what the consumer missed (after `last_id`, else after its cursor, else nothing: a new consumer starts at the head), then goes live. */
  private hello(ws: WebSocket, att: Attachment, lastId: unknown): void {
    const sql = this.ctx.storage.sql;
    const head = this.head();
    const cursor = sql.exec<{ last_ack: number }>('SELECT last_ack FROM cursors WHERE consumer = ?', att.consumer).toArray()[0]?.last_ack ?? null;
    if (cursor === null && lastId === undefined) sql.exec('INSERT INTO cursors (consumer, last_ack) VALUES (?, ?)', att.consumer, head);
    const requested = typeof lastId === 'number' && Number.isInteger(lastId) && lastId >= 0 ? lastId : (cursor ?? head);
    let replayed = 0;
    for (const row of sql.exec<{ id: number; event: string }>('SELECT id, event FROM log WHERE id > ? ORDER BY id', Math.min(requested, head))) {
      const event = JSON.parse(row.event) as HubInput;
      if (!matchesAnyFilter(att.filters, event.tags)) continue;
      ws.send(JSON.stringify({ op: 'event', id: row.id, ...event }));
      replayed++;
    }
    ws.serializeAttachment({ ...att, ready: true } satisfies Attachment);
    ws.send(JSON.stringify({ op: 'ready', consumer: att.consumer, filters: att.filters, last_ack: cursor, replayed }));
  }

  /** `ack {id}`: the cursor of this consumer only moves forward, and never past the log head. */
  private ack(ws: WebSocket, att: Attachment, id: unknown): void {
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > this.head()) return ws.send(JSON.stringify({ op: 'error', reason: 'invalid_ack' }));
    this.ctx.storage.sql.exec(
      'INSERT INTO cursors (consumer, last_ack) VALUES (?, ?) ON CONFLICT (consumer) DO UPDATE SET last_ack = MAX(last_ack, excluded.last_ack)',
      att.consumer,
      id,
    );
  }

  private head(): number {
    return this.ctx.storage.sql.exec<{ head: number | null }>('SELECT MAX(id) AS head FROM log').one().head ?? 0;
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    // 1005/1006 cannot be sent back in a Close frame.
    ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
  }

  override webSocketError(ws: WebSocket): void {
    ws.close(1011, 'error');
  }

  /** Drops events older than the retention and, while any remain, schedules the next look. */
  async purge(now = Date.now()): Promise<void> {
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM log WHERE received_at < ?', now - RETENTION_MS);
    if (sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM log').one().n > 0) await this.ctx.storage.setAlarm(now + PURGE_EVERY_MS);
  }

  override async alarm(): Promise<void> {
    await this.purge();
  }
}
