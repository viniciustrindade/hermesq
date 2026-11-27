import { DurableObject } from 'cloudflare:workers';
import { decryptString, encryptString, generateKeyMaterial, importAesKey } from '../oauth/crypto';
import { type OAuthTokens, parseTokenResponse, providerConfig, RECONNECT_ERRORS } from '../oauth/providers';
import { type Env, OAUTH_SERVICES, type OAuthService, isStorableSecret, type StorableSecret } from '../types';
import { randomToken } from '../utils/hmac';

/** Refresh when less than this share of the token lifetime is left (spec: proactive at 80% TTL). */
export const REFRESH_REMAINING_FRACTION = 0.2;
export const STATE_TTL_MS = 10 * 60 * 1000;

export interface TokenMeta {
  connected_at: number;
  last_refresh_at: number | null;
  last_refresh_error: string | null;
  needs_reconnect: boolean;
  refresh_count: number;
}

export interface TokenHealth {
  service: OAuthService;
  connected: boolean;
  expires_at: number | null;
  needs_refresh: boolean;
  needs_reconnect: boolean;
  last_refresh_at: number | null;
  last_refresh_error: string | null;
}

interface PendingState {
  service: OAuthService;
  redirectUri: string;
  createdAt: number;
}

export type AuthResult = { ok: true; service: OAuthService } | { ok: false; error: string; description?: string };

export function needsRefresh(t: Pick<OAuthTokens, 'expires_at' | 'obtained_at'>, now: number): boolean {
  if (!t.expires_at) return false;
  const lifetime = Math.max(0, t.expires_at - t.obtained_at);
  return now >= t.expires_at - lifetime * REFRESH_REMAINING_FRACTION;
}


/**
 * Single global instance (`idFromName('global')`). Holds OAuth tokens and the secrets typed into
 * /setup, all AES-GCM encrypted. The key is the OAUTH_ENCRYPTION_KEY Worker secret when set;
 * otherwise one is generated on first use and kept in this object's storage.
 */
export class OAuthStore extends DurableObject<Env> {
  private keys?: Promise<{ encrypt: CryptoKey; decrypt: CryptoKey[]; source: 'env' | 'generated' }>;
  private inflight = new Map<OAuthService, Promise<TokenHealth>>();

  private loadKeys() {
    this.keys ??= (async () => {
      const stored = await this.ctx.storage.get<string>('enc_key');
      const envKey = this.env.OAUTH_ENCRYPTION_KEY?.trim();
      if (envKey) {
        const k = await importAesKey(envKey);
        return { encrypt: k, decrypt: stored ? [k, await importAesKey(stored)] : [k], source: 'env' as const };
      }
      let material = stored;
      if (!material) {
        material = generateKeyMaterial();
        await this.ctx.storage.put('enc_key', material);
      }
      const k = await importAesKey(material);
      return { encrypt: k, decrypt: [k], source: 'generated' as const };
    })();
    return this.keys;
  }

  private async seal(value: unknown): Promise<string> {
    return encryptString((await this.loadKeys()).encrypt, JSON.stringify(value));
  }

  private async open<T>(data: string | undefined): Promise<T | undefined> {
    if (data === undefined) return undefined;
    for (const k of (await this.loadKeys()).decrypt) {
      try {
        return JSON.parse(await decryptString(k, data)) as T;
      } catch {
        // try the next key
      }
    }
    throw new Error('cannot decrypt stored value: OAUTH_ENCRYPTION_KEY changed?');
  }

  async encryptionKeySource(): Promise<'env' | 'generated'> {
    return (await this.loadKeys()).source;
  }

  // ---- secrets typed into /setup --------------------------------------------------------------

  async getSecret(name: string): Promise<string | null> {
    if (!isStorableSecret(name)) return null;
    return (await this.open<string>(await this.ctx.storage.get<string>(`secret:${name}`))) ?? null;
  }

  async setSecrets(values: Record<string, string>): Promise<string[]> {
    const saved: string[] = [];
    for (const [name, value] of Object.entries(values)) {
      if (!isStorableSecret(name)) throw new Error(`unknown secret: ${name}`);
      if (typeof value !== 'string') throw new Error(`secret ${name} must be a string`);
      if (value === '') await this.ctx.storage.delete(`secret:${name}`);
      else await this.ctx.storage.put(`secret:${name}`, await this.seal(value));
      saved.push(name);
    }
    return saved;
  }

