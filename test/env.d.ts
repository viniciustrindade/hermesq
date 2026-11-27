import type { Env as AppEnv } from '../src/types';

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends AppEnv {}
    interface GlobalProps {
      mainModule: typeof import('../src/index');
      durableNamespaces: 'OAuthStore' | 'Hub';
    }
  }
}

export type { AppEnv as Env };
