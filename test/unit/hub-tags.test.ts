import { describe, expect, it } from 'vitest';
import { deriveTags, matchesAnyFilter, parseSubscription } from '../../src/hub/tags';

const push = (ref: string, messages: string[] = []) => ({
  ref,
  repository: { name: 'Infra' },
  commits: messages.map((message) => ({ message })),
});

describe('deriveTags: tags come from the payload, lowercased', () => {
  it('does not derive task tags without configured team keys; accepts listed keys only', () => {
    const payload = push('refs/heads/feature/ABC-123', ['XYZ-2']);
    expect(deriveTags('github', ['push'], payload, '')).not.toContain('linear:abc-123');
    expect(deriveTags('github', ['push'], payload, 'abc, invalid-key, XYZ')).toEqual(expect.arrayContaining(['linear:abc-123', 'linear:xyz-2']));
    expect(deriveTags('github', ['push'], payload, 'xyz')).not.toContain('linear:abc-123');
  });
  it('push on a branch: source, type, repo and ref', () => {
    expect(deriveTags('github', ['push'], push('refs/heads/Main'))).toEqual(['source:github', 'type:push', 'repo:infra', 'ref:main']);
  });

  it('accepts any branch, even an unexpected one, and keeps its slashes', () => {
    expect(deriveTags('github', ['push'], push('refs/heads/weird/x'))).toContain('ref:weird/x');
  });

  it('a tag push has no ref tag (ref is a branch)', () => {
    expect(deriveTags('github', ['push'], push('refs/tags/v1'))).toEqual(['source:github', 'type:push', 'repo:infra']);
  });

  it('pull_request: ref is the head branch; also workflow_run and check_run', () => {
    const pr = { repository: { name: 'infra' }, pull_request: { title: 'x', head: { ref: 'fix/y' } } };
    expect(deriveTags('github', ['pull_request', 'pull_request.opened'], pr)).toEqual(['source:github', 'type:pull_request', 'repo:infra', 'ref:fix/y']);
    expect(deriveTags('github', ['workflow_run'], { repository: { name: 'infra' }, workflow_run: { head_branch: 'main' } })).toContain('ref:main');
    expect(deriveTags('github', ['check_run'], { repository: { name: 'infra' }, check_run: { check_suite: { head_branch: 'dev' } } })).toContain('ref:dev');
  });

  it('linear:abc-N from the branch name, in lowercase', () => {
    expect(deriveTags('github', ['push'], push('refs/heads/feature/ABC-123-foo'), 'abc')).toContain('linear:abc-123');
  });

  it('linear:abc-N from the PR title and body, several at once, without duplicates', () => {
    const pr = { repository: { name: 'infra' }, pull_request: { title: '[ABC-123] fix', body: 'also abc-9 and ABC-123 again', head: { ref: 'x' } } };
    const tags = deriveTags('github', ['pull_request'], pr, 'abc').filter((t) => t.startsWith('linear:'));
    expect(tags.sort()).toEqual(['linear:abc-123', 'linear:abc-9']);
  });

  it('linear:abc-N from push commit messages', () => {
    const tags = deriveTags('github', ['push'], push('refs/heads/main', ['[ABC-7] a', 'b', 'ABC-8: c']), 'abc');
    expect(tags).toEqual(expect.arrayContaining(['linear:abc-7', 'linear:abc-8']));
  });

  it('an event with no ABC-N generates no linear tag; nabc-12 is not ABC-12', () => {
    expect(deriveTags('github', ['push'], push('refs/heads/nabc-12', ['bump nabc-3']), 'abc').some((t) => t.startsWith('linear:'))).toBe(false);
  });

  it('a Linear issue event tags its identifier; a comment reads the identifier of its issue', () => {
    expect(deriveTags('linear', ['Issue', 'Issue.update'], { type: 'Issue', data: { identifier: 'ABC-123' } }, 'abc')).toEqual(['source:linear', 'type:issue', 'linear:abc-123']);
    expect(deriveTags('linear', ['Comment'], { data: { issue: { identifier: 'ABC-3' } } }, 'abc')).toContain('linear:abc-3');
  });

  it('garbage payloads still yield source and type', () => {
    expect(deriveTags('github', ['ping'], null)).toEqual(['source:github', 'type:ping']);
    expect(deriveTags('github', [], 'x')).toEqual(['source:github']);
  });
});

describe('matchesAnyFilter: AND inside a filter, OR between filters, one-level glob on the value', () => {
  const tags = ['source:github', 'type:push', 'repo:infra', 'ref:release/1.2', 'linear:abc-123'];

  it('AND between the tags of one filter', () => {
    expect(matchesAnyFilter([['repo:infra', 'ref:release/1.2']], tags)).toBe(true);
    expect(matchesAnyFilter([['repo:infra', 'ref:main']], tags)).toBe(false);
  });

  it('OR between filters', () => {
    expect(matchesAnyFilter([['repo:infra', 'ref:main'], ['linear:abc-123']], tags)).toBe(true);
    expect(matchesAnyFilter([['repo:infra', 'ref:main'], ['linear:abc-1']], tags)).toBe(false);
  });

  it('glob in the value: repo:* and ref:release/*', () => {
    expect(matchesAnyFilter([['repo:*']], tags)).toBe(true);
    expect(matchesAnyFilter([['ref:release/*']], tags)).toBe(true);
    expect(matchesAnyFilter([['ref:hotfix/*']], tags)).toBe(false);
  });

  it('the key is literal and the match is anchored', () => {
    expect(matchesAnyFilter([['re*:infra']], tags)).toBe(false);
    expect(matchesAnyFilter([['repo:inf']], tags)).toBe(false);
    expect(matchesAnyFilter([['repo:infra']], ['repo:infra-x'])).toBe(false);
  });

  it('no filters or an empty filter match nothing; an event without the key does not match', () => {
    expect(matchesAnyFilter([], tags)).toBe(false);
    expect(matchesAnyFilter([[]], tags)).toBe(false);
    expect(matchesAnyFilter([['ref:*']], ['source:linear', 'type:issue'])).toBe(false);
  });
});

describe('parseSubscription: consumer and filters from the /ws query string', () => {
  const q = (s: string) => new URLSearchParams(s);

  it('normalizes to lowercase; a filter is a comma list of tags', () => {
    expect(parseSubscription(q('consumer=host-1&filter=Repo:Infra,ref:main&filter=linear:ABC-123'))).toEqual({
      ok: true,
      consumer: 'host-1',
      filters: [['repo:infra', 'ref:main'], ['linear:abc-123']],
    });
  });

  it.each([
    ['no consumer', 'filter=repo:infra'],
    ['bad consumer', 'consumer=Host_1&filter=repo:infra'],
    ['no filter', 'consumer=host-1'],
    ['tag without key:value', 'consumer=host-1&filter=infra'],
    ['empty filter', 'consumer=host-1&filter='],
    ['too many filters', `consumer=host-1${'&filter=repo:a'.repeat(21)}`],
    ['too many tags in a filter', `consumer=host-1&filter=${Array.from({ length: 9 }, (_, i) => `a:${i}`).join(',')}`],
    ['filters bigger than the 2 KiB socket attachment', `consumer=host-1${Array.from({ length: 20 }, (_, i) => `&filter=repo:${String(i).repeat(80)}`).join('')}`],
  ])('rejects: %s', (_name, query) => {
    expect(parseSubscription(q(query)).ok).toBe(false);
  });
});
