import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, inject, it } from 'vitest';
import { MOCK_CLIENT } from './mock-provider.ts';

const URL_ = inject('workerUrl');
const PROVIDER = inject('providerUrl');
const VARS = inject('vars');
const ADMIN = { authorization: `Bearer ${VARS.ADMIN_TOKEN}`, 'content-type': 'application/json' };

const hmac = (secret: string, msg: string) => createHmac('sha256', secret).update(msg).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hermesHeaders(method: string, path: string, body: string, consumer = 'it-host') {
  const ts = String(now());
  return { 'x-hermes-timestamp': ts, 'x-hermes-signature': `sha256=${hmac(VARS.HERMES_WEBHOOK_SECRET!, `${ts}.${method}.${path}.${body}`)}`, 'x-hermes-consumer': consumer, 'content-type': 'application/json' };
}
async function poll(query = 'limit=50&wait=0', consumer = 'it-host') {
  const path = `/hermes/poll?${query}`;
  const res = await fetch(URL_ + path, { headers: hermesHeaders('GET', path, '', consumer) });
  expect(res.status).toBe(200);
  return (await res.json()) as { deliveries: Record<string, unknown>[]; cursor: string | null };
}
async function ack(id: string, status: 'delivered' | 'failed', consumer = 'it-host') {
  const body = JSON.stringify({ deliveryId: id, status, result: { by: 'it' } });
  const res = await fetch(`${URL_}/hermes/ack`, { method: 'POST', headers: hermesHeaders('POST', '/hermes/ack', body, consumer), body });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function collect(sources: string[], timeoutMs = 15_000) {
  const seen: Record<string, Record<string, unknown>> = {};
  const end = Date.now() + timeoutMs;
  while (!sources.every((s) => seen[s])) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${sources.filter((s) => !seen[s]).join(', ')}`);
    for (const d of (await poll()).deliveries) seen[d.sourceDeliveryId as string] = d;
    await sleep(200);
  }
  return seen;
}
async function drain() {
  for (;;) {
    const { deliveries } = await poll();
    if (!deliveries.length) return;
    for (const d of deliveries) await ack(d.deliveryId as string, 'delivered');
  }
}

function linear(deliveryId: string, payload: Record<string, unknown>) {
  const raw = JSON.stringify({ webhookTimestamp: Date.now(), ...payload });
  return fetch(`${URL_}/linear`, { method: 'POST', headers: { 'linear-signature': hmac(VARS.LINEAR_WEBHOOK_SECRET!, raw), 'linear-delivery': deliveryId }, body: raw });
}
function stripe(payload: Record<string, unknown>) {
  const raw = JSON.stringify(payload);
  const t = now();
  return fetch(`${URL_}/stripe`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${hmac(VARS.STRIPE_WEBHOOK_SECRET!, `${t}.${raw}`)}` }, body: raw });
}
function slack(payload: Record<string, unknown>) {
  const raw = JSON.stringify(payload);
  const t = String(now());
  return fetch(`${URL_}/slack`, { method: 'POST', headers: { 'x-slack-signature': `v0=${hmac(VARS.SLACK_SIGNING_SECRET!, `v0:${t}:${raw}`)}`, 'x-slack-request-timestamp': t }, body: raw });
}
function github(id: string, event: string, payload: Record<string, unknown>) {
  const raw = JSON.stringify(payload);
  return fetch(`${URL_}/github`, { method: 'POST', headers: { 'x-github-event': event, 'x-github-delivery': id, 'x-hub-signature-256': `sha256=${hmac(VARS.GITHUB_WEBHOOK_SECRET!, raw)}` }, body: raw });
}
const issue = { type: 'Issue', action: 'create', data: { identifier: 'ENG-2', title: 'Integration', state: { name: 'Todo' } } };