  async storedSecretNames(): Promise<string[]> {
    const map = await this.ctx.storage.list({ prefix: 'secret:' });
    return [...map.keys()].map((k) => k.slice('secret:'.length));
  }

  /** Generates a random secret, stores it and returns it once (shown by the wizard). */
  async generateSecret(name: string): Promise<string> {
    if (!isStorableSecret(name)) throw new Error(`unknown secret: ${name}`);
    const value = randomToken(32);
    await this.setSecrets({ [name]: value });
    return value;
  }

  private async clientCredential(name: StorableSecret): Promise<string | null> {
    const fromEnv = this.env[name];
    if (typeof fromEnv === 'string' && fromEnv) return fromEnv;
    return this.getSecret(name);
  }

  // ---- OAuth flow ----------------------------------------------------------------------------

  async startAuth(service: OAuthService, redirectUri: string, now = Date.now()): Promise<{ ok: true; authorizeUrl: string } | { ok: false; error: string }> {
    const cfg = providerConfig(service, this.env);
    const clientId = await this.clientCredential(cfg.clientIdName);
    if (!clientId) return { ok: false, error: `missing_${cfg.clientIdName.toLowerCase()}` };
    const state = randomToken(16);
    await this.ctx.storage.put(`state:${state}`, { service, redirectUri, createdAt: now } satisfies PendingState);
    const url = new URL(cfg.authorizeUrl);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', cfg.scopes);
    url.searchParams.set('state', state);
    for (const [k, v] of Object.entries(cfg.authorizeParams)) url.searchParams.set(k, v);
    return { ok: true, authorizeUrl: url.toString() };
  }

