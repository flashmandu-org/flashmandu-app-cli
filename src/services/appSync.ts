import chalk from 'chalk';
import { fetchBridgeVersionFloor } from './apiClient';
import { resolveWebhooks, type AppManifest, type ResolvedWebhooks } from './manifest';
import { describeSchedule, toWireSchedules, type ScheduleEntry } from './schedules';
import { readBridgeVersions, versionFloorWarnings } from './versionFloor';

/**
 * The declarative half of `flashmandu.app.toml` — `[webhooks]` and
 * `[[schedules]]` — resolved into the wire shape every sync path
 * (`dev` register, `push`/`deploy` submit) attaches to its payload.
 *
 * The CLI is the SINGLE writer of both: nothing else mutates an app's
 * subscription or its schedules, so what is in the toml is what the platform
 * has after the next run.
 */
export interface AppConfigSync {
  webhook_url: string;
  subscribed_events: string[];
  schedules: Array<{ name: string; every?: string; interval_seconds?: number; cron?: string }>;
}

/** Build the sync payload fragment for a manifest. */
export function buildAppConfigSync(manifest: AppManifest): AppConfigSync {
  const webhooks = resolveWebhooks(manifest);
  return {
    webhook_url: webhooks.url,
    subscribed_events: webhooks.events,
    schedules: toWireSchedules(manifest.schedules ?? []),
  };
}

/**
 * Print what is about to be synced, plus the one warning that matters: a
 * legacy `subscribed_events` list that disagrees with `[webhooks].events`.
 * Silent when the app declares neither.
 */
export function printAppConfigSync(
  manifest: AppManifest,
  webhooks: ResolvedWebhooks = resolveWebhooks(manifest),
): void {
  const schedules: ScheduleEntry[] = manifest.schedules ?? [];

  if (webhooks.conflict) {
    console.log(
      chalk.yellow(
        '! Both `subscribed_events` and `[webhooks].events` are declared and they differ. ' +
          'The `[webhooks]` section wins — delete the top-level `subscribed_events` key to silence this.',
      ),
    );
  }

  if (webhooks.events.length > 0) {
    console.log(
      chalk.dim(
        `  webhooks → ${webhooks.url}\n    ${webhooks.events.join(', ')}`,
      ),
    );
  }

  for (const schedule of schedules) {
    console.log(chalk.dim(`  schedule → ${describeSchedule(schedule)}`));
  }
}

/**
 * Warn (never fail) when the app's bridge packages are behind the platform's
 * supported floor. Called by `dev` and `push`.
 */
export async function warnOnBridgeVersionFloor(appDir: string): Promise<void> {
  const [floor, installed] = await Promise.all([
    fetchBridgeVersionFloor(),
    readBridgeVersions(appDir),
  ]);

  for (const warning of versionFloorWarnings(installed, floor)) {
    console.log(chalk.yellow(`! ${warning}`));
  }
}
