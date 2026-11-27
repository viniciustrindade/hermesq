import { app, runScheduled } from './app';
import { handleQueue } from './queue/consumer';
import type { Env, QueueMessageBody } from './types';

// Entry module: only the default handler and Durable Object classes may be exported from here
// (workerd refuses to start on any other named export; see src/app.ts).
export { OAuthStore } from './durable-objects/oauth-store';
export { Hub } from './hub/hub';

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<QueueMessageBody>, env: Env) {
    await handleQueue(batch, env);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env, QueueMessageBody>;
