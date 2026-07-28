import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import { readManifest } from '../services/manifest';
import { listDeliveries, type DeliveryRow } from '../services/devRegistrar';

/**
 * `flashmandu-app logs` — show recent webhook deliveries the dev-box attempted
 * against this app's sandbox. Reads `GET /api/apps/dev/{appId}/deliveries`.
 *
 * With `--tail`, polls the endpoint every few seconds and prints new rows.
 * (Server-Sent Events support can be added later if the dev-box exposes a
 * stream; for now we poll — the dev-box is the only host.)
 */

function colourStatus(row: DeliveryRow): string {
  if (row.succeeded) return chalk.green(String(row.http_status));
  if (row.http_status >= 500) return chalk.magenta(String(row.http_status));
  if (row.http_status >= 400) return chalk.red(String(row.http_status));
  return chalk.yellow(String(row.http_status));
}

function printRow(row: DeliveryRow): void {
  const ts = row.created_at ?? '';
  console.log(
    `${chalk.dim(ts)}  ${colourStatus(row)}  ${chalk.cyan(row.event)}  ${row.delivery_id}`,
  );
  if (row.response) {
    console.log(chalk.dim(`    ${row.response.slice(0, 200)}`));
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
        let appId = opts.appId;
        if (!appId) {
          try {
            const m = await readManifest(path.resolve(opts.dir));
            appId = m.id;
          } catch {
            throw new Error(
              'No app id. Either run from an app directory with flashmandu.app.toml or pass --app-id.',
            );
          }
        }

        if (!opts.tail) {
          const { data } = await listDeliveries(appId);
          if (!data || data.length === 0) {
            console.log(chalk.yellow('No deliveries yet.'));
            return;
          }
          for (const row of data) printRow(row);
          return;
        }

        const intervalMs = Math.max(1, Number.parseInt(opts.interval, 10) || 5) * 1000;
        console.log(chalk.dim(`Tailing deliveries for ${appId} (every ${intervalMs / 1000}s). Ctrl+C to stop.`));
        let seen = new Set<string>();
        // Seed with current.
        try {
          const { data } = await listDeliveries(appId);
          for (const row of data ?? []) {
            seen.add(row.delivery_id);
            printRow(row);
          }
        } catch (err) {
          console.log(chalk.yellow(`Initial fetch failed: ${(err as Error).message}`));
        }

        const tick = async (): Promise<void> => {
          try {
            const { data } = await listDeliveries(appId!);
            for (const row of data ?? []) {
              if (!seen.has(row.delivery_id)) {
                seen.add(row.delivery_id);
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
