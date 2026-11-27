import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SUBSCRIPTIONS } from '../../src/subscriptions/defaults';
import { globMatches, matchSubscriptions } from '../../src/subscriptions/matcher';
import { lookup, renderTemplate } from '../../src/subscriptions/renderer';
import { parseSubscriptions, SUBSCRIPTIONS_KEY } from '../../src/subscriptions/store';
import { ADMIN, call, env } from './helpers';

afterEach(async () => {
  await env.EVENT_STORE.delete(SUBSCRIPTIONS_KEY);
});

describe('prompt rendering', () => {
  const payload = { pr: { number: 7, title: 'T', labels: [{ name: 'bug' }] }, user: null, n: 0 };
  it('interpolates nested paths, array indexes and the optional payload. prefix', () => {
    expect(renderTemplate('#{pr.number} {payload.pr.title} {pr.labels.0.name}', payload)).toBe('#7 T bug');
  });
  it('renders missing and null fields as empty, objects as JSON, and keeps falsy numbers', () => {
    expect(renderTemplate('[{nope.x}][{user}][{pr.labels}][{n}]', payload)).toBe('[][][[{"name":"bug"}]][0]');
  });
  it('does not walk into strings', () => {
    expect(lookup({ a: 'text' }, 'a.length')).toBeUndefined();
  });
});

describe('subscription matching', () => {
  const subs = parseSubscriptions([
    { name: 'a', events: ['Issue.created'], prompt: '' },
    { name: 'all', events: ['*'], prompt: '' },
    { name: 'off', events: ['Issue.created'], prompt: '', enabled: false },
  ]);
  it('matches by any event type the adapter derived, skips disabled ones, * matches everything', () => {
    expect(matchSubscriptions(subs, ['Issue', 'Issue.created']).map((m) => [m.sub.name, m.event])).toEqual([
      ['a', 'Issue.created'],
      ['all', 'Issue'],
    ]);
    expect(matchSubscriptions(subs, []).map((m) => m.sub.name)).toEqual([]);
  });
  it('the defaults cover the four services of the spec', () => {
    expect(DEFAULT_SUBSCRIPTIONS.map((s) => s.name)).toEqual([
      'github-pr-review-requested',
      'github-check-queued',
      'github-check-completed',
      'github-review-command',
      'github-ci-failed',
      'github-dependabot-alert',
      'github-code-scanning-alert',
      'github-secret-scanning-alert',
      'github-pr-review',
      'linear-issue-synced',
      'stripe-payment-succeeded',
      'slack-mention',
    ]);
  });
});

