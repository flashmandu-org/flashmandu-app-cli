import { watch as watchFs, type FSWatcher } from 'node:fs';
import path from 'node:path';

import { ApiError, ENDPOINTS, put } from './apiClient';
import {
  MANIFEST_FILENAME,
  readManifest,
  resolveStorefrontSections,
  SectionBlueprintError,
  type AppManifest,
  type ResolvedStorefrontSection,
} from './manifest';

/**
 * Business logic for `autohisab-business section dev` — the no-server
 * iteration loop for an app author writing a `[[storefront_sections]]`
 * declaration as data. See `src/commands/section.ts` for the CLI surface and
 * `packages/flashmandu/apps/src/Http/Controllers/DevSectionsController.php`
 * (chiya-shots) for the endpoint this pushes to.
 *
 * The loop has three states per iteration, and each one must reach the
 * developer distinctly:
 *
 *  1. A `blueprint_file` fails to read or parse → {@link SectionBlueprintError}
 *     — reported with file + position, and the push MUST NOT happen. Pushing
 *     here would REPLACE the dev install's sections with whatever old/partial
 *     set the last successful resolve produced, silently clearing content the
 *     developer never asked to remove.
 *  2. The host validates the resolved trees and rejects one → 422 with a
 *     node-path message. That message is the entire point of the endpoint's
 *     error shape ({@see SectionPushRejected}) and must reach the terminal
 *     verbatim.
 *  3. Success → the host's `{synced, types}` response.
 */

export interface SectionsPushResult {
  synced: number;
  types: string[];
}

/** Injectable network call — tests substitute a fake to assert on the exact wire payload. */
export type SectionPusher = (
  sections: Array<Record<string, unknown>>,
  token: string | undefined,
) => Promise<SectionsPushResult>;

/** The real pusher: `PUT /api/apps/dev/sections`, authenticated with the app's own api_token. */
export const pushSectionsToHost: SectionPusher = (sections, token) =>
  put<SectionsPushResult>(ENDPOINTS.devSections, { sections }, token ? { token } : {});

/**
 * The wire shape one resolved section is sent as. Keys the resolver left
 * `undefined` are omitted rather than sent as `null` — the host's validator
 * (`AppSectionSynchronizer::toDefinition`) reads whichever keys are present
 * and a `null` category would overwrite a previous non-null one on re-sync.
 */
export function toWireSection(section: ResolvedStorefrontSection): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    type: section.type,
    name: section.name,
    source: section.source,
  };
  if (section.category !== undefined) wire.category = section.category;
  if (section.element_tree !== undefined) wire.element_tree = section.element_tree;
  if (section.settings !== undefined) wire.settings = section.settings;
  if (section.bindings !== undefined) wire.bindings = section.bindings;
  if (section.endpoint_path !== undefined) wire.endpoint_path = section.endpoint_path;
  if (section.schema_version !== undefined) wire.schema_version = section.schema_version;
  return wire;
}

/**
 * A push was refused by `DevSectionsController` (422). `serverMessage` is the
 * node-path-prefixed sentence from `InvalidSectionTree` verbatim
 * (`sections[0].children[2]: unknown node type 'script'`) — callers print it
 * as-is; rewriting it would cost the developer the position they need.
 */
export class SectionPushRejected extends Error {
  public readonly serverMessage: string;

