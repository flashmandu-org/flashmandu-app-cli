import chalk from 'chalk';
import {
  fetchBridgeVersionFloor,
  syncSchedules,
  type ScheduleSyncResult,
} from './apiClient';
import { resolveWebhooks, type AppManifest, type ResolvedWebhooks } from './manifest';
import {
  describeSchedule,
  formatScheduleSyncFailure,
  toWireSchedules,
  type ScheduleEntry,
} from './schedules';
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
 * How the calling command treats `[[schedules]]`.
 *
 * `dev` actually syncs them (see {@link syncManifestSchedules}), so it prints
 * the platform's confirmation instead of the manifest. `push`/`deploy` do NOT:
 * schedules are materialized per enabled install, and at submission time no
 * install exists — so printing them as if they were live is a lie, and the
 * caller says so explicitly.
 */
export type ScheduleReporting = 'synced-separately' | 'not-applied';

/**
 * Print what is about to be synced, plus the one warning that matters: a
 * legacy `subscribed_events` list that disagrees with `[webhooks].events`.
 * Silent when the app declares neither.
 */
export function printAppConfigSync(
  manifest: AppManifest,
  reporting: ScheduleReporting = 'not-applied',
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

  if (schedules.length === 0 || reporting === 'synced-separately') {
    return;
  }

  for (const schedule of schedules) {
    console.log(chalk.dim(`  schedule → ${describeSchedule(schedule)} (declared, not applied)`));
  }
  console.log(
    chalk.yellow(
      '! `push`/`deploy` do not activate [[schedules]] — the platform materializes them per\n' +
        '  enabled install, and a submission has none yet. Run `autohisab-business dev` to sync\n' +
        '  them onto your sandbox install; marketplace-install provisioning is not wired up yet.',
    ),
  );
}

/**
 * Push the manifest's `[[schedules]]` to the platform and report what it
 * actually stored.
 *
 * This is the ONLY writer of an app's schedules. `dev`'s register call does not
 * carry them: `POST /api/apps/dev/register` never read the key, so declaring a
 * schedule looked synced while `GET /api/apps/schedules` stayed empty. The
 * dedicated endpoint is also the only one that validates them, so a bad cron or
 * a sub-5-minute interval fails here, loudly, instead of vanishing.
 *
 * `appToken` must be the app's OWN api_token (from the register response), not
 * the developer login token — the platform derives the target app id from the
 * bearer, and the login token resolves to the dev/cli app.
 *
 * @throws Error with a per-block explanation when the platform refuses.
 */
export async function syncManifestSchedules(
  manifest: AppManifest,
  appToken: string,
): Promise<ScheduleSyncResult> {
  const wire = toWireSchedules(manifest.schedules ?? []);

  try {
    return await syncSchedules(wire, appToken);
  } catch (err) {
    throw new Error(formatScheduleSyncFailure(err, wire));
  }
}

/**
 * Report what the platform stored, read back from its own response rather than
 * from the manifest — the whole point of the bug this replaced is that the two
 * can disagree.
 */
export function printSyncedSchedules(manifest: AppManifest, result: ScheduleSyncResult): void {
  // An app that declares nothing has nothing to report; the replace still ran
  // (that is how a removed schedule stops firing), it is just not news.
  if ((manifest.schedules ?? []).length === 0 && result.schedules.length === 0) {
    return;
  }

  console.log(
    chalk.green(`  schedules synced (${result.schedules.length} live on ${result.installs} install(s)):`),
  );
  for (const schedule of result.schedules) {
    const cadence = schedule.every ? `every ${schedule.every}` : `cron ${schedule.cron ?? '?'}`;
    const tz = schedule.timezone ? ` [${schedule.timezone}]` : '';
    const next = schedule.next_run_at ? `, next ${schedule.next_run_at}` : '';
    console.log(chalk.dim(`    ${schedule.name} — ${cadence}${tz}${next}`));
    // A schedule the platform auto-disabled after repeated dead-lettered ticks
    // comes back active from a sync, but say what happened so the developer
    // knows their endpoint was the reason it stopped.
    if (schedule.state !== 'active') {
      console.log(
        chalk.yellow(`      state: ${schedule.state}${schedule.disabled_reason ? ` — ${schedule.disabled_reason}` : ''}`),
      );
    }
  }

  // A sync that lands on zero installs stored nothing. Say so — the developer
  // would otherwise read "synced" and wait forever for a tick.
  if (result.installs === 0) {
    console.log(
      chalk.yellow(
        '! The sync matched 0 enabled installs, so NO schedule is live. Check that the app is\n' +
          '  installed and enabled on your sandbox profile, then re-run.',
      ),
    );
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