describe('payload match (declarative filter, no code from the Worker)', () => {
  const subs = parseSubscriptions([
    { name: 'review', events: ['check_run.created'], prompt: '', match: { 'check_run.name': 'review/*', 'check_run.status': 'queued' } },
    { name: 'either', events: ['check_run.created'], prompt: '', match: { 'check_run.name': ['ci', 'lint*'] } },
    { name: 'cmd', events: ['issue_comment.created'], prompt: '', match: { 'issue.pull_request.url': '*', 'comment.body': '/reviewer review*' } },
  ]);
  const names = (eventTypes: string[], payload: unknown) => matchSubscriptions(subs, eventTypes, payload).map((m) => m.sub.name);
  it('every path must match its glob (* = any run of characters, anchored at both ends)', () => {
    expect(names(['check_run.created'], { check_run: { name: 'review/bot-b', status: 'queued' } })).toEqual(['review']);
    expect(names(['check_run.created'], { check_run: { name: 'review/bot-b', status: 'in_progress' } })).toEqual([]);
    expect(names(['check_run.created'], { check_run: { name: 'xreview/bot-b', status: 'queued' } })).toEqual([]);
  });
  it('a list matches when any pattern does', () => {
    expect(names(['check_run.created'], { check_run: { name: 'lint-js' } })).toEqual(['either']);
    expect(names(['check_run.created'], { check_run: { name: 'ci' } })).toEqual(['either']);
    expect(names(['check_run.created'], { check_run: { name: 'cix' } })).toEqual([]);
  });
  it('a missing, null or object field never matches, not even *', () => {
    expect(names(['issue_comment.created'], { issue: {}, comment: { body: '/reviewer review' } })).toEqual([]);
    expect(names(['issue_comment.created'], { issue: { pull_request: { url: 'u' } }, comment: { body: '/reviewer review now' } })).toEqual(['cmd']);
    expect(names(['issue_comment.created'], { issue: { pull_request: { url: 'u' } }, comment: { body: 'please /reviewer review' } })).toEqual([]);
    expect(names(['check_run.created'], { check_run: { name: { x: 1 }, status: 'queued' } })).toEqual([]);
  });
  it('regex metacharacters in a pattern are literal', () => {
    const [sub] = parseSubscriptions([{ name: 'lit', events: ['e'], prompt: '', match: { a: 'v1.0+(x)' } }]);
    expect(matchSubscriptions([sub!], ['e'], { a: 'v1.0+(x)' })).toHaveLength(1);
    expect(matchSubscriptions([sub!], ['e'], { a: 'v1x0+(x)' })).toHaveLength(0);
  });
  it('consecutive * collapse into one, so a long run of stars cannot blow up the match', () => {
    expect(globMatches('a***b', 'aXYb')).toBe(true);
    expect(globMatches('a***b', 'ab')).toBe(true);
    expect(globMatches('a***b', 'aXY')).toBe(false);
    const started = Date.now();
    expect(globMatches(`a${'*'.repeat(40)}b`, `a${'x'.repeat(3000)}`)).toBe(false); // 40 stacked `.*` would backtrack for ages
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it('a pattern with more than 8 * is refused, 8 is accepted', () => {
    const sub = (p: string) => [{ name: 'a', events: ['x'], prompt: '', match: { a: p } }];
    expect(() => parseSubscriptions(sub('*a*a*a*a*a*a*a*a*'))).toThrow('more than 8');
    expect(() => parseSubscriptions(sub('*a*a*a*a*a*a*a*a'))).not.toThrow();
    expect(() => parseSubscriptions(sub('**********'))).not.toThrow(); // a run counts as one
  });
  it('numbers and booleans compare by their string form', () => {
    const [sub] = parseSubscriptions([{ name: 'n', events: ['e'], prompt: '', match: { n: '7', b: 'true' } }]);
    expect(matchSubscriptions([sub!], ['e'], { n: 7, b: true })).toHaveLength(1);
  });
  it.each([
    [{ match: [] }, 'match must be an object'],
    [{ match: { a: 1 } }, 'match.a must be a string or a list of strings'],
    [{ match: { a: [] } }, 'match.a must be a string or a list of strings'],
    [{ match: { '': 'x' } }, 'match has an invalid path'],
  ])('rejects %j', (extra, message) => {
    expect(() => parseSubscriptions([{ name: 'a', events: ['x'], prompt: '', ...extra }])).toThrow(message);
  });
});

describe('subscription validation', () => {
  it.each([
    [{}, 'must be an array'],
    [[{ name: 'bad name!', events: ['x'], prompt: '' }], 'name is invalid'],
    [[{ name: 'a', events: [], prompt: '' }], 'events must not be empty'],
    [[{ name: 'a', events: ['x'] }], 'prompt must be a string'],
    [[{ name: 'a', events: ['x'], prompt: '', skills: [1] }], 'skills must be a list of strings'],
    [
      [
        { name: 'a', events: ['x'], prompt: '' },
        { name: 'a', events: ['y'], prompt: '' },
      ],
      'duplicate subscription name',
    ],
  ])('rejects %j', (input, message) => {
    expect(() => parseSubscriptions(input)).toThrow(message);
  });
  it.each(['A', 'UppercaseHost', '-a', 'a_b', 'a b', 'a'.repeat(65), 5, ['a']])('refuses consumer %j', (consumer) => {
    expect(() => parseSubscriptions([{ name: 'a', events: ['x'], prompt: 'p', consumer }])).toThrow(/a\.consumer (is invalid|must be a string)/);
  });
  it('keeps a valid consumer and leaves it out when absent or empty', () => {
    expect(parseSubscriptions([{ name: 'a', events: ['x'], prompt: 'p', consumer: '' }])[0]).not.toHaveProperty('consumer');
    expect(parseSubscriptions([{ name: 'a', events: ['x'], prompt: 'p', consumer: 'host-a' }])[0]).toMatchObject({ consumer: 'host-a' });
    expect(parseSubscriptions([{ name: 'a', events: ['x'], prompt: 'p', consumer: 'a'.repeat(64) }])[0]!.consumer).toBe('a'.repeat(64));
    expect(parseSubscriptions([{ name: 'a', events: ['x'], prompt: 'p' }])[0]).not.toHaveProperty('consumer');
  });
  it('fills defaults (deliver=log, enabled=true, no skills)', () => {
    expect(parseSubscriptions([{ name: 'a', events: ['x'], prompt: 'p' }])).toEqual([{ name: 'a', events: ['x'], prompt: 'p', skills: [], deliver: 'log', enabled: true }]);
  });
});

describe('admin subscriptions API (KV, no redeploy)', () => {
  it('GET returns the defaults until a list is saved; PUT validates and stores', async () => {
    const before = (await (await call('/admin/subscriptions', { headers: ADMIN })).json()) as { subscriptions: unknown[] };
    expect(before.subscriptions).toHaveLength(DEFAULT_SUBSCRIPTIONS.length);

    const bad = await call('/admin/subscriptions', { method: 'PUT', headers: ADMIN, body: JSON.stringify([{ name: 'x' }]) });
    expect(bad.status).toBe(400);

    const list = [{ name: 'only', events: ['app_mention'], prompt: '{event.text}', deliver: 'slack', deliverChatId: 'C1' }];
    const put = await call('/admin/subscriptions', { method: 'PUT', headers: ADMIN, body: JSON.stringify({ subscriptions: list }) });
    expect(put.status).toBe(200);
    expect(await env.EVENT_STORE.get(SUBSCRIPTIONS_KEY, 'json')).toEqual([{ ...list[0], skills: [], enabled: true }]);
    expect((await call('/admin/subscriptions', { method: 'PUT', body: '[]' })).status).toBe(401);
  });
});
