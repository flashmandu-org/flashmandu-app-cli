import { get } from './apiClient';

/**
 * Platform-hosted app pod logs. The platform reads Pod/log through its
 * RBAC-scoped ServiceAccount and returns them here; the developer never
 * touches the cluster. Scoped to the caller's own apps — another publisher's
 * app returns 404 (not 403) server-side.
 *
 * A scaled-to-zero app comes back with `running: false` and (typically) empty
 * logs — the flag is the signal, so the CLI never reads "no logs" as "no
 * errors".
 */
export interface PlatformLogsResponse {
  logs: string;
  running: boolean;
}

/** Fetch the platform-hosted app's pod logs. */
export function fetchPlatformLogs(appId: string): Promise<PlatformLogsResponse> {
  // app_id carries a slash ("<publisher>/<slug>"), so it rides on the query
  // string rather than the path.
  return get<PlatformLogsResponse>(
    `/api/apps/platform-apps/logs?app_id=${encodeURIComponent(appId)}`,
  );
}

/**
 * Render the platform logs response for the terminal. A not-running app gets
 * an explicit indicator so it is never mistaken for a clean bill of health.
 */
export function formatPlatformLogs(res: PlatformLogsResponse): string {
  const trimmed = (res.logs ?? '').trimEnd();
  if (res.running) {
    return trimmed.length > 0 ? trimmed : '(app is running; no log lines yet)';
  }
  const tail = trimmed.length > 0 ? `\n\n${trimmed}` : '';
  return `(app is not running — scaled to zero or crashed. showing the last available window.${tail})`;
}
