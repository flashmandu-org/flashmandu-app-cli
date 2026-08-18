import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Template npm scripts must run on cmd.exe and PowerShell, not just POSIX sh.
 *
 * THE BUG THIS LOCKS DOWN
 * -----------------------
 * `templates/next-js/package.json` shipped:
 *
 *   "dev":   "next dev -p ${PORT:-3000}"
 *   "start": "next start -p ${PORT:-3000}"
 *
 * npm runs scripts through the platform shell. On macOS/Linux (`sh`) the
 * parameter expansion resolves; on Windows npm uses cmd.exe, which performs no
 * `${VAR:-default}` expansion at all, so the literal string reached Next:
 *
 *   error: option '-p, --port <port>' argument '${PORT:-3000}' is invalid.
 *
 * Every scaffolded app was dead on arrival on Windows.
 *
 * THE RULE
 * --------
 * No POSIX-shell syntax in template scripts — no `${...}`, `$VAR`, `&&`/`||`
 * chaining around shell builtins, backticks, or single-quote quoting. Next
 * already honours the PORT env var for both `next dev` and `next start`, and
 * `dev.ts` sets PORT when it starts the app server, so `-p` was never needed.
 */
const TEMPLATES_DIR = path.join(__dirname, '..', 'src', 'templates');

const SHELL_ISMS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\$\{[^}]*\}/, label: 'POSIX parameter expansion (${VAR})' },
  { pattern: /\$[A-Za-z_][A-Za-z0-9_]*/, label: 'POSIX variable reference ($VAR)' },
  { pattern: /`/, label: 'backtick command substitution' },
];

async function packageJsonPaths(): Promise<string[]> {
  const entries = await fs.readdir(TEMPLATES_DIR, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(TEMPLATES_DIR, entry.name, 'package.json');
    try {
      await fs.access(candidate);
      found.push(candidate);
    } catch {
      // template has no package.json (php-remote) — nothing to check
    }
  }
  return found;
}

describe('template npm scripts', () => {
  it('contain no POSIX-shell-only syntax', async () => {
    const files = await packageJsonPaths();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const pkg = JSON.parse(await fs.readFile(file, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
        for (const { pattern, label } of SHELL_ISMS) {
          expect(
            pattern.test(script),
            `${path.relative(TEMPLATES_DIR, file)} script "${name}" uses ${label}: ${script}`,
          ).toBe(false);
        }
      }
    }
  });

  it('lets the CLI control the port via the PORT env var', async () => {
    const pkg = JSON.parse(
      await fs.readFile(path.join(TEMPLATES_DIR, 'next-js', 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(pkg.scripts?.dev).toBe('next dev');
    expect(pkg.scripts?.start).toBe('next start');
  });
});
