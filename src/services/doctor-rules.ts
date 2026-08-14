import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { kitStatus } from './kit';

/**
 * `doctor` — static, offline checks over an app's source tree. Each rule
 * below maps to a real production incident recorded in the consolidation
 * spec (§4.6); the comment above each rule names it so a future dev knows
 * why the rule exists before deleting it.
 */

export type Severity = 'error' | 'warn';

export interface Finding {
  rule: string;
  ok: boolean;
  severity: Severity;
  detail?: string;
  file?: string;
  line?: number;
}

export interface DoctorRule {
  name: string;
  check(cwd: string): Finding[];
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.turbo']);

/** Recursively collect files under `dir` (relative to `cwd`) whose name matches `test`. */
function walk(cwd: string, dir: string, test: (relPath: string) => boolean, acc: string[] = []): string[] {
  const abs = path.join(cwd, dir);
  if (!existsSync(abs)) return acc;

  for (const entry of readdirSync(abs)) {
    const relPath = path.join(dir, entry);
    const absPath = path.join(cwd, relPath);
    const stat = statSync(absPath);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(cwd, relPath, test, acc);
    } else if (test(relPath)) {
      acc.push(relPath);
    }
  }
  return acc;
}

/** All non-vendor, non-generated source files under `cwd` matching one of the extensions. */
function sourceFiles(cwd: string, extensions: string[], opts: { includeVendor?: boolean } = {}): string[] {
  return walk(cwd, '.', (rel) => {
    /*
     * Skip vendored third-party code at ANY depth, not just a top-level
     * `vendor/`. Apps also vendor libraries under `public/vendor/…` (e.g.
     * interactive-map ships leaflet.css there), and scanning those produced
     * 7 false "off-scale font-size" findings against CSS the app does not own
     * and must not edit.
     */
    if (!opts.includeVendor && rel.split(path.sep).includes('vendor')) return false;
    return extensions.some((ext) => rel.endsWith(ext));
  });
}

function readLines(cwd: string, relPath: string): string[] {
  return readFileSync(path.join(cwd, relPath), 'utf8').split('\n');
}

function pass(rule: string): Finding {
  return { rule, ok: true, severity: 'error' };
}

function fail(rule: string, detail: string, opts: { file?: string; line?: number; severity?: Severity } = {}): Finding {
  return { rule, ok: false, severity: opts.severity ?? 'error', detail, file: opts.file, line: opts.line };
}

// ---------------------------------------------------------------------------
// 1. Incident: the template's old .fm-container fork silently redefined a
//    kit selector at 880px, diverging from the kit's own breakpoint and
//    fighting it in the cascade. App CSS must never redefine `.fm-*` — the
//    kit owns that namespace.
// ---------------------------------------------------------------------------
const noFmOverride: DoctorRule = {
  name: 'no-fm-override',
  check(cwd) {
    const findings: Finding[] = [];
    const files = sourceFiles(cwd, ['.css']);
    const selectorRe = /(^|[\s,{}])(\.fm-[a-zA-Z0-9_-]+)/;

    for (const file of files) {
      const lines = readLines(cwd, file);
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('/*') || trimmed.startsWith('//')) return;
        // Only selector lines redefine a rule — a line opening (or starting) a
        // ruleset with a `.fm-*` selector. Property usages (`var(--fm-…)`) are fine.
        const match = trimmed.match(selectorRe);
        if (match && (trimmed.includes('{') || /,\s*$/.test(trimmed))) {
          findings.push(
            fail('no-fm-override', `App CSS redefines kit selector "${match[2]}"`, {
              file,
              line: idx + 1,
            }),
          );
        }
      });
    }

    return findings.length > 0 ? findings : [pass('no-fm-override')];
  },
};