describe('wrangler dev --local: ingestion', () => {
  it('health', async () => {
    expect(await (await fetch(`${URL_}/health`)).json()).toMatchObject({ ok: true });
  });

  it('routes a signed agent session through the loaded subscription to /admin/deliveries', async () => {
    const subscription = {
      name: 'linear-agent-session', events: ['worker-a/AgentSessionEvent.created', 'worker-a/AgentSessionEvent.prompted'],
      prompt: 'Linear agent session {action} ({agentSession.id})', skills: [], deliver: 'log', enabled: true,
    };
    const current = await fetch(`${URL_}/admin/subscriptions`, { headers: ADMIN });
    expect(current.status).toBe(200);
    const { subscriptions } = (await current.json()) as { subscriptions: Record<string, unknown>[] };
    const loaded = await fetch(`${URL_}/admin/subscriptions`, {
      method: 'PUT', headers: ADMIN, body: JSON.stringify([...subscriptions, subscription]),
    });
    expect(loaded.status).toBe(200);

    const id = 'it-agent-session';
    const fixture = JSON.parse(readFileSync('test/fixtures/linear/agent-session-created.json', 'utf8'));
    const raw = JSON.stringify({ ...fixture, webhookTimestamp: Date.now() });
    const response = await fetch(`${URL_}/linear/worker-a`, {
      method: 'POST', headers: { 'linear-signature': hmac(VARS.LINEAR_WEBHOOK_SECRET_WORKER_A!, raw), 'linear-delivery': id }, body: raw,
    });
    expect(response.status).toBe(200);
    const deadline = Date.now() + 15_000;
    let delivery: Record<string, unknown> | undefined;
    while (Date.now() < deadline && !delivery) {
      const listing = await fetch(`${URL_}/admin/deliveries`, { headers: ADMIN });
      expect(listing.status).toBe(200);
      const { deliveries } = (await listing.json()) as { deliveries: Record<string, unknown>[] };
      delivery = deliveries.find((d) => d.sourceDeliveryId === `linear:${id}`);
      if (!delivery) await sleep(200);
    }
    expect(delivery).toMatchObject({ subscriptionName: 'linear-agent-session', event: 'worker-a/AgentSessionEvent.created', prompt: 'Linear agent session created (session-test)' });
  });

  it('idempotency: the same Linear-Delivery twice -> second is duplicate', async () => {
    expect((await linear('it-dup', issue)).status).toBe(202);
    const second = await linear('it-dup', issue);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: 'duplicate', eventKey: 'linear:it-dup' });
    const got = await collect(['linear:it-dup']);
    await ack(got['linear:it-dup']!.deliveryId as string, 'delivered');
  });

  it('multi-service isolation: Linear + Stripe + Slack + GitHub each reach their own subscription', async () => {
    await drain();
    const res = await Promise.all([
      linear('it-multi', issue),
      stripe({ id: 'evt_it', type: 'invoice.payment_succeeded', data: { object: { customer: 'cus_it', amount_paid: 1 } } }),
      slack({ type: 'event_callback', event_id: 'EvIT', event: { type: 'app_mention', user: 'U', channel: 'C', text: 'hi' } }),
      github('gh-it', 'check_run', { action: 'completed', check_run: { name: 'review/bot-a', conclusion: 'success', head_sha: 'abc' } }),
    ]);
    expect(res.map((r) => r.status)).toEqual([202, 202, 202, 202]);
    const got = await collect(['linear:it-multi', 'stripe:evt_it', 'slack:EvIT', 'github:gh-it']);
    expect(Object.fromEntries(Object.entries(got).map(([k, d]) => [k, d.subscriptionName]))).toEqual({
      'linear:it-multi': 'linear-issue-synced',
      'stripe:evt_it': 'stripe-payment-succeeded',
      'slack:EvIT': 'slack-mention',
      'github:gh-it': 'github-check-completed',
    });
    expect(got['github:gh-it']!.prompt).toBe('Check review/bot-a: success\nSHA: abc');
    for (const d of Object.values(got)) expect((await ack(d.deliveryId as string, 'delivered')).status).toBe(200);
  });

  it('GitHub: a recorded check_run.created for review/bot-b (queued) becomes github-check-queued; the same event for a CI check is filtered out in the Worker', async () => {
    const recorded = JSON.parse(readFileSync('test/fixtures/github/check_run.created.json', 'utf8')) as Record<string, Record<string, unknown>>;
    const review = { ...recorded, check_run: { ...recorded.check_run, name: 'review/bot-b' } };
    expect((await github('gh-it-q', 'check_run', review)).status).toBe(202);
    expect((await github('gh-it-ci', 'check_run', recorded)).status).toBe(202);
    const got = await collect(['github:gh-it-q']);
    expect(got['github:gh-it-q']).toMatchObject({ subscriptionName: 'github-check-queued', event: 'check_run.created' });
    await sleep(1500);
    const leftovers = (await poll()).deliveries.filter((d) => d.sourceDeliveryId === 'github:gh-it-ci');
    expect(leftovers).toEqual([]);
    expect((await ack(got['github:gh-it-q']!.deliveryId as string, 'delivered')).status).toBe(200);
  });

  it('a forged signature never reaches a queue', async () => {
    const raw = JSON.stringify({ webhookTimestamp: Date.now(), ...issue });
    const res = await fetch(`${URL_}/linear`, { method: 'POST', headers: { 'linear-signature': hmac('forged', raw), 'linear-delivery': 'it-forged' }, body: raw });
    expect(res.status).toBe(401);
    await sleep(1500);
    expect((await poll()).deliveries.find((d) => d.sourceDeliveryId === 'linear:it-forged')).toBeUndefined();
  });
});

