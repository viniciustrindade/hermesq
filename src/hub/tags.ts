import { globMatches } from '../subscriptions/matcher';
import type { ServiceName } from '../types';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const at = (v: unknown, ...path: string[]): unknown => path.reduce<unknown>((cur, key) => obj(cur)[key], v);

/** Only configured team keys may produce a task tag. */
function taskPattern(keys: string | undefined): RegExp | null {
  const valid = (keys ?? '').split(',').map((key) => key.trim().toLowerCase()).filter((key) => /^[a-z][a-z0-9]{0,9}$/.test(key));
  return valid.length ? new RegExp(`(?<![a-z0-9])(?:${valid.join('|')})-\\d+`, 'gi') : null;
}
const BRANCH_PREFIX = 'refs/heads/';

/** Where a GitHub payload keeps the branch an event is about (a tag push has none). */
function branchOf(payload: unknown): string | undefined {
  const pushed = str(at(payload, 'ref'));
  if (pushed) return pushed.startsWith(BRANCH_PREFIX) ? pushed.slice(BRANCH_PREFIX.length) : undefined;
  return str(at(payload, 'pull_request', 'head', 'ref')) ?? str(at(payload, 'workflow_run', 'head_branch')) ?? str(at(payload, 'check_run', 'check_suite', 'head_branch'));
}

/** Free text of the payload that names a Linear task: branch, PR title/body, commit messages, Linear's own identifiers. */
function taskTexts(service: ServiceName, payload: unknown, branch: string | undefined): unknown[] {
  if (service === 'linear') return [at(payload, 'data', 'identifier'), at(payload, 'data', 'issue', 'identifier')];
  const commits = at(payload, 'commits');
  const messages = Array.isArray(commits) ? commits.map((c) => at(c, 'message')) : [];
  return [branch, at(payload, 'pull_request', 'title'), at(payload, 'pull_request', 'body'), at(payload, 'head_commit', 'message'), ...messages];
}

/**
 * Tags of an event, lowercase `key:value`: source, type (first event type), repo and ref when the payload has them,
 * and one `linear:abc-N` per task mentioned if the team key is configured. The hub accepts any branch: filtering is the subscriber's job.
 */
export function deriveTags(service: ServiceName, eventTypes: string[], payload: unknown, teamKeys?: string): string[] {
  const tags = new Set<string>([`source:${service}`]);
  if (eventTypes[0]) tags.add(`type:${eventTypes[0]}`);
  const repo = str(at(payload, 'repository', 'name'));
  if (repo) tags.add(`repo:${repo}`);
  const branch = branchOf(payload);
  if (branch) tags.add(`ref:${branch}`);
  const pattern = taskPattern(teamKeys);
  for (const text of taskTexts(service, payload, branch)) {
    for (const task of typeof text === 'string' && pattern ? (text.match(pattern) ?? []) : []) tags.add(`linear:${task}`);
  }
  return [...tags].map((t) => t.toLowerCase());
}

/** One filter = tags that must all match (AND); the subscriber gets the event when any filter matches (OR). `*` in the value is a glob. */
export function matchesAnyFilter(filters: string[][], tags: string[]): boolean {
  return filters.some((filter) => filter.length > 0 && filter.every((pattern) => tagMatches(pattern, tags)));
}

function tagMatches(pattern: string, tags: string[]): boolean {
  const cut = pattern.indexOf(':');
  const key = pattern.slice(0, cut);
  const value = pattern.slice(cut + 1);
  return tags.some((tag) => tag.startsWith(`${key}:`) && globMatches(value, tag.slice(key.length + 1)));
}

const CONSUMER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TAG = /^[a-z][a-z0-9_-]{0,31}:[^\s,]{1,200}$/;
export const MAX_FILTERS = 20;
export const MAX_TAGS_PER_FILTER = 8;
/** A hibernatable socket keeps its state in an attachment of at most 2048 bytes; the filters get most of it. */
export const MAX_FILTERS_JSON = 1800;

export type Subscription = { ok: true; consumer: string; filters: string[][] } | { ok: false; reason: string };

/** `?consumer=<name>&filter=repo:infra,ref:main&filter=linear:abc-123`: every `filter` is one comma list of tags. */
export function parseSubscription(query: URLSearchParams): Subscription {
  const consumer = query.get('consumer')?.toLowerCase() ?? '';
  if (!CONSUMER.test(consumer)) return { ok: false, reason: 'invalid_consumer' };
  const raw = query.getAll('filter');
  if (raw.length === 0 || raw.length > MAX_FILTERS) return { ok: false, reason: 'invalid_filters' };
  const filters = raw.map((f) => f.toLowerCase().split(','));
  const valid = filters.every((f) => f.length <= MAX_TAGS_PER_FILTER && f.every((t) => TAG.test(t)));
  if (!valid || JSON.stringify(filters).length > MAX_FILTERS_JSON) return { ok: false, reason: 'invalid_filters' };
  return { ok: true, consumer, filters };
}