// ---------------------------------------------------------------------------
// 2. Incident: missing frame-ancestors/X-Frame-Options headers and
//    transpilePackages left the embed iframe rendering blank in every
//    shipped app until hand-fixed ("ORBIT LESSON #1").
// ---------------------------------------------------------------------------
const frameHeaders: DoctorRule = {
  name: 'frame-headers',
  check(cwd) {
    const rel = 'next.config.js';
    if (!existsSync(path.join(cwd, rel))) {
      return [fail('frame-headers', 'next.config.js not found', { file: rel })];
    }
    const content = readFileSync(path.join(cwd, rel), 'utf8');
    const missing: string[] = [];
    const hasHeadersFn = /headers\s*\(\s*\)/.test(content);
    if (!hasHeadersFn) missing.push('headers() block');
    if (!content.includes('frame-ancestors')) missing.push('frame-ancestors');
    if (!content.includes('X-Frame-Options')) missing.push('X-Frame-Options');
    if (!/transpilePackages/.test(content) || !content.includes('@flashmandu/app-bridge-ui')) {
      missing.push('transpilePackages including @flashmandu/app-bridge-ui');
    }

    if (missing.length > 0) {
      return [fail('frame-headers', `next.config.js missing: ${missing.join(', ')}`, { file: rel })];
    }
    return [pass('frame-headers')];
  },
};

// ---------------------------------------------------------------------------
// 3. Incident: a runtime setSidebarLinks() call shrinks the host admin
//    sidebar; manifest nav_items is the only supported path.
// ---------------------------------------------------------------------------
const noSidebarLinks: DoctorRule = {
  name: 'no-sidebar-links',
  check(cwd) {
    const findings: Finding[] = [];
    const files = sourceFiles(cwd, ['.ts', '.tsx', '.js', '.jsx']);
    for (const file of files) {
      const lines = readLines(cwd, file);
      lines.forEach((line, idx) => {
        if (line.includes('setSidebarLinks(')) {
          findings.push(
            fail('no-sidebar-links', 'Runtime setSidebarLinks() shrinks the host sidebar — use manifest nav_items', {
              file,
              line: idx + 1,
            }),
          );
        }
      });
    }
    return findings.length > 0 ? findings : [pass('no-sidebar-links')];
  },
};

// ---------------------------------------------------------------------------
// 4. Incident: apps hardcoded data-fm-theme="dark" to work around the old
//    dark-first-paint bug, permanently pinning dark mode instead of fixing
//    the fallback.
// ---------------------------------------------------------------------------
const noPinnedDark: DoctorRule = {
  name: 'no-pinned-dark',
  check(cwd) {
    const findings: Finding[] = [];
    for (const file of sourceFiles(cwd, ['.tsx'])) {
      const lines = readLines(cwd, file);
      lines.forEach((line, idx) => {
        if (line.includes('data-fm-theme="dark"')) {
          findings.push(
            fail('no-pinned-dark', 'data-fm-theme="dark" is hardcoded', { file, line: idx + 1 }),
          );
        }
      });
    }
    return findings.length > 0 ? findings : [pass('no-pinned-dark')];
  },
};

// ---------------------------------------------------------------------------
// 5. Incident: a 'use client' file importing an app-local value dragged
//    Prisma (and node:fs) into the client bundle.
// ---------------------------------------------------------------------------
function firstMeaningfulLine(lines: string[]): string | undefined {
  return lines.find((l) => l.trim() !== '' && !l.trim().startsWith('//'));
}

