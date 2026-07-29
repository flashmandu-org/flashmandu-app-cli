import { get, post } from './apiClient';

/**
 * Calls the dev-box's `POST /api/apps/dev/register` endpoint, which wraps
 * `AppManager::installRemoteApp()` for developer sandboxes and returns
 * `{ installed, app_id, api_token, webhook_secret, profile_id }`. The
 * plaintext api_token is delivered ONCE — rotate via the dev-box UI.
 *
 * Auth: the developer's Bearer token from `app login` (a dev-only token, not a
 * merchant install). The dev-box is the only host ever contacted.
 *
 * `webhook_url` is the public tunnel URL so the dev-box can deliver signed
 * webhooks back to the developer's running app server.
 *
 * Identity: the request carries `slug` (the developer-chosen leaf). The host
 * namespaces it by publisher into the canonical `<publisher>/<slug>` app id,
 * which is returned in the response as `app_id`.
 */

export interface DevRegisterRequest {
  /** Developer-chosen slug (leaf of the canonical `<publisher>/<slug>` id). */
  slug: string;
  /** Display name from the manifest (required by the dev-box). */
  name: string;
  /** Manifest semver; recorded on the install row. */
  version?: string;
  /** Public https tunnel URL the dev-box should POST webhooks to. */
  webhook_url: string;
  /** OAuth URLs on the running app server ( tunnel + path). */
  authorize_url: string;
  token_url: string;
  credential_delivery_url?: string;
  /** Scope enum values + events to subscribe. */
  scopes: string[];
  subscribed_events: string[];
  /** App Embed Blocks declared in the manifest (Spec #1). Persisted by the
   * host onto `installed_apps.extensions` so EmbedBlockCatalog resolves them. */
  embed_blocks?: unknown[];
}

export interface DevRegisterResponse {
  /** Always true on success; present so callers can assert the contract. */
  installed: boolean;
  /** Canonical `<publisher>/<slug>` app id, as namespaced by the host. */
  app_id: string;
  /** Plaintext api_token. Delivered once; hash stored server-side. */
  api_token: string;
  /** HMAC secret the dev-box uses to sign inbound webhook deliveries. */
  webhook_secret: string;
  /** Sandbox profile the app was installed under. */
  profile_id: number;
}

/** Register (or refresh) the dev sandbox install against the dev-box. */
export function registerSandbox(payload: DevRegisterRequest): Promise<DevRegisterResponse> {
  return post<DevRegisterResponse>('/api/apps/dev/register', payload);
}

/** Delivery log row from `GET /api/apps/dev/deliveries`. */
export interface DeliveryRow {
  event: string;
  url: string;
  http_status: number | null;
  succeeded: boolean;
  delivery_id: string | null;
  created_at?: string;
}

/**
 * Recent webhook deliveries for the app whose api_token authenticates the
 * call. The dev-box derives the app identity from the bearer — pass the
 * app's own token (from .flashmandu/sandbox-secrets) via `token`, not the
 * developer login token (which resolves to the dev/cli app).
 */
export function listDeliveries(token?: string): Promise<{ deliveries: DeliveryRow[] }> {
  return get<{ deliveries: DeliveryRow[] }>(
    '/api/apps/dev/deliveries',
    token ? { token } : {},
  );
}
