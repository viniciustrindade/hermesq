import { beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../../src/utils/hmac';
import checkCompleted from '../fixtures/github/check_run.completed.json';
import checkCreated from '../fixtures/github/check_run.created.json';
import codeScanningCreated from '../fixtures/github/code_scanning_alert.created.json';
import dependabotCreated from '../fixtures/github/dependabot_alert.created.json';
import issueComment from '../fixtures/github/issue_comment.created.json';
import reviewDismissed from '../fixtures/github/pull_request_review.dismissed.json';
import reviewSubmitted from '../fixtures/github/pull_request_review.submitted.json';
import reviewRequested from '../fixtures/github/pull_request.review_requested.json';
import secretScanningReopened from '../fixtures/github/secret_scanning_alert.reopened.json';
import workflowRunCompleted from '../fixtures/github/workflow_run.completed.json';
import { GITHUB_VECTOR } from '../fixtures/providers';
import { adminSetSecrets, call, collect, env, HERMES_SECRET, waitFor } from './helpers';

/**
 * GitHub service (POST /github) with payloads GitHub really sent, recorded by octokit/webhooks
 * (test/fixtures/github/README.md). A test only overrides the fields a review flow keys on (check name,
 * status, comment body), and says so.
 */
type Json = Record<string, unknown>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function withCheck(fixture: Json, check: Json): Json {
  const p = clone(fixture);
  p.check_run = { ...(p.check_run as Json), ...check };
  return p;
}

function withComment(body: string, onPullRequest: boolean): Json {
  const p = clone(issueComment) as Json;
  p.comment = { ...(p.comment as Json), body };
  const issue = { ...(p.issue as Json) };
  if (onPullRequest) issue.pull_request = { url: 'https://api.github.com/repos/Codertocat/Hello-World/pulls/1' };
  else delete issue.pull_request;
  p.issue = issue;
  return p;
}

async function sendGithub(event: string, delivery: string, payload: unknown, secret = GITHUB_VECTOR.secret) {
  const raw = JSON.stringify(payload);
  return call('/github', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': `sha256=${await hmacSha256Hex(secret, raw)}` },
    body: raw,
  });
}

/** Waits until the consumer recorded the event, then returns its status (routed | no-match). */
async function routedStatus(eventKey: string) {
  const rec = await waitFor(async () => {
    const v = (await env.EVENT_STORE.get(`event:${eventKey}`, 'json')) as { status: string; deliveries: string[] } | null;
    return v && v.status !== 'queued' ? v : null;
  });
  return rec;
}

beforeAll(async () => {
  await adminSetSecrets({ HERMES_WEBHOOK_SECRET: HERMES_SECRET });
});

describe('POST /github: signature and dedupe', () => {
  it('rejects a recorded payload whose signature was made with another secret, or that has none', async () => {
    const bad = await sendGithub('check_run', 'gh-bad', checkCreated, 'not-the-secret');
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ reason: 'bad_signature' });
    const none = await call('/github', { method: 'POST', headers: { 'x-github-event': 'check_run', 'x-github-delivery': 'gh-none' }, body: JSON.stringify(checkCreated) });
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ reason: 'missing_signature' });
  });

  it('a redelivery with the same X-GitHub-Delivery answers duplicate and creates no second delivery', async () => {
    const payload = withCheck(checkCreated, { name: 'review/bot-b' });
    const first = await sendGithub('check_run', 'gh-dup', payload);
    expect(first.status).toBe(202);
    const again = await sendGithub('check_run', 'gh-dup', payload);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: 'duplicate', eventKey: 'github:gh-dup' });
    const rec = await routedStatus('github:gh-dup');
    expect(rec.deliveries).toHaveLength(1);
  });
});

