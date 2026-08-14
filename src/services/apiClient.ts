import { getActive, type ProfileEntry } from './credentials';

/**
 * Thin fetch wrapper that injects the developer Bearer token and pins the
 * dev-box base URL. Every network call the CLI makes to the AutoHisab Business host
 * goes through here.
 *
 * The CLI NEVER embeds a production host. The base URL is whatever the
 * developer configured via `autohisab-business config set base_url <url>` (or
 * `--base-url`). The dev-box is the only legal target.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(`HTTP ${status} ${message} (${url})`);
    this.name = 'ApiError';
  }
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Override the active profile's base URL for a single call. */
  baseUrl?: string;
  /** Bypass auth (e.g. for the public /hooks endpoint). */
  noAuth?: boolean;
  /** Raw token override (rare; used by `app dev` which posts dev tokens). */
  token?: string;
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

const LETTER = /[A-Za-z]/;

/**
 * Strip ANSI CSI escape sequences and other C0 control characters from
 * server-provided text so a hostile dev-box cannot inject terminal escape
 * sequences into the CLI's output. Implemented as a char-code loop to keep
 * the source free of literal control bytes.
 */
function stripUnsafe(message: string): string {
  let out = '';
  let i = 0;
  while (i < message.length) {
    const code = message.charCodeAt(i);
    if (code === 0x1b && message[i + 1] === '[') {
      i += 2;
      while (i < message.length && !LETTER.test(message[i]!)) i++;
      i++;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      i++;
      continue;
    }
    out += message[i];
    i++;
  }
  return out;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** Issue an authenticated JSON request against the dev-box host. */
export async function request<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  let profile: ProfileEntry | undefined;
  try {
    profile = await getActive();
  } catch (err) {
    // The stored profile is required only when it must supply the bearer
    // token. Explicit-token and no-auth calls may still use it as a base_url
    // fallback, but must not hard-fail when none exists (e.g. during login).
    if (!options.noAuth && !options.token) {
      throw err;
    }
  }

  const base = options.baseUrl ?? process.env.FLASHMANDU_BASE_URL_OVERRIDE ?? profile?.base_url;
  if (!base) {
    throw new Error(
      'No platform base URL configured. Run `autohisab-business config set base_url <https://your-dev-box>` — ' +
        'this is the AutoHisab Business host the CLI talks to, not your app’s URL.',
    );
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': '@flashmandu/autohisab-business-cli',
    ...(options.headers as Record<string, string> | undefined),
  };

  const token = options.token ?? profile?.token;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const url = joinUrl(base, path);
  let res: Response;
  try {
    res = await fetch(url, { ...options, headers, body });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Network error contacting dev box at ${base}: ${stripUnsafe(msg)}`);
  }

  if (!res.ok) {
    let parsed: unknown;
    try {
      parsed = await parseBody(res);
    } catch {
      parsed = undefined;
    }
    const message =
      typeof parsed === 'object' && parsed !== null && 'message' in parsed
        ? stripUnsafe(String((parsed as { message: unknown }).message))
        : res.statusText;
    throw new ApiError(res.status, url, message, parsed);
  }

  return (await parseBody(res)) as T;
}

/** GET helper. */
export function get<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(path, { ...options, method: 'GET' });
}

/** POST helper. */
export function post<T = unknown>(
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  return request<T>(path, { ...options, method: 'POST', body });
}

/** PUT helper. */
export function put<T = unknown>(
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  return request<T>(path, { ...options, method: 'PUT', body });
}

/** DELETE helper. */
export function del<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(path, { ...options, method: 'DELETE' });
}

/* ------------------------------------------------------------------------ *
 * Phase 1 platform endpoints
 *
 * Every endpoint added by the Phase 1 app-platform work lives in THIS block,
 * paths included, so a contract change on the host is a one-file fix here.
 * Commands must never construct a URL themselves.
 * ------------------------------------------------------------------------ */

/** Canonical paths. Kept together so a host rename is one edit. */
export const ENDPOINTS = {
  /** Delivery log (parity spec §9). Superset of the older dev-only endpoint. */
  deliveries: '/api/apps/deliveries',
  /** Legacy dev-box delivery list, used as a fallback on 404/405. */
  devDeliveries: '/api/apps/dev/deliveries',
  /** Replay a single delivery by id. */
  replay: (id: string): string => `/api/apps/deliveries/${encodeURIComponent(id)}/replay`,
  /** Hosted-app secrets. Write-only: the platform exposes key names, never values. */
  secrets: '/api/apps/hosted-secrets',
  /** Runtime capabilities, including the supported bridge version floor. */
  capabilities: '/api/apps/capabilities',
  /**
   * Declared `[[schedules]]` (capability spec §5). `sync` REPLACES the calling
   * app's declarations across every enabled install; `read` returns them with
   * their platform-side health. Both are scoped to the bearer-resolved app, so
   * they must be called with the APP's own api_token — the developer login
   * token resolves to the dev/cli app, which is a different app id.
   */
  schedulesSync: '/api/apps/schedules/sync',
  schedules: '/api/apps/schedules',
  /**
   * Tier 1 no-server dev loop (`section dev`). REPLACES the calling dev
   * install's declared `[[storefront_sections]]` — dev-environment only on
   * the host, authenticated with the APP's own api_token (not the developer
   * login token, which resolves to the dev/cli app).
   */
  devSections: '/api/apps/dev/sections',
} as const;

/**
 * One schedule as the platform reports it back (`AppSchedule::toCliArray()`).
 * Exactly one of `every` / `cron` is non-null. `state` becomes "disabled" with
 * a `disabled_reason` after the platform gives up on repeatedly failing ticks,
 * which is the whole reason the CLI reads schedules back instead of echoing
 * the manifest.
 */
export interface ScheduleRecord {
  name: string;
  every: string | null;
  cron: string | null;
  timezone: string | null;
  state: string;
  disabled_reason: string | null;
  failure_count?: number;
  next_run_at?: string | null;
  last_run_at?: string | null;
}

export interface ScheduleSyncResult {
  app_id: string;
  /** Number of enabled installs the declarations were materialized onto. */
  installs: number;
  schedules: ScheduleRecord[];
}

/**
 * Replace the app's declared schedules from its manifest.
 *
 * `token` MUST be the app's own api_token (from the `dev` register response or
 * `.flashmandu/sandbox-secrets.*.json`); the platform derives the target app id
 * from the bearer, so passing the login token would sync onto the wrong app.
 */
export function syncSchedules(
  schedules: Array<{ name: string; every?: string; interval_seconds?: number; cron?: string }>,
  token: string,
): Promise<ScheduleSyncResult> {
  return post<ScheduleSyncResult>(ENDPOINTS.schedulesSync, { schedules }, { token });
}

/** Read back the app's schedules and their current health. */
export function fetchSchedules(token: string): Promise<{ schedules: ScheduleRecord[] }> {
  return get<{ schedules: ScheduleRecord[] }>(ENDPOINTS.schedules, { token });
}

/**
 * One recorded webhook delivery attempt.
 *
 * `attempt`/`attempts`, `duration_ms` and `dead_lettered` come from the Phase 1
 * delivery log; the older dev endpoint returns only the first four fields, so
 * every added field is optional and the renderer degrades to "-".
 */
export interface DeliveryRecord {
  /** Row id — what `hooks replay <id>` takes. */
  id?: string | number;
  /** Platform-issued dedupe id, echoed to the app as `X-App-Delivery`. */
  delivery_id: string | null;
  event: string;
  url?: string;
  http_status: number | null;
  succeeded: boolean;
  /** 1-based attempt number of this row. */
  attempt?: number;
  /** Total attempts made for this delivery so far. */
  attempts?: number;
  /** Round-trip latency in milliseconds. */
  duration_ms?: number;
  /** True once the backoff schedule is exhausted (1m, 5m, 30m, 2h, 8h). */
  dead_lettered?: boolean;
  /** ISO-8601. */
  created_at?: string;
  next_attempt_at?: string | null;
  response?: string | null;
}

export interface DeliveriesQuery {
  /** App token to authenticate as the app itself rather than the dev/cli app. */
  token?: string;
  limit?: number;
  event?: string;
  /** 'succeeded' | 'failed' | 'dead' — server-side filter. */
  status?: string;
}

/**
 * List recent webhook deliveries. Falls back to the pre-Phase-1 dev endpoint
 * when the host has not shipped the richer log yet, so the CLI keeps working
 * against an older dev box.
 */
export async function fetchDeliveries(query: DeliveriesQuery = {}): Promise<DeliveryRecord[]> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.event) params.set('event', query.event);
  if (query.status) params.set('status', query.status);
  const qs = params.toString();
  const options: RequestOptions = query.token ? { token: query.token } : {};

  try {
    const res = await get<{ deliveries?: DeliveryRecord[] }>(
      qs ? `${ENDPOINTS.deliveries}?${qs}` : ENDPOINTS.deliveries,
      options,
    );
    return res.deliveries ?? [];
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
      const res = await get<{ deliveries?: DeliveryRecord[] }>(ENDPOINTS.devDeliveries, options);
      return res.deliveries ?? [];
    }
    throw err;
  }
}

export interface ReplayResult {
  /** True when the platform accepted the replay request. */
  ok?: boolean;
  delivery_id?: string;
  http_status?: number | null;
  message?: string;
}

/** Redeliver one logged webhook. */
export function replayDelivery(id: string, token?: string): Promise<ReplayResult> {
  return post<ReplayResult>(ENDPOINTS.replay(id), undefined, token ? { token } : {});
}

/**
 * Hosted-app secrets (capability spec §8.1). WRITE-ONLY by design: the
 * platform has no read-back endpoint, so `keys` is all the CLI can ever show.
 */
export function listSecretKeys(appId: string): Promise<{ keys: string[] }> {
  return get<{ keys: string[] }>(`${ENDPOINTS.secrets}?app_id=${encodeURIComponent(appId)}`);
}

/** Set (or replace) one secret. The value is encrypted at rest on the host. */
export function setSecret(appId: string, key: string, value: string): Promise<unknown> {
  return put(ENDPOINTS.secrets, { app_id: appId, key, value });
}

/** Delete one secret. */
export function unsetSecret(appId: string, key: string): Promise<unknown> {
  return del(
    `${ENDPOINTS.secrets}?app_id=${encodeURIComponent(appId)}&key=${encodeURIComponent(key)}`,
  );
}

/**
 * Minimum `@flashmandu/app-bridge` / `app-bridge-ui` versions this platform
 * supports. Absent on hosts that predate the check — callers treat a missing
 * floor as "no opinion" and stay silent rather than warning wrongly.
 */
export interface BridgeVersionFloor {
  'app-bridge'?: string;
  'app-bridge-ui'?: string;
}

/** Fetch the platform's supported bridge version floor. Never throws. */
export async function fetchBridgeVersionFloor(): Promise<BridgeVersionFloor> {
  try {
    const caps = await get<{ bridge_version_floor?: BridgeVersionFloor }>(ENDPOINTS.capabilities);
    return caps.bridge_version_floor ?? {};
  } catch {
    // A version hint must never break `dev` or `push`.
    return {};
  }
}
