import type { OAuthStore } from './durable-objects/oauth-store';
import type { Hub } from './hub/hub';

export type ServiceName = 'github' | 'linear' | 'stripe' | 'slack';
export const SERVICES: readonly ServiceName[] = ['github', 'linear', 'stripe', 'slack'];

export type OAuthService = 'linear' | 'slack';
export const OAUTH_SERVICES: readonly OAuthService[] = ['linear', 'slack'];

/** Message on a per-service queue: one verified, deduplicated webhook. */
export interface EventMessage {
  kind: 'event';
  service: ServiceName;
  /** `${service}:${providerDeliveryId}`; the dedupe key. */
  eventKey: string;
  deliveryId: string;
  eventTypes: string[];
  payload: unknown;
  receivedAt: string;
}

/** Message on HERMES_QUEUE: one delivery to be stored for the poller. */
export interface DeliveryMessage {
  kind: 'delivery';
  delivery: HermesDelivery;
}

export type QueueMessageBody = EventMessage | DeliveryMessage;

export type DeliveryStatus = 'pending' | 'processing' | 'delivered' | 'failed' | 'dead-letter';

export interface HermesDelivery {
  deliveryId: string;
  subscriptionName: string;
  event: string;
  prompt: string;
  skills: string[];
  deliver: string;
  deliverChatId?: string;
  filterScript?: string;
  /** Copied from the subscription: only the poller sending this `X-Hermes-Consumer` may claim it. Absent = any consumer. */
  consumer?: string;
  payload: unknown;
  sourceDeliveryId: string;
  createdAt: string;
  attempts: number;
  maxAttempts: number;
  status: DeliveryStatus;
}

export interface Subscription {
  name: string;
  events: string[];
  prompt: string;
  skills: string[];
  deliver: string;
  deliverChatId?: string;
  filterScript?: string;
  /** Optional: only the poller that sends this `X-Hermes-Consumer` may claim the deliveries; without it any consumer may. Routing, not authorization. */
  consumer?: string;
  /**
   * Optional payload filter: every `path` must hold a string/number/boolean that matches one of its
   * glob patterns (`*` = any run of characters, anchored). Lets a subscription take only `review/*`
   * checks, or only comments that start with a command, without code running in the Worker.
   */
  match?: Record<string, string[]>;
  enabled: boolean;
}

/** Names that can be stored (encrypted) in the Durable Object by the /setup wizard. */
export const STORABLE_SECRETS = [
  'GITHUB_WEBHOOK_SECRET',
  'LINEAR_WEBHOOK_SECRET',
  'STRIPE_WEBHOOK_SECRET',
  'SLACK_SIGNING_SECRET',
  'HERMES_WEBHOOK_SECRET',
  'LINEAR_CLIENT_ID',
  'LINEAR_CLIENT_SECRET',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
] as const;
export type StorableSecret = (typeof STORABLE_SECRETS)[number] | `LINEAR_WEBHOOK_SECRET_${string}`;
export const isStorableSecret = (name: string): name is StorableSecret =>
  (STORABLE_SECRETS as readonly string[]).includes(name) || /^LINEAR_WEBHOOK_SECRET_[A-Z][A-Z0-9_]*$/.test(name);

export interface Env {
  [key: string]: unknown;
  EVENT_STORE: KVNamespace;
  DB: D1Database;
  OAUTH_STORE: DurableObjectNamespace<OAuthStore>;
  HUB: DurableObjectNamespace<Hub>;
  EVENT_QUEUE_GITHUB: Queue<EventMessage>;
  EVENT_QUEUE_LINEAR: Queue<EventMessage>;
  EVENT_QUEUE_STRIPE: Queue<EventMessage>;
  EVENT_QUEUE_SLACK: Queue<EventMessage>;
  HERMES_QUEUE: Queue<DeliveryMessage>;

  /** Worker secrets. Each webhook/OAuth secret may instead live encrypted in the Durable Object. */
  ADMIN_TOKEN?: string;
  OAUTH_ENCRYPTION_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  LINEAR_WEBHOOK_SECRET?: string;
  LINEAR_TEAM_KEYS?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  HERMES_WEBHOOK_SECRET?: string;
  LINEAR_CLIENT_ID?: string;
  LINEAR_CLIENT_SECRET?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;

  /** Plain vars (wrangler.jsonc "vars"). All optional. */
  PUBLIC_URL?: string;
  HERMES_LONG_POLL_MS?: string;
  HERMES_LEASE_SECONDS?: string;
  MAX_ATTEMPTS?: string;
  LINEAR_OAUTH_SCOPES?: string;
  LINEAR_OAUTH_ACTOR?: string;
  SLACK_OAUTH_SCOPES?: string;
  /** JSON: { "<service>": { "authorizeUrl"?, "tokenUrl"?, "revokeUrl"? } }. For tests and self-hosted providers. */
  OAUTH_PROVIDER_OVERRIDES?: string;
}

export function intVar(value: string | undefined, fallback: number): number {
  const n = value === undefined || value === '' ? NaN : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