describe('wrangler dev --local: Hermes delivery', () => {
  it('long-poll: an empty poll holds ~5 s; a webhook during the hold returns it early', async () => {
    await drain();
    let t0 = Date.now();
    expect((await poll('limit=5')).deliveries).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4500);

    t0 = Date.now();
    const pending = poll('limit=5&wait=5000');
    await sleep(800);
    await linear('it-longpoll', issue);
    const { deliveries } = await pending;
    expect(deliveries.map((d) => d.sourceDeliveryId)).toEqual(['linear:it-longpoll']);
    expect(Date.now() - t0).toBeLessThan(4500);
    await ack(deliveries[0]!.deliveryId as string, 'delivered');
  });

  it('retry/DLQ: three failed acks -> dead-letter', async () => {
    await drain();
    await linear('it-dlq', issue);
    const d = (await collect(['linear:it-dlq']))['linear:it-dlq']!;
    const id = d.deliveryId as string;
    expect((await ack(id, 'failed')).body.status).toBe('pending');
    const again = async () => {
      for (let i = 0; i < 40; i++) {
        const got = (await poll()).deliveries.find((x) => x.deliveryId === id);
        if (got) return got;
        await sleep(200);
      }
      throw new Error('not redelivered');
    };
    expect((await again()).attempts).toBe(2);
    expect((await ack(id, 'failed')).body.status).toBe('pending');
    expect((await again()).attempts).toBe(3);
    expect((await ack(id, 'failed')).body.status).toBe('dead-letter');
    const admin = await (await fetch(`${URL_}/admin/deliveries/${id}`, { headers: ADMIN })).json();
    expect(admin).toMatchObject({ status: 'dead-letter', attempts: 3 });
  });

  it('the Python poller (hermes-plugin/transfer_client.py) polls and acks against the real Worker', async () => {
    await drain();
    await linear('it-python', issue);
    await collectNothingButWait();
    const run = spawnSync('python3', ['-I', 'hermes-plugin/transfer_client.py', 'poll-once', '--url', URL_, '--wait', '5000', '--ack', 'delivered', '--consumer', 'it-python'], {
      encoding: 'utf8',
      env: { ...process.env, HERMESQ_SECRET: VARS.HERMES_WEBHOOK_SECRET! },
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout) as { deliveries: Record<string, unknown>[]; acks: Record<string, unknown>[] };
    expect(out.deliveries.map((d) => d.sourceDeliveryId)).toEqual(['linear:it-python']);
    expect(out.acks).toEqual([{ deliveryId: out.deliveries[0]!.deliveryId, status: 'delivered' }]);
    const admin = await (await fetch(`${URL_}/admin/deliveries/${out.deliveries[0]!.deliveryId}`, { headers: ADMIN })).json();
    expect(admin).toMatchObject({ status: 'delivered', result: { by: 'transfer_client.py' } });
  });
});

/** Gives the queue consumer time to turn the webhook into a delivery before the one-shot poll. */
async function collectNothingButWait() {
  await sleep(2500);
}