function resolveRelativeImport(cwd: string, fromFile: string, spec: string): string | undefined {
  const base = path.join(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  return candidates.find((c) => existsSync(path.join(cwd, c)));
}

const noClientPrisma: DoctorRule = {
  name: 'no-client-prisma',
  check(cwd) {
    const findings: Finding[] = [];
    const files = sourceFiles(cwd, ['.ts', '.tsx']);
    const importRe = /from\s+['"](\.[^'"]+)['"]/g;

    for (const file of files) {
      const content = readFileSync(path.join(cwd, file), 'utf8');
      const lines = content.split('\n');
      const first = firstMeaningfulLine(lines);
      if (!first || !/^['"]use client['"]/.test(first.trim())) continue;

      let match: RegExpExecArray | null;
      importRe.lastIndex = 0;
      while ((match = importRe.exec(content)) !== null) {
        const spec = match[1] as string;
        const resolved = resolveRelativeImport(cwd, file, spec);
        if (!resolved) continue;
        const importedContent = readFileSync(path.join(cwd, resolved), 'utf8');
        if (importedContent.includes('@prisma/client')) {
          findings.push(
            fail(
              'no-client-prisma',
              `'use client' file imports "${spec}" (${resolved}), which imports @prisma/client — drags node:fs into the client bundle`,
              { file },
            ),
          );
        }
      }
    }

    return findings.length > 0 ? findings : [pass('no-client-prisma')];
  },
};

// ---------------------------------------------------------------------------
// 6. Incident: re-serializing the webhook body (parsing then re-stringifying
//    JSON) before verifying broke the HMAC signature check.
// ---------------------------------------------------------------------------
const webhookRawBody: DoctorRule = {
  name: 'webhook-raw-body',
  check(cwd) {
    const files = walk(cwd, path.join('app', 'webhooks'), (rel) => rel.endsWith('route.ts'));
    const findings: Finding[] = [];

    for (const file of files) {
      const content = readFileSync(path.join(cwd, file), 'utf8');
      if (content.includes('createWebhookRoute(')) continue;

      const textIdx = content.indexOf('.text(');
      const jsonIdx = content.indexOf('.json(');

      if (textIdx === -1 || (jsonIdx !== -1 && jsonIdx < textIdx)) {
        findings.push(
          fail(
            'webhook-raw-body',
            'Webhook route must call req.text() before any req.json(), or use createWebhookRoute — re-serializing the body breaks the HMAC',
            { file },
          ),
        );
      }
    }

    return findings.length > 0 ? findings : [pass('webhook-raw-body')];
  },
};

// ---------------------------------------------------------------------------
// 7. Incident: stale hand-copied kit dists (see kit.ts / spec §2.2).
// ---------------------------------------------------------------------------
const kitCurrent: DoctorRule = {
  name: 'kit-current',
  check(cwd) {
    if (!existsSync(path.join(cwd, 'package.json'))) {
      return [fail('kit-current', 'package.json not found')];
    }
    const findings: Finding[] = [];
    for (const row of kitStatus(cwd)) {
      if (row.style === 'dir' || row.installed !== row.pinned) {
        findings.push(
          fail(
            'kit-current',
            `${row.short}: ${row.style} ${row.installed} (pinned ${row.pinned}) — run \`autohisab-business kit sync\``,
          ),
        );
      }
    }
    return findings.length > 0 ? findings : [pass('kit-current')];
  },
};

// ---------------------------------------------------------------------------
// 8. Incident: tokens.css/components.css imported directly (not index.css)
//    silently dropped the bundled Instrument Sans font in every app;
//    interactive-map additionally double-imported the kit CSS.
// ---------------------------------------------------------------------------
const KIT_CSS_RE = /@flashmandu\/app-bridge-ui\/dist\/(index|tokens|components|fonts)\.css/g;

const kitCssSingleEntry: DoctorRule = {
  name: 'kit-css-single-entry',
  check(cwd) {
    const files = sourceFiles(cwd, ['.ts', '.tsx', '.css']);
    const hits: { file: string; line: number; which: string }[] = [];

    for (const file of files) {
      const lines = readLines(cwd, file);
      lines.forEach((line, idx) => {
        KIT_CSS_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = KIT_CSS_RE.exec(line)) !== null) {
          hits.push({ file, line: idx + 1, which: match[1] as string });
        }
      });
    }

    if (hits.length === 0) {
      return [fail('kit-css-single-entry', 'No kit CSS import found — import @flashmandu/app-bridge-ui/dist/index.css once')];
    }
    if (hits.length > 1) {
      return [
        fail(
          'kit-css-single-entry',
          `Kit CSS imported ${hits.length} times (${hits.map((h) => `${h.file}:${h.line}`).join(', ')}) — import index.css exactly once`,
        ),
      ];
    }
    const only = hits[0] as { file: string; line: number; which: string };
    if (only.which !== 'index') {
      return [
        fail(
          'kit-css-single-entry',
          `Imports dist/${only.which}.css directly — import dist/index.css instead (it bundles the fonts)`,
          { file: only.file, line: only.line },
        ),
      ];
    }
    return [pass('kit-css-single-entry')];
  },
};

// ---------------------------------------------------------------------------
// 9. Incident: 22 off-kit <button> elements shipped across three apps,
//    unstyled or hand-styled, instead of using the kit's fm-btn family.
// ---------------------------------------------------------------------------
const kitButtonsOnly: DoctorRule = {
  name: 'kit-buttons-only',
  check(cwd) {
    const findings: Finding[] = [];
    for (const file of sourceFiles(cwd, ['.tsx'])) {
      const content = readFileSync(path.join(cwd, file), 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (!/<button\b/.test(line)) return;
        // The tag may span a few lines for its attributes — look ahead.
        const window = lines.slice(idx, idx + 5).join('\n');
        const tagEnd = window.indexOf('>');
        const tag = tagEnd === -1 ? window : window.slice(0, tagEnd + 1);
        if (!tag.includes('fm-btn')) {
          findings.push(
            fail('kit-buttons-only', 'Raw <button> without fm-btn className — use the kit button classes', {
              file,
              line: idx + 1,
            }),
          );
        }
      });
    }
    return findings.length > 0 ? findings : [pass('kit-buttons-only')];
  },
};

