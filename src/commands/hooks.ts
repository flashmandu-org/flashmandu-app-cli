import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import {
  fetchDeliveries,
  get,
  replayDelivery,
  type DeliveryRecord,
} from '../services/apiClient';
import { readManifest, resolveWebhooks, writeWebhookEvents } from '../services/manifest';
import { readSandboxIdentity } from '../services/sandboxSecrets';

interface HookCatalogEntry {
  description: string;
  category: string;
  type?: string;
}
type HookCatalog = Record<string, HookCatalogEntry>;

/**
 * `autohisab-business hooks` — the webhook surface of the CLI.
 *
 *   hooks                    list the platform hook catalog
 *   hooks subscribe <event>  add the event to `[webhooks].events` in the toml
 *   hooks unsubscribe <ev>   remove it
 *   hooks deliveries         recent delivery attempts (event/status/attempts/latency)
 *   hooks replay <id>        redeliver one logged webhook
 *
 * `subscribe`/`unsubscribe` are TOML EDITORS, not API calls: the manifest is
 * the single source of truth for an app's subscription and the CLI is its only
 * writer. The next `dev`/`push`/`deploy` syncs it to the platform.
 */
export function makeHooksCommand(): Command {
  const cmd = new Command('hooks')
    .description('Platform hooks: catalog, declarative subscription, delivery log, replay.')
    .option('--category <name>', 'Filter the catalog by category')
    .option('--type <type>', 'Filter the catalog by type (event | filter)')
    .action(async (opts: { category?: string; type?: string }) => {
      await listCatalog(opts);
    });

  cmd
    .command('list')
    .description('List platform hooks available to apps (public endpoint).')
    .option('--category <name>', 'Filter by category')
    .option('--type <type>', 'Filter by type (event | filter)')
    .action(async (opts: { category?: string; type?: string }) => {
      await listCatalog(opts);
    });

  cmd
    .command('subscribe <event>')
    .description('Add an event to [webhooks].events in flashmandu.app.toml.')
    .option('-d, --dir <path>', 'App directory', '.')
    .action(async (event: string, opts: { dir: string }) => {
      await editSubscription(path.resolve(opts.dir), event, 'add');
    });

  cmd
    .command('unsubscribe <event>')
    .description('Remove an event from [webhooks].events in flashmandu.app.toml.')
    .option('-d, --dir <path>', 'App directory', '.')
    .action(async (event: string, opts: { dir: string }) => {
      await editSubscription(path.resolve(opts.dir), event, 'remove');
    });

  cmd
    .command('deliveries')
    .description('Recent webhook delivery attempts: event, status, attempts, latency.')
    .option('-d, --dir <path>', 'App directory', '.')
    .option('-n, --limit <count>', 'How many rows to fetch', '25')
    .option('--event <name>', 'Only this event')
    .option('--status <status>', 'Filter: succeeded | failed | dead')
    .action(
      async (opts: { dir: string; limit: string; event?: string; status?: string }) => {
        const appDir = path.resolve(opts.dir);
        const token = await appTokenFor(appDir);
        const limit = Number.parseInt(opts.limit, 10);
        const rows = await fetchDeliveries({
          token,
          limit: Number.isFinite(limit) && limit > 0 ? limit : 25,
          event: opts.event,
          status: opts.status,
        });

        if (rows.length === 0) {
          console.log(chalk.yellow('No deliveries recorded yet.'));
          return;
        }
        console.log(formatDeliveries(rows));
        console.log(
          chalk.dim('\nReplay one with: autohisab-business hooks replay <id>'),
        );
      },
    );

  cmd
    .command('replay <id>')
    .description('Redeliver a logged webhook by its delivery row id.')
    .option('-d, --dir <path>', 'App directory', '.')
    .action(async (id: string, opts: { dir: string }) => {
      const token = await appTokenFor(path.resolve(opts.dir));
      const res = await replayDelivery(id, token);
      const status = res.http_status ?? null;
      if (res.ok === false) {
        throw new Error(res.message ?? `Replay of delivery ${id} was rejected by the platform.`);
      }
      console.log(
        chalk.green(
          `✓ Replayed delivery ${id}` +
            (status === null ? ' (queued).' : ` — app responded ${status}.`),
        ),
      );
    });

  return cmd;
}

