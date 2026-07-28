import { Command } from 'commander';
import chalk from 'chalk';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readManifest } from '../services/manifest';
import { listDeliveries, type DeliveryRow } from '../services/devRegistrar';

/**
 * `flashmandu-app logs` — show recent webhook deliveries the dev-box attempted
 * against this app's sandbox. Reads `GET /api/apps/dev/deliveries`, which
 * derives the app identity from the bearer token.
 *
 * The developer login token resolves to the `dev/cli` app — not YOUR app — so
 * this command authenticates with the app's own api_token from
 * `.flashmandu/sandbox-secrets.<app>.json` (written by `flashmandu-app dev`)
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

/** Read the app's api_token from the CLI-written sandbox secrets file. */
async function readSandboxToken(appDir: string, appId: string): Promise<string | undefined> {
  const file = path.join(
    appDir,
    '.flashmandu',
    `sandbox-secrets.${appId.replace(/[^a-z0-9-]/gi, '-')}.json`,
  );
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { api_token?: unknown };
    return typeof parsed.api_token === 'string' && parsed.api_token !== ''
      ? parsed.api_token
      : undefined;
  } catch {
    return undefined;
  }
}

export function makeLogsCommand(): Command {
  const cmd = new Command('logs')
    .description('Show recent webhook deliveries for this app from the dev-box.')
    .option('-d, --dir <path>', 'App directory', '.')
    .option('--app-id <id>', 'Override app id (default: from manifest)')
    .option('--tail', 'Poll for new deliveries every 5s until Ctrl+C')
    .option('--interval <seconds>', 'Poll interval for --tail', '5')
    .action(
      async (opts: { dir: string; appId?: string; tail?: boolean; interval: string }) => {
        const appDir = path.resolve(opts.dir);
        let appId = opts.appId;
        if (!appId) {
          try {
            const m = await readManifest(appDir);
            appId = m.id;
          } catch {
            throw new Error(
              'No app id. Either run from an app directory with flashmandu.app.toml or pass --app-id.',
            );
          }
        }

        const token = await readSandboxToken(appDir, appId);
        if (!token) {
          console.log(
            chalk.dim(
              'No .flashmandu/sandbox-secrets file found — falling back to the login token. ' +
                'Run `flashmandu-app dev` first for per-app delivery history.',
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
        console.log(chalk.dim(`Tailing deliveries for ${appId} (every ${intervalMs / 1000}s). Ctrl+C to stop.`));
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