  async completeAuth(state: string, code: string, now = Date.now()): Promise<AuthResult> {
    const key = `state:${state}`;
    const pending = await this.ctx.storage.get<PendingState>(key);
    if (!pending) return { ok: false, error: 'invalid_state' };
    await this.ctx.storage.delete(key); // single use
    if (now - pending.createdAt > STATE_TTL_MS) return { ok: false, error: 'expired_state' };

    const cfg = providerConfig(pending.service, this.env);
    const clientId = await this.clientCredential(cfg.clientIdName);
    const clientSecret = await this.clientCredential(cfg.clientSecretName);
    if (!clientId || !clientSecret) return { ok: false, error: 'missing_client_credentials' };
    const res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri, client_id: clientId, client_secret: clientSecret }),
    });
    const parsed = await parseTokenResponse(cfg, res, now);
    if (!parsed.ok) return parsed;
    await this.ctx.storage.put(`tokens:${pending.service}`, await this.seal(parsed.tokens));
    await this.ctx.storage.put(`meta:${pending.service}`, {
      connected_at: now,
      last_refresh_at: now,
      last_refresh_error: null,
      needs_reconnect: false,
      refresh_count: 0,
    } satisfies TokenMeta);
    return { ok: true, service: pending.service };
  }

  private async tokens(service: OAuthService): Promise<OAuthTokens | undefined> {
    return this.open<OAuthTokens>(await this.ctx.storage.get<string>(`tokens:${service}`));
  }

  private async meta(service: OAuthService): Promise<TokenMeta | undefined> {
    return this.ctx.storage.get<TokenMeta>(`meta:${service}`);
  }

  async status(): Promise<{ connected: OAuthService[] }> {
    const connected: OAuthService[] = [];
    for (const s of OAUTH_SERVICES) if ((await this.ctx.storage.get(`tokens:${s}`)) !== undefined) connected.push(s);
    return { connected };
  }

  async healthOf(service: OAuthService, now = Date.now()): Promise<TokenHealth> {
    const t = await this.tokens(service);
    const m = await this.meta(service);
    return {
      service,
      connected: t !== undefined,
      expires_at: t ? t.expires_at || null : null,
      needs_refresh: t ? needsRefresh(t, now) : false,
      needs_reconnect: m?.needs_reconnect ?? false,
      last_refresh_at: m?.last_refresh_at ?? null,
      last_refresh_error: m?.last_refresh_error ?? null,
    };
  }

  async health(now = Date.now()): Promise<TokenHealth[]> {
    const out: TokenHealth[] = [];
    for (const s of OAUTH_SERVICES) out.push(await this.healthOf(s, now));
    return out;
  }

  /** Forces a refresh. Concurrent calls for one service share a single request (refresh tokens are single-use). */
  refresh(service: OAuthService, now = Date.now()): Promise<TokenHealth> {
    let p = this.inflight.get(service);
    if (!p) {
      p = this.doRefresh(service, now).finally(() => this.inflight.delete(service));
      this.inflight.set(service, p);
    }
    return p;
  }

  private async doRefresh(service: OAuthService, now: number): Promise<TokenHealth> {
    const t = await this.tokens(service);
    if (!t) return this.healthOf(service, now);
    const m: TokenMeta = (await this.meta(service)) ?? { connected_at: now, last_refresh_at: null, last_refresh_error: null, needs_reconnect: false, refresh_count: 0 };
    const recordError = async (error: string) => {
      await this.ctx.storage.put(`meta:${service}`, { ...m, last_refresh_error: error, needs_reconnect: RECONNECT_ERRORS.has(error) } satisfies TokenMeta);
      return this.healthOf(service, now);
    };
    if (!t.refresh_token) return recordError('no_refresh_token');

    const cfg = providerConfig(service, this.env);
    const clientId = await this.clientCredential(cfg.clientIdName);
    const clientSecret = await this.clientCredential(cfg.clientSecretName);
    if (!clientId || !clientSecret) return recordError('missing_client_credentials');
    let res: Response;
    try {
      res = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId, client_secret: clientSecret }),
      });
    } catch (err) {
      return recordError(`network_error: ${(err as Error).message}`);
    }
    const parsed = await parseTokenResponse(cfg, res, now);
    if (!parsed.ok) return recordError(parsed.error);
    // Rotation: the provider's new refresh token replaces the old one; keep the old one only if none came back.
    const next: OAuthTokens = { ...parsed.tokens };
    if (!next.refresh_token) next.refresh_token = t.refresh_token;
    if (!next.team_id && t.team_id) next.team_id = t.team_id;
    if (!next.workspace_id && t.workspace_id) next.workspace_id = t.workspace_id;
    await this.ctx.storage.put(`tokens:${service}`, await this.seal(next));
    await this.ctx.storage.put(`meta:${service}`, { ...m, last_refresh_at: now, last_refresh_error: null, needs_reconnect: false, refresh_count: m.refresh_count + 1 } satisfies TokenMeta);
    return this.healthOf(service, now);
  }

  /** Cron entry point: refresh every connected service that is inside the refresh window. */
  async refreshAllIfNeeded(now = Date.now()): Promise<TokenHealth[]> {
    const out: TokenHealth[] = [];
    for (const s of OAUTH_SERVICES) {
      const t = await this.tokens(s);
      if (t && needsRefresh(t, now)) out.push(await this.refresh(s, now));
    }
    return out;
  }

  /** Access token for service handlers that call the provider API; refreshes first when due. */
  async getAccessToken(service: OAuthService, now = Date.now()): Promise<string | null> {
    const t = await this.tokens(service);
    if (!t) return null;
    if (needsRefresh(t, now)) {
      await this.refresh(service, now);
      return (await this.tokens(service))?.access_token ?? null;
    }
    return t.access_token;
  }

  async disconnect(service: OAuthService): Promise<{ disconnected: boolean; revoked: boolean }> {
    const t = await this.tokens(service);
    if (!t) return { disconnected: false, revoked: false };
    let revoked = false;
    const cfg = providerConfig(service, this.env);
    try {
      const res =
        cfg.revokeStyle === 'bearer'
          ? await fetch(cfg.revokeUrl, { method: 'POST', headers: { authorization: `Bearer ${t.access_token}` } })
          : // Linear: the `token` form field only; it "must not be combined with legacy fields" (Authorization header).
            await fetch(cfg.revokeUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ token: t.access_token, token_type_hint: 'access_token' }),
            });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean };
      revoked = res.ok && (cfg.okFlag ? json.ok === true : true);
    } catch {
      revoked = false;
    }
    await this.ctx.storage.delete([`tokens:${service}`, `meta:${service}`]);
    return { disconnected: true, revoked };
  }

  /** Drops the current tokens and starts a new OAuth flow. */
  async reconnect(service: OAuthService, redirectUri: string, now = Date.now()) {
    await this.ctx.storage.delete([`tokens:${service}`, `meta:${service}`]);
    return this.startAuth(service, redirectUri, now);
  }
}