async function listCatalog(opts: { category?: string; type?: string }): Promise<void> {
  const catalog = await get<HookCatalog>('/api/apps/hooks', { noAuth: true });
  const names = Object.keys(catalog).sort();

  let rows = names.map((name) => ({ name, ...catalog[name]! }));
  if (opts.category) {
    rows = rows.filter((r) => r.category.toLowerCase() === opts.category!.toLowerCase());
  }
  if (opts.type) {
    rows = rows.filter((r) => (r.type ?? 'event') === opts.type);
  }

  if (rows.length === 0) {
    console.log(chalk.yellow('No hooks matched your filter.'));
    return;
  }

  const padName = Math.max(8, ...rows.map((r) => r.name.length));
  const padCat = Math.max(8, ...rows.map((r) => r.category.length));
  console.log(
    chalk.dim(`${'Hook'.padEnd(padName)}  ${'Category'.padEnd(padCat)}  Type        Description`),
  );
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(padName)}  ${r.category.padEnd(padCat)}  ${(r.type ?? 'event').padEnd(11)} ${r.description}`,
    );
  }
}

/**
 * Add/remove an event in the manifest's `[webhooks].events`. Pure toml editing
 * — nothing is sent to the platform here; the next sync does that.
 */
async function editSubscription(
  appDir: string,
  event: string,
  mode: 'add' | 'remove',
): Promise<void> {
  const manifest = await readManifest(appDir);
  const current = resolveWebhooks(manifest).events;

  if (mode === 'add' && current.includes(event)) {
    console.log(chalk.dim(`Already subscribed to ${event}.`));
    return;
  }
  if (mode === 'remove' && !current.includes(event)) {
    console.log(chalk.dim(`Not subscribed to ${event}.`));
    return;
  }

  const next =
    mode === 'add'
      ? [...new Set([...current, event])].sort()
      : current.filter((e) => e !== event);

  await writeWebhookEvents(appDir, next);
  console.log(
    chalk.green(
      `✓ ${mode === 'add' ? 'Subscribed to' : 'Unsubscribed from'} ${event} in flashmandu.app.toml.`,
    ),
  );
  console.log(
    chalk.dim('  Run `autohisab-business dev` (or `push`/`deploy`) to sync it to the platform.'),
  );
}

/**
 * The app's own api_token, when `dev` has been run in this directory. Falls
 * back to undefined (the login token) with a hint, mirroring `logs`.
 */
async function appTokenFor(appDir: string): Promise<string | undefined> {
  let slug: string;
  try {
    slug = (await readManifest(appDir)).slug;
  } catch {
    return undefined;
  }
  const { token } = await readSandboxIdentity(appDir, slug);
  if (!token) {
    console.log(
      chalk.dim(
        'No .flashmandu/sandbox-secrets file — using the login token. ' +
          'Run `autohisab-business dev` once for per-app delivery history.',
      ),
    );
  }
  return token;
}

/**
 * Status column for one attempt, as plain text plus the colour to paint it.
 * Text and colour are separate so the column can be padded on its VISIBLE
 * width — padding an already-coloured string counts the ANSI bytes.
 */
export function statusCell(row: DeliveryRecord): { text: string; paint: (s: string) => string } {
  if (row.dead_lettered) return { text: 'dead', paint: chalk.magenta };
  if (row.http_status === null || row.http_status === undefined) {
    return { text: '-', paint: chalk.yellow };
  }
  const text = String(row.http_status);
  if (row.succeeded) return { text, paint: chalk.green };
  if (row.http_status >= 500) return { text, paint: chalk.magenta };
  return { text, paint: chalk.red };
}

function attemptsCell(row: DeliveryRecord): string {
  if (row.attempts !== undefined) return String(row.attempts);
  if (row.attempt !== undefined) return String(row.attempt);
  return '-';
}

function latencyCell(row: DeliveryRecord): string {
  return row.duration_ms === undefined ? '-' : `${row.duration_ms}ms`;
}

/**
 * Render the delivery table. Exported so the column contract is unit-testable
 * without a network round-trip.
 */
export function formatDeliveries(rows: DeliveryRecord[]): string {
  const cells = rows.map((row) => {
    const status = statusCell(row);
    return {
      id: String(row.id ?? row.delivery_id ?? '-'),
      when: row.created_at ?? '',
      event: row.event,
      status: status.text,
      paint: status.paint,
      attempts: attemptsCell(row),
      latency: latencyCell(row),
    };
  });

  const padId = Math.max(2, ...cells.map((c) => c.id.length));
  const padWhen = Math.max(4, ...cells.map((c) => c.when.length));
  const padEvent = Math.max(5, ...cells.map((c) => c.event.length));
  const padStatus = Math.max(6, ...cells.map((c) => c.status.length));
  const padAttempts = 8;

  const header = chalk.dim(
    `${'ID'.padEnd(padId)}  ${'When'.padEnd(padWhen)}  ${'Event'.padEnd(padEvent)}  ` +
      `${'Status'.padEnd(padStatus)}  ${'Attempts'.padEnd(padAttempts)}  Latency`,
  );

  const lines = cells.map(
    (c) =>
      `${c.id.padEnd(padId)}  ${chalk.dim(c.when.padEnd(padWhen))}  ${chalk.cyan(c.event.padEnd(padEvent))}  ` +
      `${c.paint(c.status.padEnd(padStatus))}  ${c.attempts.padEnd(padAttempts)}  ${c.latency}`,
  );

  return [header, ...lines].join('\n');
}
