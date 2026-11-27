import { type Context, Hono } from 'hono';
import { clearSecretCache, oauthStore } from '../secrets';
import { type Env, OAUTH_SERVICES, type OAuthService, SERVICES, STORABLE_SECRETS, isStorableSecret } from '../types';
import { requireAdmin } from './admin';
import { setupPage } from './setup-page';

type C = Context<{ Bindings: Env }>;

export function publicBase(c: C): string {
  return (c.env.PUBLIC_URL || new URL(c.req.url).origin).replace(/\/+$/, '');
}
export const redirectUri = (c: C) => `${publicBase(c)}/oauth/callback`;

function serviceParam(c: C, fromBody?: unknown): OAuthService | null {
  const s = (typeof fromBody === 'string' ? fromBody : undefined) ?? c.req.query('service');
  return s && (OAUTH_SERVICES as readonly string[]).includes(s) ? (s as OAuthService) : null;
}

const badService = (c: C) => c.json({ error: 'invalid_service', expected: OAUTH_SERVICES }, 400);

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// ---- /setup -------------------------------------------------------------------------------------

export const setup = new Hono<{ Bindings: Env }>();

setup.get('/', (c) => c.html(setupPage()));

setup.get('/state', requireAdmin, async (c) => {
  const store = oauthStore(c.env);
  const stored = new Set(await store.storedSecretNames());
  const secrets = [...new Set([...STORABLE_SECRETS, ...stored])].map((name) => ({
    name,
    source: typeof c.env[name] === 'string' && c.env[name] ? 'worker-secret' : stored.has(name) ? 'setup' : null,
  }));
  const base = publicBase(c);
  return c.json({
    secrets,
    oauth: await store.health(),
    encryptionKey: await store.encryptionKeySource(),
    urls: {
      ...Object.fromEntries(SERVICES.map((s) => [s, `${base}/${s}`])),
      oauthCallback: redirectUri(c),
      hermes: base,
    },
  });
});

setup.post('/secrets', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, string> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'invalid_json' }, 400);
  for (const [name, value] of Object.entries(body)) {
    if (!isStorableSecret(name)) return c.json({ error: 'invalid_secret', detail: `unknown secret: ${name}` }, 400);
    if (typeof value !== 'string') return c.json({ error: 'invalid_secret', detail: `secret ${name} must be a string` }, 400);
  }
  try {
    const saved = await oauthStore(c.env).setSecrets(body);
    clearSecretCache();
    return c.json({ saved });
  } catch (err) {
    return c.json({ error: 'invalid_secret', detail: (err as Error).message }, 400);
  }
});

setup.post('/generate', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  if (body.name !== 'HERMES_WEBHOOK_SECRET') return c.json({ error: 'only HERMES_WEBHOOK_SECRET can be generated' }, 400);
  const value = await oauthStore(c.env).generateSecret(body.name);
  clearSecretCache();
  return c.json({ name: body.name, value });
});

setup.post('/start', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { service?: string };
  const service = serviceParam(c, body.service);
  if (!service) return badService(c);
  const res = await oauthStore(c.env).startAuth(service, redirectUri(c));
  return res.ok ? c.json({ authorizeUrl: res.authorizeUrl }) : c.json({ error: res.error }, 400);
});

// ---- /oauth -------------------------------------------------------------------------------------

export const oauth = new Hono<{ Bindings: Env }>();

/** Provider redirect target. Public: the single-use `state` (10 min) is what ties it to /setup/start. */
oauth.get('/callback', async (c) => {
  const { code, state, error } = c.req.query();
  const page = (title: string, detail: string, status: 200 | 400) =>
    c.html(
      `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;max-width:40rem;margin:3rem auto"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><p><a href="/setup">Back to setup</a></p></body>`,
      status,
    );
  if (error) return page('Authorization refused', String(error), 400);
  if (!code || !state) return page('Missing code or state', 'Start again from /setup.', 400);
  const res = await oauthStore(c.env).completeAuth(state, code);
  if (!res.ok) return page('Connection failed', res.description ? `${res.error}: ${res.description}` : res.error, 400);
  return page('Connected', `${res.service} is connected.`, 200);
});

oauth.use('/status', requireAdmin);
oauth.use('/health', requireAdmin);
oauth.use('/refresh', requireAdmin);
oauth.use('/disconnect', requireAdmin);
oauth.use('/reconnect', requireAdmin);

oauth.get('/status', async (c) => c.json(await oauthStore(c.env).status()));

oauth.get('/health', async (c) => c.json({ services: await oauthStore(c.env).health() }));

oauth.post('/refresh', async (c) => {
  const service = serviceParam(c);
  if (!service) return badService(c);
  const store = oauthStore(c.env);
  if (!(await store.status()).connected.includes(service)) return c.json({ error: 'not_connected' }, 404);
  const health = await store.refresh(service);
  return c.json(health, health.last_refresh_error ? 502 : 200);
});

oauth.post('/disconnect', async (c) => {
  const service = serviceParam(c);
  if (!service) return badService(c);
  return c.json(await oauthStore(c.env).disconnect(service));
});

oauth.post('/reconnect', async (c) => {
  const service = serviceParam(c);
  if (!service) return badService(c);
  const res = await oauthStore(c.env).reconnect(service, redirectUri(c));
  return res.ok ? c.json({ authorizeUrl: res.authorizeUrl }) : c.json({ error: res.error }, 400);
});
