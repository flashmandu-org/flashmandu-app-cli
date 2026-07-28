import { getActive, type ProfileEntry } from './credentials';

/**
 * Thin fetch wrapper that injects the developer Bearer token and pins the
 * dev-box base URL. Every network call the CLI makes to the Flashmandu host
 * goes through here.
 *
 * The CLI NEVER embeds a production host. The base URL is whatever the
 * developer configured via `flashmandu-app config set base_url <url>` (or
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
  if (!options.noAuth || options.token) {
    profile = await getActive();
  }

  const base = options.baseUrl ?? process.env.FLASHMANDU_BASE_URL_OVERRIDE ?? profile?.base_url;
  if (!base) {
    throw new Error(
      'No base URL configured. Run `flashmandu-app config set base_url <https://your-dev-box>` first.',
    );
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': '@flashmandu/app-cli',
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
