import { beforeAll, describe, expect, it } from 'vitest';
import { linear } from '../../src/services';
import { DEFAULT_SUBSCRIPTIONS } from '../../src/subscriptions/defaults';
import { matchSubscriptions } from '../../src/subscriptions/matcher';
import { hmacSha256Hex } from '../../src/utils/hmac';
import created from '../fixtures/linear/agent-session-created.json';
import prompted from '../fixtures/linear/agent-session-prompted.json';
import { ADMIN, adminSetSecrets, call, env, LINEAR_SECRET, signedLinear, waitFor } from './helpers';

const AGENT_SECRET = 'agent-app-secret-for-tests';
async function post(payload: Record<string, unknown>, id: string, secret = AGENT_SECRET, path = '/linear/worker-a') {
  const raw = JSON.stringify({ ...payload, webhookTimestamp: payload.webhookTimestamp || Date.now() });
  return call(path, { method: 'POST', headers: { 'linear-signature': await hmacSha256Hex(secret, raw), 'linear-delivery': id }, body: raw });
}

async function eventTypes(id: string): Promise<string[] | null> {
  const stored = (await env.EVENT_STORE.get(`event:linear:${id}`, 'json')) as { eventTypes: string[] } | null;
  return stored?.eventTypes ?? null;
}

describe('POST /linear/:agent', () => {
  it('returns 404 for unknown agent before reading its body or checking a secret', async () => {
    // A 413 would show that ingest inspected the body before checking the allowlist.
    const response = await call('/linear/zz', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) });
    expect(response.status).toBe(404);
    expect(await env.EVENT_STORE.get('event:linear:zz')).toBeNull();
  });

  it('returns 404 for an agent with no secret of its own, even if the workspace secret exists', async () => {
    await adminSetSecrets({ LINEAR_WEBHOOK_SECRET: LINEAR_SECRET });
    const response = await post(created, 'agent-unconfigured');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(await env.EVENT_STORE.get('event:linear:agent-unconfigured')).toBeNull();
  });

  it('accepts any well-formed agent that has its own secret, and rejects a malformed name with 404', async () => {
    await adminSetSecrets({ LINEAR_WEBHOOK_SECRET_WORKER_A: AGENT_SECRET });
    expect((await post(created, 'agent-configured')).status).toBe(200);
    expect(await waitFor(() => eventTypes('agent-configured'))).toContain('worker-a/AgentSessionEvent.created');
    expect((await post(created, 'agent-uppercase', undefined, '/linear/Worker-A')).status).toBe(404);
  });

  describe('configured agent app', () => {
    beforeAll(async () => {
      await adminSetSecrets({ LINEAR_WEBHOOK_SECRET: LINEAR_SECRET, LINEAR_WEBHOOK_SECRET_WORKER_A: AGENT_SECRET });
      const response = await call('/admin/subscriptions', { method: 'PUT', headers: ADMIN, body: JSON.stringify([{
        name: 'linear-agent-session', events: ['worker-a/AgentSessionEvent.created', 'worker-a/AgentSessionEvent.prompted'],
        prompt: 'Linear agent session {action} ({agentSession.id})', skills: [], deliver: 'log', enabled: true,
      }]) });
      expect(response.status).toBe(200);
    });

    it('accepts created with 200, only agent-prefixed event types, and linear:<delivery> key; duplicate does not enqueue twice', async () => {
      const first = await post(created, 'agent-created');
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ status: 'accepted', eventKey: 'linear:agent-created' });
      const duplicate = await post(created, 'agent-created');
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toEqual({ status: 'duplicate', eventKey: 'linear:agent-created' });
      expect(await waitFor(() => eventTypes('agent-created'))).toEqual([
        'worker-a/AgentSessionEvent', 'worker-a/AgentSessionEvent.created',
      ]);
      const deliveries = await waitFor(async () => {
        const response = await call('/admin/deliveries', { headers: ADMIN });
        const { deliveries: list } = (await response.json()) as { deliveries: { sourceDeliveryId: string; event: string }[] };
        return list.some((d) => d.sourceDeliveryId === 'linear:agent-created') ? list : null;
      });
      expect(deliveries.filter((d) => d.sourceDeliveryId === 'linear:agent-created')).toEqual([
        expect.objectContaining({ event: 'worker-a/AgentSessionEvent.created' }),
      ]);
    });

    it('rejects a payload signed with the workspace secret', async () => {
      const response = await post(created, 'agent-workspace-signature', LINEAR_SECRET);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ reason: 'bad_signature' });
      expect(await env.EVENT_STORE.get('event:linear:agent-workspace-signature')).toBeNull();
    });

    it('rejects a timestamp 301 seconds old but accepts 299 seconds old', async () => {
      const old = await post({ ...created, webhookTimestamp: Date.now() - 301_000 }, 'agent-old');
      expect(old.status).toBe(401);
      expect(await old.json()).toMatchObject({ reason: 'stale_timestamp' });
      expect((await post({ ...created, webhookTimestamp: Date.now() - 299_000 }, 'agent-fresh')).status).toBe(200);
    });

    it('marks prompted with only agent-prefixed types', async () => {
      const response = await post(prompted, 'agent-prompted');
      expect(response.status).toBe(200);
      expect(await waitFor(() => eventTypes('agent-prompted'))).toEqual([
        'worker-a/AgentSessionEvent', 'worker-a/AgentSessionEvent.prompted',
      ]);
    });

    it('does not let the agent secret fabricate workspace events (Issue.created stays unmatched)', async () => {
      const payload = { type: 'Issue', action: 'create', data: { identifier: 'ABC-1', title: 'forged' } };
      expect((await post(payload, 'agent-forged-issue')).status).toBe(200);
      const types = await waitFor(() => eventTypes('agent-forged-issue'));
      expect(types).toEqual(['worker-a/Issue', 'worker-a/Issue.create', 'worker-a/Issue.created']);
      expect(matchSubscriptions(DEFAULT_SUBSCRIPTIONS, types, payload).map(({ sub }) => sub.name)).not.toContain('linear-issue-synced');
    });

    it('keeps POST /linear at 202', async () => {
      expect((await signedLinear({ type: 'Issue', action: 'create', data: {} }, 'workspace-still-202')).status).toBe(202);
    });
  });
});

