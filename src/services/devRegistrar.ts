import { get, post } from './apiClient';

/**
 * Calls the dev-box's planned `POST /api/apps/dev/register` endpoint, which
 * wraps `AppManager::installRemoteApp()` for developer sandboxes and returns
 * `{ api_token, webhook_secret, install_id }` ONCE. The CLI never sees these
 * again — rotate via the dev-box UI.
 *
 * Auth: the developer's Bearer token from `app login` (a dev-only token, not a
 * merchant install). The dev-box is the only host ever contacted.
 *
 * `webhook_url` is the public tunnel URL so the dev-box can deliver signed
 * webhooks back to the developer's running app server.
 */

export interface DevRegisterRequest {
  /** App id from `flashmandu.app.toml`. */
  app_id: string;
  /** Public https tunnel URL the dev-box should POST webhooks to. */
  webhook_url: string;
  /** OAuth URLs on the running app server ( tunnel + path). */
  authorize_url: string;
  token_url: string;
  credential_delivery_url?: string;
  /** Scope enum values + events to subscribe. */
  scopes: string[];
  subscribed_events: string[];
}

export interface DevRegisterResponse {
  /** Install record id on the dev-box. */
  install_id: number | string;
  /** Plaintext api_token. Delivered once; hash stored server-side. */
  api_token: string;
  /** HMAC secret the dev-box uses to sign inbound webhook deliveries. */
  webhook_secret: string;
  /** Echoed scopes that were granted. */
  scopes: string[];
}

/** Register (or refresh) the dev sandbox install against the dev-box. */
export function registerSandbox(payload: DevRegisterRequest): Promise<DevRegisterResponse> {
  return post<DevRegisterResponse>('/api/apps/dev/register', payload);
}

/** Delivery log row from `GET /api/apps/dev/{appId}/deliveries`. */
export interface DeliveryRow {
  delivery_id: string;
  event: string;
  url: string;
  http_status: number;
  succeeded: boolean;
  response?: string;
  created_at?: string;
}

export function listDeliveries(appId: string): Promise<{ data: DeliveryRow[] }> {
  // The deliveries endpoint is spec'd to return `{ data: DeliveryRow[] }`; we
  // keep the cast loose so the dev-box can add fields without breaking the CLI.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return get<any>(`/api/apps/dev/${encodeURIComponent(appId)}/deliveries`);
}
