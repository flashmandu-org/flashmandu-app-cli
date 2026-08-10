import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/services/apiClient';
import { formatScheduleSyncFailure } from '../src/services/schedules';

/**
 * Regression cover for the bug where `[[schedules]]` declared in
 * flashmandu.app.toml never reached the platform: the CLI put a `schedules` key
 * in the `POST /api/apps/dev/register` payload, which that endpoint never
 * validated, so Laravel's validate() dropped it. `dev` printed a success line
 * while `GET /api/apps/schedules` returned an empty list.
 *
 * The contract now under test:
 *   1. `dev` register carries NO schedules key (one writer only).
 *   2. Schedules are posted to `POST /api/apps/schedules/sync` with the app's
 *      OWN api_token, not the developer login token.
 *   3. A platform rejection throws, naming the offending `[[schedules]]` block.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env.FLASHMANDU_BASE_URL_OVERRIDE = 'https://dev-box.test';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FLASHMANDU_BASE_URL_OVERRIDE;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as Response;
}

const manifest = {
  slug: 'showcase',
  name: 'Showcase',
  version: '1.0.0',
  scopes: [],
  schedules: [
    { name: 'reconcile', every: '15m' },
    { name: 'digest', cron: '0 3 * * *' },
  ],
} as never;

describe('syncManifestSchedules', () => {
  it('posts the manifest schedules to the dedicated sync endpoint', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        app_id: 'owner-1/showcase',
        installs: 1,
        schedules: [
          { name: 'digest', every: null, cron: '0 3 * * *', timezone: 'Asia/Kathmandu', state: 'active', disabled_reason: null },
          { name: 'reconcile', every: '15m', cron: null, timezone: 'Asia/Kathmandu', state: 'active', disabled_reason: null },
        ],
      }),
    );

    const { syncManifestSchedules } = await import('../src/services/appSync');
    const result = await syncManifestSchedules(manifest, 'app-token-123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://dev-box.test/api/apps/schedules/sync');
    expect(init.method).toBe('POST');

    // The platform derives the target app from the bearer, so this MUST be the
    // app's own token — the login token resolves to the dev/cli app.
    expect(init.headers.Authorization).toBe('Bearer app-token-123');

    expect(JSON.parse(init.body)).toEqual({
      schedules: [
        { name: 'reconcile', every: '15m', interval_seconds: 900 },
        { name: 'digest', cron: '0 3 * * *' },
      ],
    });
    expect(result.schedules.map((s) => s.name)).toEqual(['digest', 'reconcile']);
  });

  it('sends an empty list so a removed schedule is deleted, not left firing', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { app_id: 'owner-1/showcase', installs: 1, schedules: [] }),
    );

    const { syncManifestSchedules } = await import('../src/services/appSync');
    await syncManifestSchedules({ ...(manifest as object), schedules: [] } as never, 'tok');

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ schedules: [] });
  });

  it('throws (never resolves quietly) when the platform rejects a block', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        message: 'The schedules.1.cron field is invalid.',
        errors: { 'schedules.1.cron': ['`0 3 * * *` is not a valid cron expression.'] },
      }),
    );

    const { syncManifestSchedules } = await import('../src/services/appSync');
    await expect(syncManifestSchedules(manifest, 'tok')).rejects.toThrow(
      /\[\[schedules\]\] #2 \("digest"\)/,
    );
  });
});

describe('dev register payload', () => {
  it('no longer carries a `schedules` key the host would silently drop', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        installed: true,
        app_id: 'owner-1/showcase',
        api_token: 't',
        webhook_secret: 's',
        profile_id: 1,
      }),
    );

    const { registerSandbox } = await import('../src/services/devRegistrar');
    await registerSandbox({
      slug: 'showcase',
      name: 'Showcase',
      webhook_url: 'https://tunnel.test/webhooks',
      authorize_url: 'https://tunnel.test/oauth/authorize',
      token_url: 'https://tunnel.test/oauth/token',
      scopes: [],
      subscribed_events: [],
      token: 'login-token',
    } as never);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).not.toHaveProperty('schedules');
  });
});

describe('printSyncedSchedules', () => {
  /** Strip ANSI so assertions read against the visible text. */
  const plain = (t: string): string => t.replace(/\[[0-9;]*m/g, '');

  async function render(result: unknown): Promise<string> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m) => void lines.push(String(m)));
    const { printSyncedSchedules } = await import('../src/services/appSync');
    printSyncedSchedules(manifest, result as never);
    spy.mockRestore();
    return plain(lines.join('\n'));
  }

  it('reports the platform response, in the host shape, not the manifest', async () => {
    const out = await render({
      app_id: 'owner-1/showcase',
      installs: 1,
      schedules: [
        { name: 'digest', every: null, cron: '0 3 * * *', timezone: 'Asia/Kathmandu', state: 'active', disabled_reason: null },
        { name: 'reconcile', every: '15m', cron: null, timezone: 'Asia/Kathmandu', state: 'active', disabled_reason: null },
      ],
    });
    expect(out).toContain('2 live on 1 install(s)');
    expect(out).toContain('reconcile — every 15m [Asia/Kathmandu]');
    expect(out).toContain('digest — cron 0 3 * * * [Asia/Kathmandu]');
  });

  it('warns loudly when the sync matched no enabled install, so nothing is live', async () => {
    const out = await render({ app_id: 'owner-1/showcase', installs: 0, schedules: [] });
    expect(out).toContain('0 enabled installs');
    expect(out).toContain('NO schedule is live');
  });

  it('surfaces a platform-disabled schedule instead of showing it as healthy', async () => {
    const out = await render({
      app_id: 'owner-1/showcase',
      installs: 1,
      schedules: [
        { name: 'reconcile', every: '15m', cron: null, timezone: 'UTC', state: 'disabled', disabled_reason: 'too many dead-lettered ticks' },
      ],
    });
    expect(out).toContain('state: disabled — too many dead-lettered ticks');
  });
});

describe('formatScheduleSyncFailure', () => {
  const sent = [{ name: 'reconcile' }, { name: 'digest' }];

  it('names the block and the field for a per-index error', () => {
    const err = new ApiError(422, 'u', 'invalid', {
      errors: { 'schedules.0.every': ['The minimum schedule interval is 5 minutes.'] },
    });
    const out = formatScheduleSyncFailure(err, sent);
    expect(out).toContain('[[schedules]] #1 ("reconcile") `every`');
    expect(out).toContain('minimum schedule interval is 5 minutes');
    expect(out).toContain('NOT live');
  });

  it('reports a duplicate name against the block that repeated it', () => {
    const err = new ApiError(422, 'u', 'invalid', {
      errors: { 'schedules.1.name': ['Duplicate schedule name `digest`.'] },
    });
    expect(formatScheduleSyncFailure(err, sent)).toContain('[[schedules]] #2 ("digest") `name`');
  });

  it('renders the top-level over-limit error without an index', () => {
    const err = new ApiError(422, 'u', 'invalid', {
      errors: { schedules: ['An app may declare at most 5 schedules.'] },
    });
    const out = formatScheduleSyncFailure(err, sent);
    expect(out).toContain('[[schedules]]: An app may declare at most 5 schedules.');
    expect(out).not.toContain('#1');
  });

  it('falls back to the raw message for a non-validation failure', () => {
    const out = formatScheduleSyncFailure(new Error('Network error contacting dev box'), sent);
    expect(out).toContain('Network error contacting dev box');
  });
});