  constructor(serverMessage: string, options?: { cause?: unknown }) {
    super(serverMessage);
    this.name = 'SectionPushRejected';
    this.serverMessage = serverMessage;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function extractRejectionMessage(err: ApiError): string {
  const body = err.body;
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return err.message;
}

export interface PushOnceOptions {
  /** The app's own api_token (from `.flashmandu/sandbox-secrets.*.json`). */
  token?: string;
  /** Injected for tests; defaults to the real network call. */
  pusher?: SectionPusher;
  /** Pre-read manifest, so callers that already have it don't re-read the file. */
  manifest?: AppManifest;
}

/**
 * One dev-loop iteration: read the manifest, inline every `blueprint_file`
 * into `element_tree`, and PUT the result.
 *
 * Throws {@link SectionBlueprintError} on malformed local JSON (never
 * reaches the pusher) and {@link SectionPushRejected} on a 422. Any other
 * network/host error propagates as-is.
 */
export async function pushOnce(
  appDir: string,
  opts: PushOnceOptions = {},
): Promise<SectionsPushResult> {
  const manifest = opts.manifest ?? (await readManifest(appDir));
  const declared = manifest.storefront_sections ?? [];
  const resolved = await resolveStorefrontSections(appDir, declared);
  const payload = resolved.map(toWireSection);
  const pusher = opts.pusher ?? pushSectionsToHost;

  try {
    return await pusher(payload, opts.token);
  } catch (err) {
    if (err instanceof ApiError && err.status === 422) {
      throw new SectionPushRejected(extractRejectionMessage(err), { cause: err });
    }
    throw err;
  }
}

export type SectionDevEventType = 'pushed' | 'blueprint-error' | 'rejected' | 'error';

export interface SectionDevEvent {
  type: SectionDevEventType;
  message: string;
  result?: SectionsPushResult;
}

export type SectionDevListener = (event: SectionDevEvent) => void;

/**
 * Run one push and report the outcome through `onEvent` instead of throwing —
 * the watch loop must survive a bad edit (or a rejected tree) and keep
 * watching for the next save, exactly like a bundler's compile-error overlay.
 */
export async function runAndReport(
  appDir: string,
  opts: PushOnceOptions,
  onEvent: SectionDevListener,
): Promise<void> {
  try {
    const result = await pushOnce(appDir, opts);
    const summary =
      result.types.length > 0
        ? `synced ${result.synced} section(s): ${result.types.join(', ')}`
        : `synced 0 sections (no [[storefront_sections]] declared)`;
    onEvent({ type: 'pushed', message: summary, result });
  } catch (err) {
    if (err instanceof SectionBlueprintError) {
      onEvent({ type: 'blueprint-error', message: err.message });
      return;
    }
    if (err instanceof SectionPushRejected) {
      onEvent({ type: 'rejected', message: err.serverMessage });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    onEvent({ type: 'error', message });
  }
}

export interface SectionWatchHandle {
  close: () => void;
}

export interface WatchSectionsOptions extends PushOnceOptions {
  /** Coalesce a burst of fs events (editors often fire several per save). */
  debounceMs?: number;
}

/**
 * Watch the manifest and every declared `blueprint_file` for changes,
 * re-pushing on each save.
 *
 * Directory-level watches, not per-file: `fs.watch` on a file that does not
 * exist yet throws ENOENT, which would silently blind the loop to a
 * `blueprint_file` the developer is about to create. Watching each target's
 * PARENT directory catches creation, edits, and deletion uniformly, and the
 * manifest's own directory (the app dir) is watched unconditionally since a
 * section can be added to the manifest before its file exists.
 *
 * The watched set is rebuilt after every successful manifest read — sections
 * added or removed from the manifest change which directories matter.
 */
export function watchSections(
  appDir: string,
  opts: WatchSectionsOptions,
  onEvent: SectionDevListener,
): SectionWatchHandle {
  const debounceMs = opts.debounceMs ?? 150;
  const watchers = new Map<string, FSWatcher>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let running = false;
  let pending = false;

  const tick = async (): Promise<void> => {
    if (closed) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      await runAndReport(appDir, opts, onEvent);
      await rebuildWatchers();
    } finally {
      running = false;
      if (pending && !closed) {
        pending = false;
        void tick();
      }
    }
  };

  const scheduleRun = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), debounceMs);
  };

  const rebuildWatchers = async (): Promise<void> => {
    const dirs = new Set<string>([appDir]);
    try {
      const manifest = await readManifest(appDir);
      for (const section of manifest.storefront_sections ?? []) {
        if (section.blueprint_file) {
          const file = path.isAbsolute(section.blueprint_file)
            ? section.blueprint_file
            : path.join(appDir, section.blueprint_file);
          dirs.add(path.dirname(file));
        }
      }
    } catch {
      // Manifest is currently broken (bad TOML) — still watch the app dir so
      // a fix to the manifest itself retriggers the loop.
    }

    for (const [dir, watcher] of watchers) {
      if (!dirs.has(dir)) {
        watcher.close();
        watchers.delete(dir);
      }
    }
    for (const dir of dirs) {
      if (closed || watchers.has(dir)) continue;
      try {
        const watcher = watchFs(dir, () => scheduleRun());
        watchers.set(dir, watcher);
      } catch {
        // Directory does not exist yet — picked up once its parent's watcher
        // fires and a later rebuild finds it.
      }
    }
  };

  void rebuildWatchers().then(() => void tick());

  return {
    close: (): void => {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}

/** Absolute path to the manifest file, for callers that want to watch it directly. */
export function manifestPath(appDir: string): string {
  return path.join(appDir, MANIFEST_FILENAME);
}