describe('github-* default subscriptions', () => {
  it('check_run created queued for review/<agent> → github-check-queued delivery with the check in the payload', async () => {
    // Recorded payload; name set to what the request-review workflow creates (status is already queued).
    const payload = withCheck(checkCreated, { name: 'review/bot-b', external_id: 'Codertocat/Hello-World#2@ec26c3e57ca3a959ca5aad62de7213c562f8c821' });
    expect((payload.check_run as Json).status).toBe('queued');
    expect((await sendGithub('check_run', 'gh-q1', payload)).status).toBe(202);
    const d = (await collect(['github:gh-q1']))['github:gh-q1']!;
    expect(d).toMatchObject({ subscriptionName: 'github-check-queued', event: 'check_run.created' });
    expect((d.payload as Json).check_run).toMatchObject({ name: 'review/bot-b', status: 'queued', head_sha: 'ec26c3e57ca3a959ca5aad62de7213c562f8c821' });
    expect(d.prompt).toContain('review/bot-b');
    expect(d.prompt).not.toContain('Codertocat/Hello-World#2@'); // F3: external_id is attacker-shaped text, never in the prompt
    expect(d.prompt).not.toContain('External id');
  });

  it('a CI check (the recorded Octocoders-linter) created or completed creates no delivery', async () => {
    expect((await sendGithub('check_run', 'gh-ci1', checkCreated)).status).toBe(202);
    expect((await sendGithub('check_run', 'gh-ci2', checkCompleted)).status).toBe(202);
    expect(await routedStatus('github:gh-ci1')).toMatchObject({ status: 'no-match', deliveries: [] });
    expect(await routedStatus('github:gh-ci2')).toMatchObject({ status: 'no-match', deliveries: [] });
  });

  it('check_run completed for review/bot-a → github-check-completed (the gate update)', async () => {
    const payload = withCheck(checkCompleted, { name: 'review/bot-a' });
    expect((payload.check_run as Json).conclusion).toBe('success');
    expect((await sendGithub('check_run', 'gh-c1', payload)).status).toBe(202);
    const d = (await collect(['github:gh-c1']))['github:gh-c1']!;
    expect(d).toMatchObject({ subscriptionName: 'github-check-completed', event: 'check_run.completed' });
    expect(d.prompt).toBe('Check review/bot-a: success\nSHA: ec26c3e57ca3a959ca5aad62de7213c562f8c821');
  });

  it('a review check created already in_progress (someone took it) does not ask for a review', async () => {
    const payload = withCheck(checkCreated, { name: 'review/bot-b', status: 'in_progress' });
    expect((await sendGithub('check_run', 'gh-ip', payload)).status).toBe(202);
    expect(await routedStatus('github:gh-ip')).toMatchObject({ status: 'no-match' });
  });

  it('a queued review check that is not "created" (e.g. rerequested) does not open a second review', async () => {
    const payload = withCheck(checkCreated, { name: 'review/bot-b' });
    payload.action = 'rerequested';
    expect((await sendGithub('check_run', 'gh-rr', payload)).status).toBe(202);
    expect(await routedStatus('github:gh-rr')).toMatchObject({ status: 'no-match' });
  });

  it('pull_request review_requested (recorded) → github-pr-review-requested with the reviewer', async () => {
    expect((await sendGithub('pull_request', 'gh-rq', reviewRequested)).status).toBe(202);
    const d = (await collect(['github:gh-rq']))['github:gh-rq']!;
    expect(d).toMatchObject({ subscriptionName: 'github-pr-review-requested', event: 'pull_request_review_requested' });
    expect(d.prompt).toBe('Review PR #2: Update the README with new information.\nRepo: Codertocat/Hello-World\nReviewer: octocat');
  });

  it('"/reviewer review" commented on a pull request → github-review-command', async () => {
    expect((await sendGithub('issue_comment', 'gh-cmd', withComment('/reviewer review', true))).status).toBe(202);
    const d = (await collect(['github:gh-cmd']))['github:gh-cmd']!;
    expect(d).toMatchObject({ subscriptionName: 'github-review-command', event: 'issue_comment.created' });
  });

  it.each(['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN'])('"/reviewer review" from author_association %s creates no delivery (B6)', async (assoc) => {
    const payload = withComment('/reviewer review', true);
    (payload.comment as Json).author_association = assoc;
    expect((await sendGithub('issue_comment', `gh-assoc-${assoc}`, payload)).status).toBe(202);
    expect(await routedStatus(`github:gh-assoc-${assoc}`)).toMatchObject({ status: 'no-match' });
  });

  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('"/reviewer review" from author_association %s creates the delivery (B6)', async (assoc) => {
    const payload = withComment('/reviewer review', true);
    (payload.comment as Json).author_association = assoc;
    expect((await sendGithub('issue_comment', `gh-assoc-ok-${assoc}`, payload)).status).toBe(202);
    const d = (await collect([`github:gh-assoc-ok-${assoc}`]))[`github:gh-assoc-ok-${assoc}`]!;
    expect(d).toMatchObject({ subscriptionName: 'github-review-command' });
  });

  it('a plain comment, or the command on an issue that is not a pull request, creates no delivery', async () => {
    expect((await sendGithub('issue_comment', 'gh-plain', issueComment)).status).toBe(202);
    expect((await sendGithub('issue_comment', 'gh-issue', withComment('/reviewer review', false))).status).toBe(202);
    expect(await routedStatus('github:gh-plain')).toMatchObject({ status: 'no-match' });
    expect(await routedStatus('github:gh-issue')).toMatchObject({ status: 'no-match' });
  });
});

