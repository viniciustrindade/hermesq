import { beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../../src/utils/hmac';
import { SLACK_VECTOR } from '../fixtures/providers';
import { ack, ADMIN, adminSetSecrets, call, collect, env, HERMES_SECRET, LINEAR_SECRET, signedLinear, waitFor } from './helpers';

const SLACK_SECRET = SLACK_VECTOR.secret;
const GITHUB_SECRET = "It's a Secret to Everybody";
const STRIPE_SECRET = 'whsec_test_secret';

const issuePayload = (id: string) => ({
  type: 'Issue',
  action: 'create',
  data: { id, identifier: 'ENG-1', title: 'Wire the transfer', state: { name: 'Todo' } },
});

/** Polls until a delivery for `sourceDeliveryId` shows up (the queue consumer runs asynchronously). */
async function deliveryFor(sourceDeliveryId: string) {
  return (await collect([sourceDeliveryId]))[sourceDeliveryId]!;
}

describe('webhook ingestion before setup', () => {
  it('answers 503 not_configured when the service secret is missing', async () => {
    const res = await signedLinear(issuePayload('i0'), 'lin-unconfigured');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'not_configured' });
  });

  it('the setup API refuses requests without the admin token', async () => {
    const res = await call('/setup/secrets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ LINEAR_WEBHOOK_SECRET: 'x' }) });
    expect(res.status).toBe(401);
    const wrong = await call('/setup/secrets', { method: 'POST', headers: { ...ADMIN, authorization: 'Bearer nope' }, body: '{}' });
    expect(wrong.status).toBe(401);
  });
});

describe('webhook ingestion', () => {
  beforeAll(async () => {
    await adminSetSecrets({ LINEAR_WEBHOOK_SECRET: LINEAR_SECRET, HERMES_WEBHOOK_SECRET: HERMES_SECRET });
  });

  it('rejects a bad signature with 401 and stores nothing', async () => {
    const res = await signedLinear(issuePayload('i1'), 'lin-badsig', 'wrong-secret');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized', reason: 'bad_signature' });
    expect(await env.EVENT_STORE.get('event:linear:lin-badsig')).toBeNull();
  });

  it('accepts a signed webhook (202), routes it to a delivery and a second copy is a duplicate', async () => {
    const res = await signedLinear(issuePayload('i2'), 'lin-1');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'accepted', eventKey: 'linear:lin-1' });

    const again = await signedLinear(issuePayload('i2'), 'lin-1');
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: 'duplicate', eventKey: 'linear:lin-1' });

    const d = await deliveryFor('linear:lin-1');
    expect(d).toMatchObject({
      subscriptionName: 'linear-issue-synced',
      event: 'Issue.created',
      prompt: 'Linear ENG-1 create: Wire the transfer\nState: Todo',
      status: 'processing',
      attempts: 1,
      maxAttempts: 3,
    });
    const record = await waitFor(async () => {
      const r = (await env.EVENT_STORE.get('event:linear:lin-1', 'json')) as { status: string } | null;
      return r?.status === 'routed' ? r : null;
    });
    expect(record).toMatchObject({ status: 'routed', service: 'linear' });

    const first = await ack(d.deliveryId as string, 'delivered', { ok: true });
    expect(first.res.status).toBe(200);
    expect(first.body).toEqual({ deliveryId: d.deliveryId, status: 'delivered' });
    const second = await ack(d.deliveryId as string, 'delivered');
    expect(second.res.status).toBe(409);
    expect(second.body).toEqual({ error: 'not_processing' });

    const kv = (await env.EVENT_STORE.get(`delivery:${d.deliveryId}`, 'json')) as { status: string; result: unknown };
    expect(kv).toMatchObject({ status: 'delivered', result: { ok: true } });
  });

  it('missing delivery id is a 400 and payload over 1 MiB is a 413', async () => {
    const raw = JSON.stringify({ type: 'Issue', webhookTimestamp: Date.now() });
    const noId = await call('/linear', { method: 'POST', headers: { 'linear-signature': await hmacSha256Hex(LINEAR_SECRET, raw) }, body: raw });
    expect(noId.status).toBe(400);
    const big = await call('/linear', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) });
    expect(big.status).toBe(413);
  });

  it('Slack url_verification answers the challenge; app_mention becomes a slack-mention delivery', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const send = async (payload: unknown) => {
      const raw = JSON.stringify(payload);
      const sig = `v0=${await hmacSha256Hex(SLACK_SECRET, `v0:${ts}:${raw}`)}`;
      return call('/slack', { method: 'POST', headers: { 'x-slack-signature': sig, 'x-slack-request-timestamp': ts }, body: raw });
    };
    const challenge = await send({ type: 'url_verification', challenge: 'c-123' });
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toEqual({ challenge: 'c-123' });

    const res = await send({ type: 'event_callback', event_id: 'Ev01', event: { type: 'app_mention', user: 'U1', channel: 'C1', text: 'hi bot' } });
    expect(res.status).toBe(202);
    const d = await deliveryFor('slack:Ev01');
    expect(d).toMatchObject({ subscriptionName: 'slack-mention', prompt: 'Slack mention from U1 in C1: hi bot' });
  });

  it('GitHub review_requested and Stripe invoice events land in their own subscriptions', async () => {
    const ghRaw = JSON.stringify({ action: 'review_requested', pull_request: { number: 7, title: 'Add core' }, repository: { full_name: 'o/r' }, requested_reviewer: { login: 'reviewer' } });
    const gh = await call('/github', {
      method: 'POST',
      headers: { 'x-github-event': 'pull_request', 'x-github-delivery': 'gh-1', 'x-hub-signature-256': `sha256=${await hmacSha256Hex(GITHUB_SECRET, ghRaw)}` },
      body: ghRaw,
    });
    expect(gh.status).toBe(202);

    const t = Math.floor(Date.now() / 1000);
    const stRaw = JSON.stringify({ id: 'evt_1', type: 'invoice.payment_succeeded', data: { object: { customer: 'cus_1', amount_paid: 4200 } } });
    const st = await call('/stripe', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${await hmacSha256Hex(STRIPE_SECRET, `${t}.${stRaw}`)}` }, body: stRaw });
    expect(st.status).toBe(202);

    const got = await collect(['github:gh-1', 'stripe:evt_1']);
    expect(got['github:gh-1']).toMatchObject({ subscriptionName: 'github-pr-review-requested', prompt: 'Review PR #7: Add core\nRepo: o/r\nReviewer: reviewer' });
    expect(got['stripe:evt_1']).toMatchObject({ subscriptionName: 'stripe-payment-succeeded', prompt: 'Payment succeeded for cus_1: 4200' });
  });

  it('an event no subscription matches is recorded as no-match and creates no delivery', async () => {
    const res = await signedLinear({ type: 'Reaction', action: 'create', data: {} }, 'lin-nomatch');
    expect(res.status).toBe(202);
    const r = await waitFor(async () => {
      const v = (await env.EVENT_STORE.get('event:linear:lin-nomatch', 'json')) as { status: string } | null;
      return v?.status === 'no-match' ? v : null;
    });
    expect(r).toMatchObject({ status: 'no-match', deliveries: [] });
  });
});
