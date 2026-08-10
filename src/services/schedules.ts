/**
 * Declarative `[[schedules]]` support (capability spec §5).
 *
 * A schedule is a platform-side cron that pings the app: the host enqueues an
 * ordinary signed webhook with event `schedule.tick` and payload
 * `{ schedule, profile_id, scheduled_at }`. There is no new transport — the
 * same HMAC, retries, backoff and delivery log as every other webhook.
 *
 * The platform enforces these rules server-side; the CLI enforces them FIRST
 * so a developer sees a precise, local error instead of a 422 from the host.
 * Everything here is pure so it is trivially testable and reusable by
 * `dev`, `push` and `deploy` alike.
 */

/** Minimum interval the platform accepts between two ticks of one schedule. */
export const MIN_INTERVAL_SECONDS = 300;

/** Maximum number of `[[schedules]]` blocks a single app may declare. */
export const MAX_SCHEDULES = 5;

/** Schedule names are referenced in `schedule.tick` payloads, so keep them tame. */
export const SCHEDULE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

const EVERY_RE = /^(\d+)\s*(s|m|h|d)$/i;

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/** One `[[schedules]]` block from `flashmandu.app.toml`. */
export interface ScheduleEntry {
  name: string;
  /** Interval form, e.g. "15m", "2h". Mutually exclusive with `cron`. */
  every?: string;
  /** Cron form, 5 fields, evaluated in the profile timezone. */
  cron?: string;
}

/**
 * Parse an `every = "15m"` duration into seconds.
 *
 * @throws Error when the value is not `<positive integer><s|m|h|d>`.
 */
export function parseEvery(value: string): number {
  const match = EVERY_RE.exec(value.trim());
  if (!match) {
    throw new Error(
      `every = "${value}" is not a duration. Use <number><s|m|h|d>, e.g. every = "15m" or every = "2h".`,
    );
  }
  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  if (amount <= 0) {
    throw new Error(`every = "${value}" must be greater than zero.`);
  }
  return amount * UNIT_SECONDS[unit]!;
}

const CRON_FIELD_RE = /^[0-9*/,\-]+$/;

/**
 * Validate a 5-field cron expression well enough to catch typos locally. The
 * host owns the authoritative parse; this only rejects shapes that can never
 * be valid so the developer is not round-tripping to the platform for a typo.
 */
export function validateCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return `cron = "${expr}" must have exactly 5 fields (minute hour day month weekday), got ${fields.length}.`;
  }
  for (const field of fields) {
    if (!CRON_FIELD_RE.test(field)) {
      return `cron = "${expr}" has an unsupported field "${field}". Use numbers, "*", ranges (1-5), lists (1,3) and steps (*/15).`;
    }
  }
  return null;
}

/**
 * Validate every platform rule for a set of declared schedules and return the
 * full list of human-readable problems (empty array = valid). Returning all of
 * them at once means one `dev` run surfaces every mistake, not just the first.
 */
export function validateSchedules(schedules: ScheduleEntry[]): string[] {
  const errors: string[] = [];

  if (schedules.length > MAX_SCHEDULES) {
    errors.push(
      `Too many [[schedules]]: ${schedules.length} declared, the platform allows at most ${MAX_SCHEDULES} per app.`,
    );
  }

  const seen = new Map<string, number>();
  for (const [index, schedule] of schedules.entries()) {
    const where = `[[schedules]] #${index + 1}`;
    const name = (schedule.name ?? '').trim();

    if (name === '') {
      errors.push(`${where} is missing \`name\`. Every schedule needs a unique name.`);
    } else if (!SCHEDULE_NAME_RE.test(name)) {
      errors.push(
        `${where} name "${name}" must be lowercase alphanumeric + dashes (2-64 chars), e.g. name = "attendance-rollup".`,
      );
    } else if (seen.has(name)) {
      errors.push(
        `Duplicate schedule name "${name}" (${where} and [[schedules]] #${seen.get(name)! + 1}). Names must be unique per app — the tick payload identifies the schedule by name.`,
      );
    } else {
      seen.set(name, index);
    }

    const hasEvery = typeof schedule.every === 'string' && schedule.every.trim() !== '';
    const hasCron = typeof schedule.cron === 'string' && schedule.cron.trim() !== '';

    if (hasEvery && hasCron) {
      errors.push(
        `${where} ("${name}") declares both \`every\` and \`cron\`. Pick one — they are mutually exclusive.`,
      );
      continue;
    }
    if (!hasEvery && !hasCron) {
      errors.push(
        `${where} ("${name}") must declare either \`every = "15m"\` or \`cron = "0 18 * * *"\`.`,
      );
      continue;
    }

    if (hasEvery) {
      let seconds: number;
      try {
        seconds = parseEvery(schedule.every!);
      } catch (err) {
        errors.push(`${where} ("${name}"): ${(err as Error).message}`);
        continue;
      }
      if (seconds < MIN_INTERVAL_SECONDS) {
        errors.push(
          `${where} ("${name}") every = "${schedule.every}" is below the platform minimum of ` +
            `${MIN_INTERVAL_SECONDS / 60} minutes. Use every = "5m" or longer, or poll from inside your own tick handler.`,
        );
      }
      continue;
    }

    const cronError = validateCron(schedule.cron!);
    if (cronError) {
      errors.push(`${where} ("${name}"): ${cronError}`);
    }
  }

  return errors;
}

/**
 * Normalize schedules into the wire shape sent to the platform. `every` is
 * additionally resolved to `interval_seconds` so the host never has to reparse
 * the developer's duration string.
 */
export function toWireSchedules(
  schedules: ScheduleEntry[],
): Array<{ name: string; every?: string; interval_seconds?: number; cron?: string }> {
  return schedules.map((schedule) => {
    if (typeof schedule.every === 'string' && schedule.every.trim() !== '') {
      return {
        name: schedule.name,
        every: schedule.every.trim(),
        interval_seconds: parseEvery(schedule.every),
      };
    }
    return { name: schedule.name, cron: (schedule.cron ?? '').trim() };
  });
}

/** One-line human summary used by `dev`/`push` output. */
export function describeSchedule(schedule: ScheduleEntry): string {
  const cadence =
    typeof schedule.every === 'string' && schedule.every.trim() !== ''
      ? `every ${schedule.every.trim()}`
      : `cron ${schedule.cron?.trim() ?? '?'} (profile timezone)`;
  return `${schedule.name} — ${cadence}`;
}
