import { type ChildProcess } from 'node:child_process';

/**
 * Tunnel provider resolver. `app dev` exposes the developer's local app server
 * to the public internet so the dev-box can reach its webhook_url and OAuth
 * endpoints.
 *
 * Strategy (in order):
 *   1. cloudflared quick tunnel (no account, no token) — default.
 *   2. ngrok free tier — fallback.
 *   3. A developer-supplied `--tunnel-url` for bring-your-own (e.g. tailscale
 *      serve, a static domain). Skips spawning entirely.
 *
 * Each provider is `require()`d lazily so the CLI works even if neither
 * optional dependency is installed; the user gets a clear error pointing at
 * the missing tool.
 */

export interface Tunnel {
  /** Public https URL the dev-box can reach. */
  url: string;
  /** Stop the tunnel process (no-op for bring-your-own). */
  close(): Promise<void>;
  /** Resolves when the underlying process exits unexpectedly. */
  onClose(cb: () => void): void;
}

export type TunnelProvider = 'cloudflared' | 'ngrok' | 'external';

export interface TunnelOptions {
  provider?: TunnelProvider;
  /** Local port the developer's app server is listening on. */
  port: number;
  /** Skip spawning; use this exact public URL. */
  externalUrl?: string;
}

function closeProc(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      resolve();
    }, 3000);
  });
}

/** Start a cloudflared quick tunnel pointing at `localhost:port`. */
async function startCloudflared(port: number): Promise<Tunnel> {
  let mod: unknown;
  try {
    mod = require('cloudflared');
  } catch {
    throw new Error(
      'cloudflared is not installed. Install it with `npm install -D cloudflared`, ' +
        'use `--tunnel-url <https-url>`, or pick ngrok with `--tunnel ngrok`.',
    );
  }

  const cf = mod as {
    tunnel: (opts?: Record<string, string | number | null>) => {
      url: Promise<string>;
      child: ChildProcess;
    };
  };
  // A quick tunnel needs no account or token — just point cloudflared at the
  // local app server.
  const started = cf.tunnel({ '--url': `http://localhost:${port}` });
  const url = normaliseUrl(await started.url);

  // cloudflared assigns the random subdomain before edge DNS is live; wait for
  // the URL to actually resolve so the dev-box never registers a dead URL.
  await waitForEdgeReady(url);

  return {
    url,
    async close() {
      await closeProc(started.child);
    },
    onClose(cb) {
      started.child.once('exit', cb);
    },
  };
}

/** Start an ngrok tunnel pointing at `localhost:port`. */
async function startNgrok(port: number): Promise<Tunnel> {
  let mod: unknown;
  try {
    mod = require('ngrok');
  } catch {
    throw new Error(
      'ngrok is not installed. Install it with `npm install -D ngrok`, ' +
        'use `--tunnel-url <https-url>`, or pick cloudflared with `--tunnel cloudflared`.',
    );
  }

  const ngrok = mod as {
    connect: (opts: { addr: number; proto: 'http' }) => Promise<string>;
    disconnect: () => Promise<void>;
  };
  const url = await ngrok.connect({ addr: port, proto: 'http' });

  return {
    url: normaliseUrl(url),
    async close() {
      await ngrok.disconnect();
    },
    onClose() {
      /* ngrok manages its own process; no child exit to observe. */
    },
  };
}

function normaliseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Wait until a freshly-provisioned tunnel URL is actually reachable at the
 * provider's edge.
 *
 * Quick-tunnel providers (cloudflared in particular) hand back a random
 * subdomain the instant they *assign* it, which can be a few seconds before
 * DNS for that subdomain resolves at the edge. If we register the URL with the
 * dev-box before then, the platform embeds a URL that fails with
 * "server IP address could not be found". So we probe the URL (any HTTP
 * response — even 404/502 — proves DNS + connectivity) and retry until it is
 * live or the budget elapses. Best-effort: on timeout we still return the URL
 * and warn (the local network may simply block the probe).
 */
async function waitForEdgeReady(url: string, budgetMs = 20000, stepMs = 1000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
      });
      // Any HTTP status means DNS resolved + the edge answered.
      void res;
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }
  // Don't hard-fail — the probe can be blocked locally while the tunnel is fine
  // for the dev-box. Surface a hint instead.
  console.warn(
    `\n  ⚠  Tunnel URL did not confirm reachable within ${Math.round(budgetMs / 1000)}s ` +
      `(${url}). If the embed shows "server IP address could not be found", wait a few ` +
      `seconds and refresh, or re-run \`autohisab-business dev\`.\n`,
  );
  void lastErr;
}

/** Resolve and start a tunnel per the options. */
export async function startTunnel(opts: TunnelOptions): Promise<Tunnel> {
  if (opts.externalUrl) {
    const url = normaliseUrl(opts.externalUrl);
    // https is required for public tunnels. We additionally allow a plain
    // http loopback URL (http://localhost / 127.0.0.1) for fully-local dev,
    // where the platform frames the app on the same machine without a tunnel
    // (the platform's apps.embed.allow_loopback dev flag must be on).
    const isLoopback = /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url);
    if (!url.startsWith('https://') && !isLoopback) {
      throw new Error(
        `--tunnel-url must be https (got ${url}). The dev-box enforces https. ` +
          `For local dev without a tunnel, use http://localhost:<port> with apps.embed.allow_loopback on.`,
      );
    }
    return {
      url,
      async close() {
        /* bring-your-own */
      },
      onClose() {
        /* no process to watch */
      },
    };
  }

  const provider = opts.provider ?? 'cloudflared';
  if (provider === 'cloudflared') return startCloudflared(opts.port);
  if (provider === 'ngrok') return startNgrok(opts.port);
  throw new Error(`Unknown tunnel provider: ${provider as string}`);
}
