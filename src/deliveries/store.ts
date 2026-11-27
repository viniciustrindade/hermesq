import { audit, withSchema } from '../db/schema';
import type { DeliveryStatus, HermesDelivery } from '../types';
import { EVENT_TTL_SECONDS } from '../utils/idempotency';

/**
 * Deliveries live in D1 (ordering, atomic claim, leases) and are mirrored to KV `delivery:{id}`
 * so an operator can inspect or reprocess them with `wrangler kv key get`.
 * Dead letters stay in KV without TTL.
 */
interface Row {
  seq: number;
  delivery_id: string;
  status: DeliveryStatus;
  attempts: number;
  max_attempts: number;
  body: string;
  result: string | null;
  claimed_by: string | null;
  lease_until: number | null;
}

export interface StoredDelivery extends HermesDelivery {
  seq: number;
  result?: unknown;
  leaseUntil?: number;
}

function toDelivery(row: Row): StoredDelivery {
  const body = JSON.parse(row.body) as HermesDelivery;
  const d: StoredDelivery = { ...body, seq: row.seq, status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts };
  if (row.result !== null) d.result = JSON.parse(row.result);
  if (row.lease_until !== null) d.leaseUntil = row.lease_until;
  return d;
}

export const deliveryKey = (id: string) => `delivery:${id}`;

async function mirror(kv: KVNamespace, d: StoredDelivery): Promise<void> {
  const opts = d.status === 'dead-letter' ? {} : { expirationTtl: EVENT_TTL_SECONDS };
  await kv.put(deliveryKey(d.deliveryId), JSON.stringify(d), opts);
}

export function backoffMs(attempts: number): number {
  return 1000 * 2 ** Math.max(0, attempts - 1);
}

export class DeliveryStore {
  constructor(
    private db: D1Database,
    private kv: KVNamespace,
  ) {}

  /** Idempotent insert (same deliveryId twice is a no-op). Returns true when inserted. */
  async insert(d: HermesDelivery, now = Date.now()): Promise<boolean> {
    const res = await withSchema(this.db, () =>
      this.db
        .prepare(
          `INSERT INTO deliveries (delivery_id, subscription_name, event, source_event_key, status, attempts, max_attempts, available_at, consumer, body, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?) ON CONFLICT (delivery_id) DO NOTHING`,
        )
        .bind(d.deliveryId, d.subscriptionName, d.event, d.sourceDeliveryId, d.maxAttempts, now, d.consumer ?? null, JSON.stringify(d), now, now)
        .run(),
    );
    const inserted = (res.meta.changes ?? 0) > 0;
    if (inserted) {
      const stored = await this.get(d.deliveryId);
      if (stored) await mirror(this.kv, stored);
    }
    return inserted;
  }

  async get(id: string): Promise<StoredDelivery | null> {
    const row = await withSchema(this.db, () => this.db.prepare('SELECT * FROM deliveries WHERE delivery_id = ?').bind(id).first<Row>());
    return row ? toDelivery(row) : null;
  }

  async list(status: DeliveryStatus | undefined, limit: number): Promise<StoredDelivery[]> {
    const stmt = status
      ? this.db.prepare('SELECT * FROM deliveries WHERE status = ? ORDER BY seq LIMIT ?').bind(status, limit)
      : this.db.prepare('SELECT * FROM deliveries ORDER BY seq DESC LIMIT ?').bind(limit);
    const { results } = await withSchema(this.db, () => stmt.all<Row>());
    return results.map(toDelivery);
  }

  /**
   * Atomically claims up to `limit` ready deliveries for one consumer. Each poller instance gets
   * disjoint deliveries (one UPDATE ... RETURNING), which is what lets several Hermes hosts share the work.
   * A delivery that names a consumer is claimable only by it; one without a consumer, by any.
   */
  async claim(consumer: string, limit: number, leaseMs: number, now = Date.now()): Promise<StoredDelivery[]> {
    const { results } = await withSchema(this.db, () =>
      this.db
        .prepare(
          `UPDATE deliveries SET status = 'processing', attempts = attempts + 1, lease_until = ?, claimed_by = ?, updated_at = ?
           WHERE seq IN (SELECT seq FROM deliveries WHERE status = 'pending' AND available_at <= ? AND (consumer IS NULL OR consumer = ?) ORDER BY seq LIMIT ?)
           RETURNING *`,
        )
        .bind(now + leaseMs, consumer, now, now, consumer, limit)
        .all<Row>(),
    );
    return results.map(toDelivery).sort((a, b) => a.seq - b.seq);
  }

