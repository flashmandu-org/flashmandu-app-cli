/* @flashmandu-template app/webhooks/flashmandu/route.ts@0.4.0 */
import { createWebhookRoute } from '@flashmandu/app-bridge/next/routes';
import { loadConfig } from '@flashmandu/app-bridge/server';
import { purgeProfileData } from '@/lib/purge';

/**
 * Flashmandu webhook receiver.
 *
 * `createWebhookRoute` reads the raw body FIRST, verifies the HMAC via the
 * canonical verifier (byte-for-byte mirror of the PHP SDK), dedupes on
 * `X-App-Delivery`, and dispatches `app.uninstalled` / `profile.data.erased`
 * to `onUninstalled`. Everything else falls through unhandled — pass
 * `onEvent` here if you need to react to other subscribed events.
 */
export const { POST } = createWebhookRoute({
  cfg: loadConfig(),
  onUninstalled: purgeProfileData,
});