describe('github-* default subscriptions: red CI, security alerts, PR reviews', () => {
  function withRun(run: Json): Json {
    const p = clone(workflowRunCompleted) as Json;
    p.workflow_run = { ...(p.workflow_run as Json), ...run };
    return p;
  }

  it('workflow_run completed with failure (recorded run, conclusion set to failure) → github-ci-failed', async () => {
    const payload = withRun({ conclusion: 'failure' });
    expect((payload.workflow_run as Json).head_repository).toMatchObject({ fork: false });
    expect((await sendGithub('workflow_run', 'gh-ci-red', payload)).status).toBe(202);
    const d = (await collect(['github:gh-ci-red']))['github:gh-ci-red']!;
    expect(d).toMatchObject({ subscriptionName: 'github-ci-failed', event: 'workflow_run.completed' });
    expect(d.prompt).toBe(
      'CI  failed on octo-org/octo-repo\nBranch: master\nSHA: 3484a3fb816e0859fd6e1cea078d76385ff50625\nRun: https://github.com/octo-org/octo-repo/actions/runs/289782451',
    );
  });

  it('the recorded green run, a cancelled run and a red run from a fork create no delivery', async () => {
    const fork = withRun({ conclusion: 'failure' });
    (fork.workflow_run as Json).head_repository = { ...((fork.workflow_run as Json).head_repository as Json), fork: true };
    expect((await sendGithub('workflow_run', 'gh-ci-green', workflowRunCompleted)).status).toBe(202);
    expect((await sendGithub('workflow_run', 'gh-ci-cancel', withRun({ conclusion: 'cancelled' }))).status).toBe(202);
    expect((await sendGithub('workflow_run', 'gh-ci-fork', fork)).status).toBe(202);
    for (const id of ['gh-ci-green', 'gh-ci-cancel', 'gh-ci-fork']) expect(await routedStatus(`github:${id}`)).toMatchObject({ status: 'no-match', deliveries: [] });
  });

  it('dependabot_alert created (recorded) → github-dependabot-alert; fixed creates no delivery', async () => {
    expect((await sendGithub('dependabot_alert', 'gh-dep', dependabotCreated)).status).toBe(202);
    const d = (await collect(['github:gh-dep']))['github:gh-dep']!;
    expect(d).toMatchObject({ subscriptionName: 'github-dependabot-alert', event: 'dependabot_alert.created' });
    expect(d.prompt).toBe('Dependabot alert #20 (medium) on wolfy1339/pika-pack: semver');
    const fixed = { ...clone(dependabotCreated), action: 'fixed' }; // action changed: the recorded alert was created
    expect((await sendGithub('dependabot_alert', 'gh-dep-fixed', fixed)).status).toBe(202);
    expect(await routedStatus('github:gh-dep-fixed')).toMatchObject({ status: 'no-match' });
  });

  it('code_scanning_alert created (recorded) → github-code-scanning-alert', async () => {
    expect((await sendGithub('code_scanning_alert', 'gh-cs', codeScanningCreated)).status).toBe(202);
    const d = (await collect(['github:gh-cs']))['github:gh-cs']!;
    expect(d).toMatchObject({ subscriptionName: 'github-code-scanning-alert', event: 'code_scanning_alert.created' });
    expect(d.prompt).toBe('Code scanning alert #10 (java/sql-injection) on Codertocat/Hello-World');
  });

  it('secret_scanning_alert: reopened (recorded) creates no delivery; created does, and the prompt never carries the secret', async () => {
    expect((await sendGithub('secret_scanning_alert', 'gh-ss-re', secretScanningReopened)).status).toBe(202);
    expect(await routedStatus('github:gh-ss-re')).toMatchObject({ status: 'no-match' });
    const created = clone(secretScanningReopened) as Json; // action changed to created; `secret` added as GitHub's API returns it
    created.action = 'created';
    created.alert = { ...(created.alert as Json), secret: 'value-that-must-not-leak' };
    expect((await sendGithub('secret_scanning_alert', 'gh-ss', created)).status).toBe(202);
    const d = (await collect(['github:gh-ss']))['github:gh-ss']!;
    expect(d).toMatchObject({ subscriptionName: 'github-secret-scanning-alert', event: 'secret_scanning_alert.created' });
    expect(d.prompt).toBe('Secret scanning alert #191 (adafruit_io_key) on Codertocat/Hello-World');
    expect(d.prompt).not.toContain('value-that-must-not-leak');
  });

  it('pull_request_review submitted and dismissed (recorded) → github-pr-review', async () => {
    expect((await sendGithub('pull_request_review', 'gh-prr-s', reviewSubmitted)).status).toBe(202);
    expect((await sendGithub('pull_request_review', 'gh-prr-d', reviewDismissed)).status).toBe(202);
    const got = await collect(['github:gh-prr-s', 'github:gh-prr-d']);
    expect(got['github:gh-prr-s']).toMatchObject({ subscriptionName: 'github-pr-review', event: 'pull_request_review.submitted' });
    expect(got['github:gh-prr-d']).toMatchObject({ subscriptionName: 'github-pr-review', event: 'pull_request_review.dismissed' });
    expect(got['github:gh-prr-s']!.prompt).toBe('Review commented on Codertocat/Hello-World#2 by Codertocat');
  });
});