describe('linear adapter eventTypes validation', () => {
  const types = (payload: unknown) => linear.eventTypes(new Headers(), payload);

  it('keeps emitting the workspace types for a valid type and action', () => {
    expect(types({ type: 'Issue', action: 'create' })).toEqual(['Issue', 'Issue.create', 'Issue.created']);
    expect(types({ type: 'Issue', action: 'update', updatedFrom: { assigneeId: 'x' } })).toContain('Issue.assigned');
    expect(types({ type: 'Issue' })).toEqual(['Issue']);
  });

  it('returns no types for an invalid type or action', () => {
    expect(types({ type: 'worker-a/AgentSessionEvent', action: 'created' })).toEqual([]);
    expect(types({ type: 'issue', action: 'create' })).toEqual([]);
    expect(types({ type: 'Issue', action: 'worker-a/created' })).toEqual([]);
    expect(types({ type: 'Issue', action: 'Create' })).toEqual([]);
    expect(types({ type: 'Issue', action: 7 })).toEqual([]);
  });

  it('POST /linear with the workspace secret cannot forge an agent-prefixed label', async () => {
    await adminSetSecrets({ LINEAR_WEBHOOK_SECRET: LINEAR_SECRET });
    const response = await signedLinear({ type: 'worker-a/AgentSessionEvent', action: 'created' }, 'workspace-forged-agent');
    expect(response.status).toBe(202);
    const stored = await waitFor(() => eventTypes('workspace-forged-agent'));
    expect(stored.some((type) => type.includes('/'))).toBe(false);
    expect(stored).toEqual([]);
  });
});
