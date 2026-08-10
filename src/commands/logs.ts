import { Command } from 'commander';
import chalk from 'chalk';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readManifest } from '../services/manifest';
import { listDeliveries, type DeliveryRow } from '../services/devRegistrar';
import { fetchPlatformLogs, formatPlatformLogs } from '../services/platformLogs';

/**
 * `autohisab-business logs` — show recent webhook deliveries the dev-box attempted
 * against this app's sandbox. Reads `GET /api/apps/dev/deliveries`, which
 * derives the app identity from the bearer token.
 *
 * The developer login token resolves to the `dev/cli` app — not YOUR app — so
 * this command authenticates with the app's own api_token from
 * `.flashmandu/sandbox-secrets.<app>.json` (written by `autohisab-business dev`)
 * whenever it exists, falling back to the login token otherwise.
 *
 * With `--tail`, polls the endpoint every few seconds and prints new rows.
 */

function colourStatus(row: DeliveryRow): string {
  if (row.http_status === null) return chalk.yellow('-');
  if (row.succeeded) return chalk.green(String(row.http_status));
  if (row.http_status >= 500) return chalk.magenta(String(row.http_status));
  if (row.http_status >= 400) return chalk.red(String(row.http_status));
  return chalk.yellow(String(row.http_status));
}

function rowKey(row: DeliveryRow): string {
  return row.delivery_id ?? `${row.created_at ?? ''}:${row.event}`;
}

function printRow(row: DeliveryRow): void {
  const ts = row.created_at ?? '';
  console.log(
    `${chalk.dim(ts)}  ${colourStatus(row)}  ${chalk.cyan(row.event)}  ${row.delivery_id ?? ''}`,
  );
}

/**
 * Read the app's api_token from the CLI-written sandbox secrets file. The
 * filename is keyed by the canonical `<publisher>/<slug>` app_id returned by
 * the host during `app dev` (slugified to `<publisher>-<slug>`), which logs
 * cannot know without registering — so we scan `.flashmandu/` for any
 * `sandbox-secrets.*.json` (there is typically exactly one per app dir) and
 * also try the manifest's own slug as a fallback.
 */
async function readSandboxToken(
  appDir: string,
  slug: string,
): Promise<{ token: string | undefined; appId: string | undefined }> {
  const dir = path.join(appDir, '.flashmandu');
  const candidates: string[] = [];
  try {
    for (const entry of await fs.readdir(dir)) {
      if (entry.startsWith('sandbox-secrets.') && entry.endsWith('.json')) {
        candidates.push(path.join(dir, entry));
      }
    }
  } catch {
    /* dir missing — fall through to slug-based path */
  }
  // Fallback to the leaf-slug filename in case a future writer uses it.
  candidates.push(path.join(dir, `sandbox-secrets.${slug}.json`));

  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as {
        api_token?: unknown;
        app_id?: unknown;
      };
      const token =
        typeof parsed.api_token === 'string' && parsed.api_token !== ''
          ? parsed.api_token
          : undefined;
      if (token) {
        return {
          token,
          appId: typeof parsed.app_id === 'string' ? parsed.app_id : undefined,
        };
      }
    } catch {
      /* try next */
    }
  }
  return { token: undefined, appId: undefined };
}

export function makeLogsCommand(): Command {
  const cmd = new Command('logs')
    .description('Show recent webhook deliveries for this app from the dev-box.')
    .option('-d, --dir <path>', 'App directory', '.')
    .option('--app-slug <slug>', 'Override app slug (default: from manifest)')
    .option('--app-id <id>', 'Alias of --app-slug for back-compat')
    .option(
      '--platform <appId>',
      'Show platform-hosted pod logs for <publisher>/<slug> instead of dev deliveries',
    )
    .option('--tail', 'Poll for new deliveries every 5s until Ctrl+C')
    .option('--interval <seconds>', 'Poll interval for --tail', '5')
    .action(
      async (opts: {
        dir: string;
        appSlug?: string;
        appId?: string;
        platform?: string;
        tail?: boolean;
        interval: string;
      }) => {
        // Platform-hosted pod logs: fetch from the cluster via the platform.
        if (opts.platform) {
          const res = await fetchPlatformLogs(opts.platform);
          console.log(formatPlatformLogs(res));
          return;
        }

        const appDir = path.resolve(opts.dir);
        let slug = opts.appSlug ?? opts.appId;
        if (!slug) {
          try {
            const m = await readManifest(appDir);
            slug = m.slug;
          } catch {
            throw new Error(
              'No app slug. Either run from an app directory with flashmandu.app.toml or pass --app-slug.',
            );
          }
        }

        const { token, appId } = await readSandboxToken(appDir, slug);
        if (!token) {
          console.log(
            chalk.dim(
              'No .flashmandu/sandbox-secrets file found — falling back to the login token. ' +
                'Run `autohisab-business dev` first for per-app delivery history.',
            ),
          );
        }

        const fetchRows = async (): Promise<DeliveryRow[]> => {
          const { deliveries } = await listDeliveries(token);
          return deliveries ?? [];
        };

        if (!opts.tail) {
          const rows = await fetchRows();
          if (rows.length === 0) {
            console.log(chalk.yellow('No deliveries yet.'));
            return;
          }
          for (const row of rows) printRow(row);
          return;
        }

        const intervalMs = Math.max(1, Number.parseInt(opts.interval, 10) || 5) * 1000;
        const displayId = appId ?? slug;
        console.log(chalk.dim(`Tailing deliveries for ${displayId} (every ${intervalMs / 1000}s). Ctrl+C to stop.`));
        const seen = new Set<string>();
        // Seed with current.
        try {
          for (const row of await fetchRows()) {
            seen.add(rowKey(row));
            printRow(row);
          }
        } catch (err) {
          console.log(chalk.yellow(`Initial fetch failed: ${(err as Error).message}`));
        }

        const tick = async (): Promise<void> => {
          try {
            for (const row of await fetchRows()) {
              const key = rowKey(row);
              if (!seen.has(key)) {
                seen.add(key);
                printRow(row);
              }
            }
          } catch (err) {
            console.log(chalk.yellow(`Poll failed: ${(err as Error).message}`));
          }
        };

        const handle = setInterval(tick, intervalMs);
        await new Promise<void>((resolve) => {
          const stop = (): void => {
            clearInterval(handle);
            resolve();
          };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
      },
    );

  return cmd;
}