async function control(body: Record<string, unknown> = {}) {
  return (await (await fetch(`${PROVIDER}/__control`, { method: 'POST', body: JSON.stringify(body) })).json()) as {
    calls: { path: string; form: Record<string, string>; authorization?: string }[];
    refreshToken: string | null;
  };
}
async function authorize(path: '/setup/start' | '/oauth/reconnect?service=linear') {
  const res = await fetch(URL_ + path, { method: 'POST', headers: ADMIN, body: JSON.stringify({ service: 'linear' }) });
  expect(res.status).toBe(200);
  const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
  expect(authorizeUrl.startsWith(`${PROVIDER}/linear/authorize?`)).toBe(true);
  // Browser: provider consent page redirects to /oauth/callback, which the Worker completes.
  const consent = await fetch(authorizeUrl, { redirect: 'manual' });
  expect(consent.status).toBe(302);
  const callback = await fetch(consent.headers.get('location')!);
  return { status: callback.status, text: await callback.text() };
}
async function health() {
  const { services } = (await (await fetch(`${URL_}/oauth/health`, { headers: ADMIN })).json()) as { services: Record<string, unknown>[] };
  return services.find((s) => s.service === 'linear')!;
}

describe('wrangler dev --local: OAuth lifecycle against a scripted provider', () => {
  it('flow: /setup/start -> provider -> /oauth/callback -> tokens stored -> /oauth/status connected', async () => {
    const save = await fetch(`${URL_}/setup/secrets`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ LINEAR_CLIENT_ID: MOCK_CLIENT.id, LINEAR_CLIENT_SECRET: MOCK_CLIENT.secret }) });
    expect(save.status).toBe(200);
    await control({ reset: true, expiresIn: 2 });
    const cb = await authorize('/setup/start');
    expect(cb.status).toBe(200);
    expect(cb.text).toContain('linear is connected');
    expect(await (await fetch(`${URL_}/oauth/status`, { headers: ADMIN })).json()).toEqual({ connected: ['linear'] });
    const { calls } = await control();
    expect(calls.map((c) => c.form.grant_type)).toEqual(['authorization_code']);
  });

  it('expiration + cron: needs_refresh turns true, the scheduled handler refreshes with rotation', async () => {
    const issued = (await control({ expiresIn: 3600 })).refreshToken;
    await sleep(2100);
    expect(await health()).toMatchObject({ needs_refresh: true });
    const cron = await fetch(`${URL_}/__scheduled?cron=${encodeURIComponent('0 * * * *')}`);
    expect(cron.status).toBe(200);
    let h = await health();
    for (let i = 0; i < 20 && h.needs_refresh; i++) {
      await sleep(250);
      h = await health();
    }
    expect(h).toMatchObject({ needs_refresh: false, last_refresh_error: null });
    expect(h.expires_at as number).toBeGreaterThan(Date.now() + 3_500_000);
    const { calls, refreshToken } = await control();
    const refresh = calls.filter((c) => c.form.grant_type === 'refresh_token');
    expect(refresh.map((c) => c.form.refresh_token)).toEqual([issued]);
    expect(refreshToken).not.toBe(issued);
  });

  it('forced refresh uses the rotated token (the provider rejects the old one)', async () => {
    const res = await fetch(`${URL_}/oauth/refresh?service=linear`, { method: 'POST', headers: ADMIN });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ last_refresh_error: null });
  });

  it('reconnection: /oauth/reconnect clears tokens, a new consent stores new ones', async () => {
    await control({ reset: true });
    const cb = await authorize('/oauth/reconnect?service=linear');
    expect(cb.status).toBe(200);
    expect(await health()).toMatchObject({ connected: true, needs_reconnect: false });
    expect((await control()).calls.map((c) => c.form.grant_type)).toEqual(['authorization_code']);
  });

  it('disconnect revokes at the provider with the token field and no Authorization header', async () => {
    await control({ reset: true });
    const res = await fetch(`${URL_}/oauth/disconnect?service=linear`, { method: 'POST', headers: ADMIN });
    expect(await res.json()).toEqual({ disconnected: true, revoked: true });
    const { calls } = await control();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: '/linear/revoke', form: { token_type_hint: 'access_token' } });
    expect(calls[0]!.authorization).toBeUndefined();
    expect(await (await fetch(`${URL_}/oauth/status`, { headers: ADMIN })).json()).toEqual({ connected: [] });
  });
});