// ---------------------------------------------------------------------------
// 10. Incident: orbit used a native window.confirm() inside the embed
//     iframe — an OS dialog breaks the native-app illusion.
// ---------------------------------------------------------------------------
const noNativeDialogs: DoctorRule = {
  name: 'no-native-dialogs',
  check(cwd) {
    const findings: Finding[] = [];
    const dialogRe = /window\.(confirm|alert|prompt)\s*\(/;
    for (const file of sourceFiles(cwd, ['.ts', '.tsx', '.js', '.jsx'])) {
      const lines = readLines(cwd, file);
      lines.forEach((line, idx) => {
        const match = line.match(dialogRe);
        if (match) {
          findings.push(
            fail('no-native-dialogs', `window.${match[1]}() breaks the embed illusion — use host dialogs`, {
              file,
              line: idx + 1,
            }),
          );
        }
      });
    }
    return findings.length > 0 ? findings : [pass('no-native-dialogs')];
  },
};

// ---------------------------------------------------------------------------
// 11. Incident: interactive-map pinned data-fm-theme="light" in layout.tsx,
//     which blocks merchant dark mode now that light is the bridge default.
// ---------------------------------------------------------------------------
const noThemePin: DoctorRule = {
  name: 'no-theme-pin',
  check(cwd) {
    const findings: Finding[] = [];
    const files = walk(cwd, '.', (rel) => path.basename(rel) === 'layout.tsx');
    for (const file of files) {
      const lines = readLines(cwd, file);
      lines.forEach((line, idx) => {
        if (/data-fm-theme=/.test(line)) {
          findings.push(
            fail('no-theme-pin', 'layout.tsx pins data-fm-theme — light is the default since bridge 0.4.0', {
              file,
              line: idx + 1,
            }),
          );
        }
      });
    }
    return findings.length > 0 ? findings : [pass('no-theme-pin')];
  },
};

// ---------------------------------------------------------------------------
// 12. Incident: tours/orbit/interactive-map had zero loading.tsx/error.tsx/
//     not-found.tsx — every navigation felt dead while the route resolved.
// ---------------------------------------------------------------------------
function hasAncestorLoading(cwd: string, dir: string): boolean {
  let current = dir;
  for (;;) {
    if (existsSync(path.join(cwd, current, 'loading.tsx'))) return true;
    if (current === 'app' || current === '.') return false;
    current = path.dirname(current);
  }
}

const routeStates: DoctorRule = {
  name: 'route-states',
  check(cwd) {
    const findings: Finding[] = [];
    const pageFiles = walk(cwd, 'app', (rel) => path.basename(rel) === 'page.tsx');

    for (const page of pageFiles) {
      const dir = path.dirname(page);
      if (!hasAncestorLoading(cwd, dir)) {
        findings.push(fail('route-states', `${dir} has page.tsx but no loading.tsx (in itself or an ancestor)`, { file: dir }));
      }
    }

    if (!existsSync(path.join(cwd, 'app', 'error.tsx'))) {
      findings.push(fail('route-states', 'app/error.tsx is missing', { file: 'app/error.tsx' }));
    }
    if (!existsSync(path.join(cwd, 'app', 'not-found.tsx'))) {
      findings.push(fail('route-states', 'app/not-found.tsx is missing', { file: 'app/not-found.tsx' }));
    }

    return findings.length > 0 ? findings : [pass('route-states')];
  },
};

// ---------------------------------------------------------------------------
// 13. Incident: tours accumulated a 558-line parallel design system on top
//     of the kit instead of using kit primitives. Warns (does not fail).
// ---------------------------------------------------------------------------
const appCssBudget: DoctorRule = {
  name: 'app-css-budget',
  check(cwd) {
    const files = sourceFiles(cwd, ['.css']);
    let total = 0;
    let worst: { file: string; lines: number } | undefined;
    const badSelectors: string[] = [];

    for (const file of files) {
      const lines = readLines(cwd, file).filter((l) => l.trim() !== '');
      total += lines.length;
      if (!worst || lines.length > worst.lines) worst = { file, lines: lines.length };

      for (const line of lines) {
        const trimmed = line.trim();
        const selectorMatch = trimmed.match(/^([.#][a-zA-Z0-9_-]+)/);
        if (selectorMatch && trimmed.includes('{') && !trimmed.startsWith('.app-') && !trimmed.startsWith('#app-')) {
          badSelectors.push(trimmed);
        }
      }
    }

    if (total <= 150 && badSelectors.length === 0) {
      return [pass('app-css-budget')];
    }

    const parts: string[] = [];
    if (total > 150) {
      parts.push(`${total} non-kit CSS lines (budget 150), worst file: ${worst?.file ?? 'n/a'} (${worst?.lines ?? 0} lines)`);
    }
    if (badSelectors.length > 0) {
      parts.push(`${badSelectors.length} selector(s) not app- prefixed`);
    }

    return [fail('app-css-budget', parts.join('; '), { severity: 'warn' })];
  },
};

// ---------------------------------------------------------------------------
// 14. Incident: tours' app/globals.css carries 33 raw font-size declarations
//     (0.8rem ×4, 0.75rem ×3, etc.) instead of the kit's --fm-text-* scale,
//     so text renders at sizes the design system never defines, differently
//     in each app — the actual cause of "fonts look wrong" reports.
// ---------------------------------------------------------------------------
const FM_TEXT_VAR_RE = /^var\(\s*--fm-text-(xs|sm|base|lg|eyebrow)\s*(,[^)]*)?\)$/;
/*
 * `em` is permitted at any multiple, unlike `rem`/`px`. An em value is
 * relative to its parent's size, which on a kit-styled page is itself a
 * --fm-text-* token, so `0.85em` SCALES WITH the design system instead of
 * stepping outside it. The template's own `code, pre { font-size: 0.85em }`
 * is the canonical example — flagging it would make a freshly scaffolded app
 * fail its own doctor run. Absolute literals (rem/px/pt) are what break the
 * scale, and those still fail.
 */
const RELATIVE_KEYWORD_RE = /^(inherit|initial|unset|revert|100%|[0-9.]+em)$/;

/** True if a font-size value is permitted by the --fm-text-* scale rule. */
function isAllowedFontSizeValue(raw: string): boolean {
  const value = raw.trim().replace(/;$/, '').trim();
  if (FM_TEXT_VAR_RE.test(value)) return true;
  if (RELATIVE_KEYWORD_RE.test(value)) return true;
  return false;
}

const typographyScale: DoctorRule = {
  name: 'typography-scale',
  check(cwd) {
    const findings: Finding[] = [];

    for (const file of sourceFiles(cwd, ['.css'])) {
      const lines = readLines(cwd, file);
      lines.forEach((line, idx) => {
        const match = line.match(/font-size\s*:\s*([^;]+);?/);
        if (!match) return;
        const value = (match[1] as string).trim();
        if (isAllowedFontSizeValue(value)) return;
        findings.push(
          fail('typography-scale', `Raw font-size "${value}" is off the --fm-text-* scale`, {
            file,
            line: idx + 1,
          }),
        );
      });
    }

    for (const file of sourceFiles(cwd, ['.tsx'])) {
      const lines = readLines(cwd, file);
      lines.forEach((line, idx) => {
        const match = line.match(/fontSize\s*:\s*['"]([^'"]+)['"]/);
        if (!match) return;
        const value = (match[1] as string).trim();
        if (isAllowedFontSizeValue(value)) return;
        findings.push(
          fail('typography-scale', `Inline style fontSize "${value}" is off the --fm-text-* scale`, {
            file,
            line: idx + 1,
          }),
        );
      });
    }

    return findings.length > 0 ? findings : [pass('typography-scale')];
  },
};

export const DOCTOR_RULES: DoctorRule[] = [
  noFmOverride,
  frameHeaders,
  noSidebarLinks,
  noPinnedDark,
  noClientPrisma,
  webhookRawBody,
  kitCurrent,
  kitCssSingleEntry,
  kitButtonsOnly,
  noNativeDialogs,
  noThemePin,
  routeStates,
  appCssBudget,
  typographyScale,
];