  /**
   * Applies an ack. `failed` goes back to pending with exponential backoff (1s, 2s, 4s...) until
   * attempts reach maxAttempts, then becomes `dead-letter`.
   */
  async ack(id: string, status: 'delivered' | 'failed', result: unknown, consumer: string | null, now = Date.now()): Promise<{ ok: true; status: DeliveryStatus } | { ok: false; reason: 'not_found' | 'not_processing' | 'not_owner' }> {
    const current = await this.get(id);
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.status !== 'processing') return { ok: false, reason: 'not_processing' };
    const row = await withSchema(this.db, () => this.db.prepare('SELECT claimed_by FROM deliveries WHERE delivery_id = ?').bind(id).first<{ claimed_by: string | null }>());
    if (consumer && row?.claimed_by && row.claimed_by !== consumer) return { ok: false, reason: 'not_owner' };

    let next: DeliveryStatus;
    let availableAt = now;
    if (status === 'delivered') next = 'delivered';
    else if (current.attempts >= current.maxAttempts) next = 'dead-letter';
    else {
      next = 'pending';
      availableAt = now + backoffMs(current.attempts);
    }
    await this.db
      .prepare('UPDATE deliveries SET status = ?, available_at = ?, lease_until = NULL, result = ?, updated_at = ? WHERE delivery_id = ? AND status = \'processing\'')
      .bind(next, availableAt, result === undefined ? null : JSON.stringify(result), now, id)
      .run();
    const updated = await this.get(id);
    if (updated) await mirror(this.kv, updated);
    if (next === 'dead-letter') await audit(this.db, 'delivery.dead-letter', id, { reason: 'max_attempts', result });
    return { ok: true, status: next };
  }

  /** Leases that expired without an ack count as a failed attempt. Returns the ids it touched. */
  async reclaimExpired(now = Date.now()): Promise<{ deliveryId: string; status: DeliveryStatus }[]> {
    const { results } = await withSchema(this.db, () =>
      this.db
        .prepare(
          `UPDATE deliveries
             SET status = CASE WHEN attempts >= max_attempts THEN 'dead-letter' ELSE 'pending' END,
                 available_at = ?, lease_until = NULL, updated_at = ?,
                 result = CASE WHEN attempts >= max_attempts THEN '"lease_expired"' ELSE result END
           WHERE status = 'processing' AND lease_until < ?
           RETURNING *`,
        )
        .bind(now, now, now)
        .all<Row>(),
    );
    for (const row of results) {
      const d = toDelivery(row);
      await mirror(this.kv, d);
      if (d.status === 'dead-letter') await audit(this.db, 'delivery.dead-letter', d.deliveryId, { reason: 'lease_expired' });
    }
    return results.map((r) => ({ deliveryId: r.delivery_id, status: r.status }));
  }

  /** Manual reprocessing of a dead letter (or any delivery): back to pending with a fresh attempt budget. */
  async requeue(id: string, now = Date.now()): Promise<StoredDelivery | null> {
    const res = await withSchema(this.db, () =>
      this.db.prepare(`UPDATE deliveries SET status = 'pending', attempts = 0, available_at = ?, lease_until = NULL, claimed_by = NULL, updated_at = ? WHERE delivery_id = ?`).bind(now, now, id).run(),
    );
    if ((res.meta.changes ?? 0) === 0) return null;
    const d = await this.get(id);
    if (d) {
      await mirror(this.kv, d);
      await audit(this.db, 'delivery.requeue', id, null);
    }
    return d;
  }
}
