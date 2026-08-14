import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { PINNED_KITS } from './kit-versions';

/**
 * `kit status` / `kit sync` — the bridge SDK packages (`@flashmandu/app-bridge`,
 * `@flashmandu/app-bridge-ui`) are still not on npm (spec §2.2), so every app
 * vendors them under `vendor/`. Before this file existed, three apps hand-copied
 * `dist/` into `vendor/app-bridge{,-ui}/` (which silently goes stale — one
 * shipped app was missing `legacy.css`) and one used a `.tgz`. This is the one
 * place that knows how an app SHOULD vendor the kit: a tgz matching the
 * CLI-pinned version in `kit-versions.ts`, installed via `file:vendor/*.tgz`.
 */

/** Assets shipped with the CLI itself — see `package.json` `files`. */
const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets', 'kits');

export type KitStyle = 'tgz' | 'dir' | 'npm' | 'missing';

export interface KitStatusRow {
  name: string;
  short: string;
  installed: string;
  pinned: string;
  style: KitStyle;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

function readPackageJson(cwd: string): PackageJson {
  return JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as PackageJson;
}

/** `@flashmandu/app-bridge` → `app-bridge`. */
function shortName(name: string): string {
  return name.replace('@flashmandu/', '');
}

/** `@flashmandu/app-bridge` + `0.4.0` → `flashmandu-app-bridge-0.4.0.tgz` (npm-pack's naming). */
export function tgzFilename(name: string, version: string): string {
  return `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
}

/**
 * Read the app's `package.json` and report, per pinned kit package, whether
 * it is vendored as a pinned-version tgz, a (potentially stale) directory
 * copy, a plain npm dependency, or missing entirely.
 */
export function kitStatus(cwd: string): KitStatusRow[] {
  const pkg = readPackageJson(cwd);

  return Object.entries(PINNED_KITS).map(([name, pinned]) => {
    const dep = pkg.dependencies?.[name];
    const short = shortName(name);

    let style: KitStyle = 'missing';
    let installed = 'none';

    if (dep?.startsWith('file:vendor/') && dep.endsWith('.tgz')) {
      style = 'tgz';
      installed = dep.match(/-(\d+\.\d+\.\d+)\.tgz$/)?.[1] ?? 'unknown';
    } else if (dep?.startsWith('file:vendor/')) {
      style = 'dir';
      const vendoredPkg = path.join(cwd, dep.slice('file:'.length), 'package.json');
      installed = existsSync(vendoredPkg)
        ? ((JSON.parse(readFileSync(vendoredPkg, 'utf8')) as { version?: string }).version ??
          'unknown')
        : 'unknown';
    } else if (dep) {
      style = 'npm';
      installed = dep;
    }

    return { name, short, installed, pinned, style };
  });
}

/** Injectable so tests can assert `npm install` was invoked without running it. */
export type Runner = (cmd: string, args: string[], cwd: string) => void;

export const defaultRunner: Runner = (cmd, args, cwd) => {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
};

/**
 * Rewrite the app onto the pinned tgz-vendored kits: copy the tarballs from
 * this CLI's `assets/kits/` into the app's `vendor/`, point the two `file:`
 * deps at them, delete the legacy `vendor/app-bridge{,-ui}/` directory copies,
 * and `npm install`.
 */
export function kitSync(cwd: string, run: Runner = defaultRunner, assetsDir: string = ASSETS_DIR): void {
  const pkgPath = path.join(cwd, 'package.json');
  const pkg = readPackageJson(cwd);
  pkg.dependencies = pkg.dependencies ?? {};

  for (const [name, pinned] of Object.entries(PINNED_KITS)) {
    const tgz = tgzFilename(name, pinned);
    cpSync(path.join(assetsDir, tgz), path.join(cwd, 'vendor', tgz));

    // Retire directory-style vendoring (spec §2.2 — the silently-stale copies).
    rmSync(path.join(cwd, 'vendor', shortName(name)), { recursive: true, force: true });

    pkg.dependencies[name] = `file:vendor/${tgz}`;
  }

  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  run('npm', ['install'], cwd);
}
