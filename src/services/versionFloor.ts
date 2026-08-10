import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BridgeVersionFloor } from './apiClient';

/**
 * Version-floor warnings for `@flashmandu/app-bridge` and
 * `@flashmandu/app-bridge-ui` (parity spec §8.2).
 *
 * The platform advertises the minimum bridge versions it supports; `dev` and
 * `push` compare the app's resolved versions against it and WARN. This is
 * never fatal — a floor the CLI cannot read, or a host that does not publish
 * one, must not block a developer's loop.
 */

/** The two packages the floor covers, in the order they are reported. */
export const BRIDGE_PACKAGES = ['@flashmandu/app-bridge', '@flashmandu/app-bridge-ui'] as const;

export type BridgePackage = (typeof BRIDGE_PACKAGES)[number];

/** Resolved versions keyed by the floor's short names. */
export interface InstalledBridgeVersions {
  'app-bridge'?: string;
  'app-bridge-ui'?: string;
}

/**
 * Parse `1.2.3`, `^1.2.3`, `~1.2`, `>=1.2.3 <2` into `[major, minor, patch]`.
 * Returns null for anything without a leading numeric version (workspace:*,
 * file:../x, git URLs) — those are developer-managed and never warned about.
 */
export function parseVersion(raw: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw.trim());
  if (!match) return null;
  if (!/^[\^~>=v\s]*\d/.test(raw.trim())) return null;
  return [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    match[3] ? Number.parseInt(match[3], 10) : 0,
  ];
}

/** -1 / 0 / 1 comparison of two semver-ish strings; null when uncomparable. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left[i]! !== right[i]!) return left[i]! < right[i]! ? -1 : 1;
  }
  return 0;
}

/**
 * Compare resolved versions against a floor and return one warning line per
 * package that is behind. Pure — the IO lives in {@link readBridgeVersions}.
 */
export function versionFloorWarnings(
  installed: InstalledBridgeVersions,
  floor: BridgeVersionFloor,
): string[] {
  const warnings: string[] = [];
  for (const full of BRIDGE_PACKAGES) {
    const key = full.replace('@flashmandu/', '') as keyof BridgeVersionFloor;
    const min = floor[key];
    const have = installed[key];
    if (!min || !have) continue;
    if (compareVersions(have, min) === -1) {
      warnings.push(
        `${full} ${have} is behind the platform floor ${min}. Run \`npm i ${full}@^${min}\` — ` +
          'older bridges miss protocol features the host now sends (page chrome, token refresh).',
      );
    }
  }
  return warnings;
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolve the bridge versions an app actually uses. The INSTALLED version in
 * `node_modules` wins over the declared range, because that is what ships.
 */
export async function readBridgeVersions(appDir: string): Promise<InstalledBridgeVersions> {
  const result: InstalledBridgeVersions = {};
  const pkg = await readJson(path.join(appDir, 'package.json'));
  const deps = {
    ...((pkg?.dependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg?.devDependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg?.peerDependencies as Record<string, string> | undefined) ?? {}),
  };

  for (const full of BRIDGE_PACKAGES) {
    const key = full.replace('@flashmandu/', '') as keyof InstalledBridgeVersions;
    const installed = await readJson(path.join(appDir, 'node_modules', full, 'package.json'));
    const version =
      (typeof installed?.version === 'string' ? installed.version : undefined) ?? deps[full];
    if (version && parseVersion(version)) {
      result[key] = version;
    }
  }

  return result;
}
