import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import * as TOML from '@iarna/toml';

import { kitStatus } from './kit';
import { stripComments, stripCommentsLines } from './commentStrip';
import {
  MANIFEST_FILENAME,
  ManifestSchema,
  SectionBlueprintError,
  resolveStorefrontSectionsSync,
  type StorefrontSection,
} from './manifest';

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

/**
 * Comment-stripped lines of a source file, indexed identically to the raw
 * file (see `commentStrip.ts` — a doctor rule that greps a line inside a
 * comment explaining the very thing the rule polices is a false positive).
 * CSS has no `//` comment syntax, so `.css` files keep `//` literal (it shows
 * up inside `url(http://…)`).
 */
function codeLines(cwd: string, relPath: string): string[] {
  const raw = readFileSync(path.join(cwd, relPath), 'utf8');
  return stripCommentsLines(raw, { lineComments: !relPath.endsWith('.css') });
}

/** Comment-stripped whole-file content, for rules that scan across lines. */
function codeContent(cwd: string, relPath: string): string {
  const raw = readFileSync(path.join(cwd, relPath), 'utf8');
  return stripComments(raw, { lineComments: !relPath.endsWith('.css') });
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
      const lines = codeLines(cwd, file);
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed === '') return;
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
    const content = codeContent(cwd, rel);
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
      const lines = codeLines(cwd, file);
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
      const lines = codeLines(cwd, file);
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
      const content = codeContent(cwd, file);
      const lines = content.split('\n');
      const first = firstMeaningfulLine(lines);
      if (!first || !/^['"]use client['"]/.test(first.trim())) continue;

      let match: RegExpExecArray | null;
      importRe.lastIndex = 0;
      while ((match = importRe.exec(content)) !== null) {
        const spec = match[1] as string;
        const resolved = resolveRelativeImport(cwd, file, spec);
        if (!resolved) continue;
        const importedContent = codeContent(cwd, resolved);
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
//
// False positive (verified against showcase, 2026-08-14): the rule flagged
// every `app/webhooks/**/route.ts`, including
// `app/webhooks/purge-status/route.ts` — an unauthenticated GET status
// endpoint that receives no webhook delivery, has no `Request` body, and
// takes no `req` parameter at all. It can never have an HMAC to verify, so
// applying a body-ordering rule to it is meaningless.
//
// The rule's real subject is a webhook RECEIVER: a route that handles a
// request with a body. The only reliable static signal for that is which
// HTTP method handlers the file exports — a POST/PUT/PATCH handler takes a
// body, a GET/HEAD-only file never does. So: exempt any route.ts that
// exports no POST/PUT/PATCH handler, keep flagging one that does and calls
// req.json() before req.text() (and isn't built on createWebhookRoute).
// ---------------------------------------------------------------------------
const BODY_METHOD_RE = /export\s+(?:async\s+)?function\s+(?:POST|PUT|PATCH)\b|export\s+const\s+\{[^}]*\b(?:POST|PUT|PATCH)\b[^}]*\}|export\s+const\s+(?:POST|PUT|PATCH)\b/;

/** True if `content` exports a POST/PUT/PATCH route handler (a body-bearing method). */
function exportsBodyMethod(content: string): boolean {
  return BODY_METHOD_RE.test(content);
}

const webhookRawBody: DoctorRule = {
  name: 'webhook-raw-body',
  check(cwd) {
    const files = walk(cwd, path.join('app', 'webhooks'), (rel) => rel.endsWith('route.ts'));
    const findings: Finding[] = [];

    for (const file of files) {
      const content = codeContent(cwd, file);
      if (content.includes('createWebhookRoute(')) continue;
      // A file with no POST/PUT/PATCH handler never receives a body to
      // verify — GET/HEAD-only status or read endpoints are exempt.
      if (!exportsBodyMethod(content)) continue;

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
//
// False positive (verified against showcase, 2026-08-14): showcase's
// `tests/parity/class-contract.test.ts` (and `tests/kit/kit-exports.ts`)
// `readFileSync`s the kit's dist CSS/JS files by path to assert class-name
// contracts, e.g. `readFileSync(path.join(ROOT,
// 'node_modules/@flashmandu/app-bridge-ui/dist/components.css'))`. The old
// regex matched the bare path STRING anywhere in a line, so those
// `readFileSync` calls counted as extra kit CSS imports and the app was
// reported as importing the kit 2-3 times when it genuinely imports it once
// (`app/globals.css`: `@import "@flashmandu/app-bridge-ui/dist/index.css";`).
//
// Fix: only count genuine import statements — a CSS `@import "…"` in a
// stylesheet, or an ES `import …from '…'` / bare `import '…'` / `require('…')`
// side-effect import in a source file — never an arbitrary string occurrence
// such as inside a `readFileSync(...)` argument. Test files are additionally
// excluded outright: a test asserting things ABOUT the kit's CSS (reading it
// to check class names) is not the app importing it, regardless of what
// string literals happen to appear in the assertion.
// ---------------------------------------------------------------------------
const KIT_CSS_PATH_RE = /@flashmandu\/app-bridge-ui\/dist\/(index|tokens|components|fonts)\.css/;
const CSS_AT_IMPORT_RE = new RegExp(`@import\\s+["'][^"']*${KIT_CSS_PATH_RE.source}[^"']*["']`);
const JS_IMPORT_RE = new RegExp(`import\\s+(?:[\\w*{}\\s,]+from\\s+)?["'][^"']*${KIT_CSS_PATH_RE.source}[^"']*["']`);
const JS_REQUIRE_RE = new RegExp(`require\\(\\s*["'][^"']*${KIT_CSS_PATH_RE.source}[^"']*["']\\s*\\)`);

/** True if `rel` is a test file — assertions ABOUT the kit are not the app importing it. */
function isTestFile(rel: string): boolean {
  const normalized = rel.split(path.sep).join('/');
  if (normalized.startsWith('tests/') || normalized.includes('/tests/')) return true;
  const base = path.basename(rel);
  return /\.(test|spec)\.[jt]sx?$/.test(base);
}

const kitCssSingleEntry: DoctorRule = {
  name: 'kit-css-single-entry',
  check(cwd) {
    const files = sourceFiles(cwd, ['.ts', '.tsx', '.css']).filter((rel) => !isTestFile(rel));
    const hits: { file: string; line: number; which: string }[] = [];

    for (const file of files) {
      const lines = codeLines(cwd, file);
      const isCss = file.endsWith('.css');
      lines.forEach((line, idx) => {
        const importRe = isCss ? CSS_AT_IMPORT_RE : JS_IMPORT_RE;
        const match = line.match(importRe) ?? (isCss ? null : line.match(JS_REQUIRE_RE));
        if (match) {
          const which = (match[0].match(KIT_CSS_PATH_RE)?.[1] as string) ?? 'index';
          hits.push({ file, line: idx + 1, which });
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
      const content = codeContent(cwd, file);
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
      const lines = codeLines(cwd, file);
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
      const lines = codeLines(cwd, file);
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
      const lines = codeLines(cwd, file).filter((l) => l.trim() !== '');
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
      const lines = codeLines(cwd, file);
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
      const lines = codeLines(cwd, file);
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

// ---------------------------------------------------------------------------
// 15. Incident: bridge-ui's <Page> publishes page chrome (title, breadcrumbs,
//     actions, the dirty ⇄ Save/Discard swap) to the host command bar through
//     a pluggable hook that starts as an internal no-op — bridge-ui cannot
//     import @flashmandu/app-bridge itself (it is also consumed as a bare
//     stylesheet by PHP/Python runtimes), so every app must wire the hook
//     once via `configurePageChrome(usePageChrome)`. Orbit was migrated onto
//     <Page> and this wiring was never added: it type-checked, 127/127 tests
//     passed, `next build` succeeded, and all 14 prior doctor rules reported
//     clean — every page's chrome published to nothing, silently emptying
//     the host command bar across the whole app. A second, independently
//     verified failure mode governs where the call may live: it must sit
//     inside a real 'use client' module that app/layout.tsx renders as JSX,
//     never called at module scope in layout.tsx itself (a Server
//     Component) — Next's RSC compiler swaps client-module exports for
//     opaque proxies in the server graph, so calling the proxy directly
//     fails `next build` page-data collection with a minified
//     `TypeError: o is not a function` (hit both the template and tours).
// ---------------------------------------------------------------------------
const PAGE_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"]@flashmandu\/app-bridge-ui\/react['"]/g;

/** True if `file` has a real (non-comment) named import of `Page` or `FormPage` from bridge-ui/react. */
function importsPageComponent(cwd: string, file: string): boolean {
  const content = codeContent(cwd, file);
  PAGE_IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PAGE_IMPORT_RE.exec(content)) !== null) {
    const names = (match[1] as string)
      .split(',')
      .map((n) => n.trim().split(/\s+as\s+/)[0]?.trim())
      .filter(Boolean);
    if (names.includes('Page') || names.includes('FormPage')) return true;
  }
  return false;
}

/** Top-level `export function Name` / `export const Name` identifiers in raw source. */
function exportedNames(content: string): string[] {
  const names: string[] = [];
  const fnRe = /export\s+function\s+(\w+)/g;
  const constRe = /export\s+const\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(content)) !== null) names.push(m[1] as string);
  while ((m = constRe.exec(content)) !== null) names.push(m[1] as string);
  return names;
}

const pageChromeWired: DoctorRule = {
  name: 'page-chrome-wired',
  check(cwd) {
    const files = sourceFiles(cwd, ['.ts', '.tsx', '.js', '.jsx']);

    // Rule only applies to apps that actually render <Page> — an app that
    // never imports it needs no wiring.
    const usesPage = files.some((file) => importsPageComponent(cwd, file));
    if (!usesPage) return [pass('page-chrome-wired')];

    const callSites: { file: string; line: number }[] = [];
    for (const file of files) {
      const lines = codeLines(cwd, file);
      lines.forEach((line, idx) => {
        if (line.includes('configurePageChrome(')) {
          callSites.push({ file, line: idx + 1 });
        }
      });
    }

    if (callSites.length === 0) {
      return [
        fail(
          'page-chrome-wired',
          'App imports <Page> from @flashmandu/app-bridge-ui/react but never calls configurePageChrome(usePageChrome) — <Page> falls back to a no-op hook and its chrome never reaches the host command bar',
        ),
      ];
    }

    const findings: Finding[] = [];
    const validFiles: string[] = [];

    for (const { file, line } of callSites) {
      const content = codeContent(cwd, file);
      const first = firstMeaningfulLine(content.split('\n'));
      const startsClient = !!first && /^['"]use client['"]/.test(first.trim());
      if (!startsClient) {
        findings.push(
          fail(
            'page-chrome-wired',
            "configurePageChrome(...) is called in a file that does not start with 'use client' — it must be a real client module rendered as JSX from app/layout.tsx, never called at Server Component module scope",
            { file, line },
          ),
        );
      } else {
        validFiles.push(file);
      }
    }

    if (validFiles.length === 0) {
      return findings;
    }

    // Best-effort, warn-only: does any validly-wired module get referenced
    // from a layout.tsx anywhere in the app? Matched by exported identifier
    // name rather than resolved module graph, so it can miss true positives
    // (e.g. a re-export chain) — that's why it's a warning, not a failure.
    const layoutFiles = walk(cwd, 'app', (rel) => path.basename(rel) === 'layout.tsx');
    const layoutContent = layoutFiles.map((f) => codeContent(cwd, f)).join('\n');
    const referenced = validFiles.some((file) => {
      const names = exportedNames(readFileSync(path.join(cwd, file), 'utf8'));
      return names.some((name) => new RegExp(`\\b${name}\\b`).test(layoutContent));
    });
    if (!referenced) {
      findings.push(
        fail(
          'page-chrome-wired',
          'configurePageChrome(...) wiring exists but its module does not appear to be referenced from any app/layout.tsx — confirm it is actually rendered',
          { severity: 'warn' },
        ),
      );
    }

    return findings.length > 0 ? findings : [pass('page-chrome-wired')];
  },
};

// ---------------------------------------------------------------------------
// 16. Incident: `section dev` (Tier 1 declarative storefront sections, Task
//     1.5) shipped with no `doctor` coverage — a developer could declare
//     `[[storefront_sections]]` with a typo'd `blueprint_file`, malformed
//     JSON, or a source missing its required field (`blueprint` without
//     `element_tree`/`blueprint_file`, `endpoint` without `endpoint_path`)
//     and only find out at push time, or worse at install time on the
//     platform. Node TYPES are deliberately NOT this rule's business: the
//     host's `AppSectionValidator` owns that catalog, and vendoring a copy of
//     it here would drift the moment the platform adds an element — see the
//     same reasoning already recorded on `StorefrontSectionSchema` in
//     manifest.ts. This rule checks shape only.
// ---------------------------------------------------------------------------
const sectionBlueprintValid: DoctorRule = {
  name: 'section-blueprint-valid',
  check(cwd) {
    const manifestPath = path.join(cwd, MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) {
      return [pass('section-blueprint-valid')];
    }

    let parsed: unknown;
    try {
      parsed = TOML.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      // Malformed TOML is `readManifest`'s (and `push`'s) concern, not this
      // rule's — it has nothing section-shaped to check.
      return [pass('section-blueprint-valid')];
    }

    const sectionsRaw = (parsed as { storefront_sections?: unknown }).storefront_sections;
    if (!Array.isArray(sectionsRaw) || sectionsRaw.length === 0) {
      // An app declaring no sections is not this rule's business — inapplicable,
      // not failing.
      return [pass('section-blueprint-valid')];
    }

    const findings: Finding[] = [];

    // Same schema `section dev`/`push` validate against: 'blueprint' needs
    // element_tree or blueprint_file, 'endpoint' needs endpoint_path.
    const result = ManifestSchema.safeParse(parsed);
    if (!result.success) {
      for (const issue of result.error.issues) {
        if (issue.path[0] !== 'storefront_sections') continue;
        findings.push(fail('section-blueprint-valid', issue.message, { file: MANIFEST_FILENAME }));
      }
    }

    // blueprint_file existence + JSON validity, reusing the exact parsing
    // core `section dev`'s resolveStorefrontSections uses — SectionBlueprintError
    // carries file/line/column for a JSON syntax error.
    for (const raw of sectionsRaw as StorefrontSection[]) {
      try {
        resolveStorefrontSectionsSync(cwd, [raw]);
      } catch (err) {
        if (err instanceof SectionBlueprintError) {
          findings.push(fail('section-blueprint-valid', err.message, { file: err.file, line: err.line }));
        } else {
          throw err;
        }
      }
    }

    return findings.length > 0 ? findings : [pass('section-blueprint-valid')];
  },
};

// ---------------------------------------------------------------------------
// 17. Incident (PG-329, 2026-09-24): form pages in shipped apps (tours "new
//     tour", interactive-map's map form) rendered their fields with no FORM
//     actions in the host command bar — Save lived in a footer the host never
//     saw, or nowhere, so the command bar showed ⌘K over a dirty form and the
//     host could not guard navigation. The owner's rule: a page with form
//     fields shows its Save/Cancel in the command bar. The kit's <FormPage>
//     (app-bridge-ui 0.6.0) publishes them from `dirty` + `onSubmit`; this rule
//     fails an app/**/page.tsx that renders form controls but neither uses
//     <FormPage> nor passes non-empty `actions` to <Page>. It looks at the
//     page file only — a form in a child component that renders its own
//     <FormPage> keeps the page file clean, which is the shape we want.
// ---------------------------------------------------------------------------
const FORM_CONTROL_RE = /<(Input|Field|Textarea|Select|input|textarea|select|form)(?=[\s/>])([^>]*)/g;
const NON_FORM_INPUT_TYPE_RE = /\btype\s*=\s*\{?\s*["'`](search|hidden)["'`]/;

/** Offset of the first real form control in `content`, or -1. A search box or a hidden input is not a form. */
function firstFormControl(content: string): number {
  FORM_CONTROL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FORM_CONTROL_RE.exec(content)) !== null) {
    const attrs = match[2] ?? '';
    const tag = match[1] as string;
    if ((tag === 'Input' || tag === 'input') && NON_FORM_INPUT_TYPE_RE.test(attrs)) continue;
    return match.index;
  }
  return -1;
}

/** The attribute text of every `<Page …>` opening tag, brace-aware (JSX expressions may contain `>`). */
function pageOpeningTags(content: string): string[] {
  const tags: string[] = [];
  const re = /<Page(?=[\s/>])/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    let depth = 0;
    let i = match.index + match[0].length;
    for (; i < content.length; i += 1) {
      const ch = content[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) break;
    }
    tags.push(content.slice(match.index, i));
  }
  return tags;
}

/** `actions={…}` present and not the literal empty array. */
function hasNonEmptyActions(openingTag: string): boolean {
  const m = /\bactions\s*=\s*\{([\s\S]*)/.exec(openingTag);
  if (!m) return false;
  return !/^\s*\[\s*\]\s*\}/.test(m[1] as string);
}

const formActionsInCommandBar: DoctorRule = {
  name: 'form-actions-in-command-bar',
  check(cwd) {
    const pages = [
      ...walk(cwd, 'app', (rel) => /(^|[\\/])page\.(tsx|jsx)$/.test(rel)),
      ...walk(cwd, path.join('src', 'app'), (rel) => /(^|[\\/])page\.(tsx|jsx)$/.test(rel)),
    ];
    const findings: Finding[] = [];

    for (const file of pages) {
      const content = codeContent(cwd, file);
      const at = firstFormControl(content);
      if (at < 0) continue;
      if (/<FormPage(?=[\s/>])/.test(content)) continue;
      if (pageOpeningTags(content).some(hasNonEmptyActions)) continue;

      findings.push(
        fail(
          'form-actions-in-command-bar',
          'Page renders form fields but publishes no form actions to the host command bar. ' +
            'Fix: render it as <FormPage title crumbs dirty onSubmit onCancel> from @flashmandu/app-bridge-ui/react (0.6.0+) — ' +
            'it publishes Save (primary) + Cancel to the command bar, disables Save while pristine, submits on Enter and hides ⌘K while dirty. ' +
            'Never draw your own Save button in the page.',
          { file, line: content.slice(0, at).split('\n').length },
        ),
      );
    }

    return findings.length > 0 ? findings : [pass('form-actions-in-command-bar')];
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
  pageChromeWired,
  sectionBlueprintValid,
  formActionsInCommandBar,
];
