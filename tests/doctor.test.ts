import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DOCTOR_RULES } from '../src/services/doctor-rules';
import { PINNED_KITS } from '../src/services/kit-versions';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'doctor-test-'));
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

function rule(name: string) {
  const found = DOCTOR_RULES.find((r) => r.name === name);
  if (!found) throw new Error(`no such rule: ${name}`);
  return found;
}

describe('no-fm-override', () => {
  it('passes when app CSS does not touch .fm- selectors', async () => {
    const dir = await tempDir();
    await write(dir, 'app/globals.css', '.app-header {\n  color: red;\n}\n');
    expect(rule('no-fm-override').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('fails when app CSS redefines a kit selector', async () => {
    const dir = await tempDir();
    await write(dir, 'app/globals.css', '.fm-container {\n  max-width: 880px;\n}\n');
    const findings = rule('no-fm-override').check(dir);
    expect(findings.some((f) => !f.ok && f.file === 'app/globals.css')).toBe(true);
  });
});

describe('frame-headers', () => {
  const good = `
module.exports = {
  transpilePackages: ['@flashmandu/app-bridge-ui'],
  async headers() {
    return [{ source: '/(.*)', headers: [
      { key: 'X-Frame-Options', value: 'ALLOWALL' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
    ] }];
  },
};`;

  it('passes with headers() + frame-ancestors + X-Frame-Options + transpilePackages', async () => {
    const dir = await tempDir();
    await write(dir, 'next.config.js', good);
    expect(rule('frame-headers').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('fails when headers() is missing', async () => {
    const dir = await tempDir();
    await write(dir, 'next.config.js', 'module.exports = { transpilePackages: ["@flashmandu/app-bridge-ui"] };');
    expect(rule('frame-headers').check(dir).every((f) => f.ok)).toBe(false);
  });
});

describe('no-sidebar-links', () => {
  it('passes with no runtime call', async () => {
    const dir = await tempDir();
    await write(dir, 'app/page.tsx', 'export default function Page() { return null; }');
    expect(rule('no-sidebar-links').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('fails when setSidebarLinks( is called', async () => {
    const dir = await tempDir();
    await write(dir, 'app/page.tsx', "useEffect(() => { setSidebarLinks([{ label: 'x' }]); }, []);");
    expect(rule('no-sidebar-links').check(dir).every((f) => f.ok)).toBe(false);
  });

  it('ignores setSidebarLinks( mentioned only in a comment', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'app/page.tsx',
      "// Do NOT call setSidebarLinks( here — use manifest nav_items instead.\nexport default function Page() { return null; }",
    );
    expect(rule('no-sidebar-links').check(dir).every((f) => f.ok)).toBe(true);
  });
});

describe('no-pinned-dark', () => {
  it('passes with no dark pin', async () => {
    const dir = await tempDir();
    await write(dir, 'app/layout.tsx', '<html><body>hi</body></html>');
    expect(rule('no-pinned-dark').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('fails when data-fm-theme="dark" is hardcoded', async () => {
    const dir = await tempDir();
    await write(dir, 'app/layout.tsx', '<html data-fm-theme="dark"><body>hi</body></html>');
    expect(rule('no-pinned-dark').check(dir).every((f) => f.ok)).toBe(false);
  });

  it('ignores data-fm-theme="dark" mentioned only in a comment', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'app/layout.tsx',
      '/* do not write data-fm-theme="dark" here */\n<html><body>hi</body></html>',
    );
    expect(rule('no-pinned-dark').check(dir).every((f) => f.ok)).toBe(true);
  });
});

describe('no-client-prisma', () => {
  it('passes when the client file only imports plain modules', async () => {
    const dir = await tempDir();
    await write(dir, 'app/util.ts', 'export const x = 1;');
    await write(dir, 'app/widget.tsx', "'use client';\nimport { x } from './util';\nexport default function W() { return x; }");
    expect(rule('no-client-prisma').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('fails when a direct import reaches a module importing @prisma/client', async () => {
    const dir = await tempDir();
    await write(dir, 'lib/db.ts', "import { PrismaClient } from '@prisma/client';\nexport const db = new PrismaClient();");
    await write(
      dir,
      'app/widget.tsx',
      "'use client';\nimport { db } from '../lib/db';\nexport default function W() { return null; }",
    );
    expect(rule('no-client-prisma').check(dir).every((f) => f.ok)).toBe(false);
  });
});

describe('webhook-raw-body', () => {
  it('passes when req.text() is read before req.json()', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'app/webhooks/flashmandu/route.ts',
      'export async function POST(req: Request) {\n  const raw = await req.text();\n  const body = JSON.parse(raw);\n  return new Response("ok");\n}',
    );
    expect(rule('webhook-raw-body').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('passes when createWebhookRoute is used', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'app/webhooks/flashmandu/route.ts',
      "import { createWebhookRoute } from '@flashmandu/app-bridge/next';\nexport const { POST } = createWebhookRoute({ cfg });",
    );
    expect(rule('webhook-raw-body').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('fails when req.json() is called without a prior req.text()', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'app/webhooks/flashmandu/route.ts',
      'export async function POST(req: Request) {\n  const body = await req.json();\n  return new Response("ok");\n}',
    );
    expect(rule('webhook-raw-body').check(dir).every((f) => f.ok)).toBe(false);
  });

  // False positive (showcase, verified 2026-08-14): a GET-only status route
  // under app/webhooks/** with no body and no `req` parameter is not a
  // webhook receiver and must not be flagged.
  it('passes for a GET-only route with no request body under app/webhooks/**', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'app/webhooks/purge-status/route.ts',
      "export async function GET(): Promise<Response> {\n  return new Response(JSON.stringify({ ok: true }));\n}",
    );
    expect(rule('webhook-raw-body').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('still fails a real POST receiver that json()s without text() first, even alongside a GET export', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'app/webhooks/mixed/route.ts',
      'export async function GET(): Promise<Response> {\n  return new Response("ok");\n}\nexport async function POST(req: Request) {\n  const body = await req.json();\n  return new Response("ok");\n}',
    );
    expect(rule('webhook-raw-body').check(dir).every((f) => f.ok)).toBe(false);
  });
});

describe('kit-current', () => {
  const pinnedBridge = PINNED_KITS['@flashmandu/app-bridge'];

  it('passes when vendored as the pinned tgz', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'package.json',
      JSON.stringify({
        dependencies: {
          '@flashmandu/app-bridge': `file:vendor/flashmandu-app-bridge-${pinnedBridge}.tgz`,
          '@flashmandu/app-bridge-ui': `file:vendor/flashmandu-app-bridge-ui-${PINNED_KITS['@flashmandu/app-bridge-ui']}.tgz`,
        },
      }),
    );
    expect(rule('kit-current').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('fails on directory-style vendoring', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'package.json',
      JSON.stringify({
        dependencies: {
          '@flashmandu/app-bridge': 'file:vendor/app-bridge',
          '@flashmandu/app-bridge-ui': 'file:vendor/app-bridge-ui',
        },
      }),
    );
    await write(dir, 'vendor/app-bridge/package.json', JSON.stringify({ version: '0.3.0' }));
    await write(dir, 'vendor/app-bridge-ui/package.json', JSON.stringify({ version: '0.3.0' }));
    expect(rule('kit-current').check(dir).every((f) => f.ok)).toBe(false);
  });
});

describe('kit-css-single-entry', () => {
  it('passes with exactly one index.css import', async () => {
    const dir = await tempDir();
    await write(dir, 'app/layout.tsx', "import '@flashmandu/app-bridge-ui/dist/index.css';\nexport default function L() { return null; }");
    expect(rule('kit-css-single-entry').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('fails on a direct tokens.css import', async () => {
    const dir = await tempDir();
    await write(dir, 'app/layout.tsx', "import '@flashmandu/app-bridge-ui/dist/tokens.css';");
    expect(rule('kit-css-single-entry').check(dir).every((f) => f.ok)).toBe(false);
  });

  it('fails on a duplicate import', async () => {
    const dir = await tempDir();
    await write(dir, 'app/layout.tsx', "import '@flashmandu/app-bridge-ui/dist/index.css';");
    await write(dir, 'app/globals.css', "@import '@flashmandu/app-bridge-ui/dist/index.css';");
    expect(rule('kit-css-single-entry').check(dir).every((f) => f.ok)).toBe(false);
  });

  // False positive (showcase, verified 2026-08-14): a test that readFileSync's
  // the kit's dist CSS path to assert class-name contracts is not the app
  // importing the kit — the path is a string argument, not an import
  // statement, and the file lives under tests/.
  it('passes when the only real import is index.css and a test file readFileSync\'s tokens.css/components.css', async () => {
    const dir = await tempDir();
    await write(dir, 'app/globals.css', '@import "@flashmandu/app-bridge-ui/dist/index.css";');
    await write(
      dir,
      'tests/parity/class-contract.test.ts',
      "import { readFileSync } from 'node:fs';\nimport path from 'node:path';\nconst componentsCss = readFileSync(path.join(ROOT, 'node_modules/@flashmandu/app-bridge-ui/dist/components.css'), 'utf8');\nconst tokensCss = readFileSync(path.join(ROOT, 'node_modules/@flashmandu/app-bridge-ui/dist/tokens.css'), 'utf8');\n",
    );
    expect(rule('kit-css-single-entry').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('still fails a real duplicate import even with a readFileSync of the kit CSS elsewhere', async () => {
    const dir = await tempDir();
    await write(dir, 'app/globals.css', '@import "@flashmandu/app-bridge-ui/dist/index.css";');
    await write(dir, 'app/layout.tsx', "import '@flashmandu/app-bridge-ui/dist/index.css';");
    await write(
      dir,
      'tests/parity/class-contract.test.ts',
      "import { readFileSync } from 'node:fs';\nconst tokensCss = readFileSync('node_modules/@flashmandu/app-bridge-ui/dist/tokens.css', 'utf8');\n",
    );
    expect(rule('kit-css-single-entry').check(dir).every((f) => f.ok)).toBe(false);
  });

  it('still fails a direct tokens.css import in non-test source even though test files are excluded', async () => {
    const dir = await tempDir();
    await write(dir, 'app/layout.tsx', "import '@flashmandu/app-bridge-ui/dist/tokens.css';");
    await write(
      dir,
      'tests/parity/class-contract.test.ts',
      "import { readFileSync } from 'node:fs';\nconst x = readFileSync('node_modules/@flashmandu/app-bridge-ui/dist/components.css', 'utf8');\n",
    );
    expect(rule('kit-css-single-entry').check(dir).every((f) => f.ok)).toBe(false);
  });
});

describe('kit-buttons-only', () => {
  it('passes when the button carries fm-btn', async () => {
    const dir = await tempDir();
    await write(dir, 'app/page.tsx', '<button className="fm-btn fm-btn--primary">Go</button>');
    expect(rule('kit-buttons-only').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('fails on a raw button without fm-btn', async () => {
    const dir = await tempDir();
    await write(dir, 'app/page.tsx', '<button className="my-custom">Go</button>');
    expect(rule('kit-buttons-only').check(dir).every((f) => f.ok)).toBe(false);
  });
});

describe('no-native-dialogs', () => {
  it('passes with no native dialog calls', async () => {
    const dir = await tempDir();
    await write(dir, 'app/page.tsx', 'useHostDialogs().confirm("Delete?");');
    expect(rule('no-native-dialogs').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('fails on window.confirm(', async () => {
    const dir = await tempDir();
    await write(dir, 'app/page.tsx', 'if (window.confirm("Delete?")) { doIt(); }');
    expect(rule('no-native-dialogs').check(dir).every((f) => f.ok)).toBe(false);
  });

  it('ignores window.confirm( mentioned only in a comment', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'app/page.tsx',
      '// Never call window.confirm( here — use host dialogs.\nexport default function Page() { return null; }',
    );
    expect(rule('no-native-dialogs').check(dir).every((f) => f.ok)).toBe(true);
  });
});

describe('no-theme-pin', () => {
  it('passes with no theme attr in layout.tsx', async () => {
    const dir = await tempDir();
    await write(dir, 'app/layout.tsx', '<html><body>hi</body></html>');
    expect(rule('no-theme-pin').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('fails when any data-fm-theme value is pinned', async () => {
    const dir = await tempDir();
    await write(dir, 'app/layout.tsx', '<html data-fm-theme="light"><body>hi</body></html>');
    expect(rule('no-theme-pin').check(dir).every((f) => f.ok)).toBe(false);
  });

  it('ignores a mention of data-fm-theme inside a block comment', async () => {
    // Reproduces the false positive found running the rule against
    // ~/nextjs/tours/app/layout.tsx: lines 21 and 25 were prose inside a
    // `/** … */` doc comment EXPLAINING that the attribute is deliberately
    // not set, e.g. `<html lang="en" data-fm-theme="light">` shown as an
    // example of what NOT to do.
    const dir = await tempDir();
    await write(
      dir,
      'app/layout.tsx',
      [
        '/**',
        ' * THEMING: no data-fm-theme is set here, on purpose. Pin it only if',
        ' * your app is deliberately single-theme:',
        ' *',
        ' *     <html lang="en" data-fm-theme="light">',
        ' *',
        ' * Hardcoding it is the easiest way to ship a broken app.',
        ' */',
        'export default function RootLayout() {',
        '  return <html lang="en"><body>hi</body></html>;',
        '}',
      ].join('\n'),
    );
    expect(rule('no-theme-pin').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('ignores a mention of data-fm-theme inside a line comment', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'app/layout.tsx',
      '// Example only: <html data-fm-theme="dark">\nexport default function L() { return <html><body>hi</body></html>; }',
    );
    expect(rule('no-theme-pin').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('still fails when the same token is real code, not a comment', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'app/layout.tsx',
      [
        '/**',
        ' * THEMING doc comment, unrelated prose.',
        ' */',
        'export default function RootLayout() {',
        '  return <html lang="en" data-fm-theme="dark"><body>hi</body></html>;',
        '}',
      ].join('\n'),
    );
    const findings = rule('no-theme-pin').check(dir);
    expect(findings.some((f) => !f.ok && f.line === 5)).toBe(true);
  });
});

describe('route-states', () => {
  it('passes when loading/error/not-found all exist', async () => {
    const dir = await tempDir();
    await write(dir, 'app/page.tsx', 'export default function Page() { return null; }');
    await write(dir, 'app/loading.tsx', 'export default function L() { return null; }');
    await write(dir, 'app/error.tsx', 'export default function E() { return null; }');
    await write(dir, 'app/not-found.tsx', 'export default function N() { return null; }');
    expect(rule('route-states').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('fails listing missing loading/error/not-found', async () => {
    const dir = await tempDir();
    await write(dir, 'app/items/page.tsx', 'export default function Page() { return null; }');
    const findings = rule('route-states').check(dir);
    expect(findings.some((f) => !f.ok)).toBe(true);
    expect(findings.filter((f) => !f.ok).length).toBeGreaterThanOrEqual(3); // loading + error + not-found
  });
});

describe('app-css-budget', () => {
  it('passes (no warning) under the 150-line budget with app- prefixed selectors', async () => {
    const dir = await tempDir();
    await write(dir, 'app/globals.css', '.app-header {\n  color: red;\n}\n');
    expect(rule('app-css-budget').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('warns (not fails as an error) over the 150-line budget', async () => {
    const dir = await tempDir();
    const lines = Array.from({ length: 200 }, (_, i) => `.app-line-${i} { color: red; }`).join('\n');
    await write(dir, 'app/globals.css', lines);
    const findings = rule('app-css-budget').check(dir);
    expect(findings.every((f) => f.ok)).toBe(false);
    expect(findings.every((f) => f.severity === 'warn')).toBe(true);
  });
});

describe('typography-scale', () => {
  it('passes when app CSS references the --fm-text-* scale', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'app/globals.css',
      '.app-label {\n  font-size: var(--fm-text-sm);\n  font-size: var(--fm-text-sm, 0.875rem);\n}\n',
    );
    expect(rule('typography-scale').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('permits em values, which scale with the token-sized parent', async () => {
    // The CLI template itself ships `code, pre { font-size: 0.85em }` — flagging
    // it would make a freshly scaffolded app fail its own doctor run.
    const dir = await tempDir();
    await write(dir, 'app/globals.css', 'code,\npre {\n  font-size: 0.85em;\n}\n');
    expect(rule('typography-scale').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('ignores third-party CSS vendored at any depth', async () => {
    // interactive-map ships leaflet.css under public/vendor/; scanning it
    // produced 7 findings against CSS the app does not own and must not edit.
    const dir = await tempDir();
    await write(dir, 'public/vendor/leaflet/leaflet.css', '.leaflet-tip {\n  font-size: 12px;\n}\n');
    expect(rule('typography-scale').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('fails when app CSS hardcodes a font-size literal off the scale', async () => {
    const dir = await tempDir();
    await write(dir, 'app/globals.css', '.app-label {\n  font-size: 0.8rem;\n}\n');
    const findings = rule('typography-scale').check(dir);
    expect(findings.some((f) => !f.ok && f.file === 'app/globals.css' && f.line === 2)).toBe(true);
    expect(findings.some((f) => !f.ok && f.severity === 'error')).toBe(true);
  });

  it('fails on an inline style fontSize literal in a .tsx file', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'app/widget.tsx',
      "export function Widget() {\n  return <span style={{ fontSize: '0.75rem' }}>hi</span>;\n}\n",
    );
    const findings = rule('typography-scale').check(dir);
    expect(findings.some((f) => !f.ok && f.file === 'app/widget.tsx' && f.line === 2)).toBe(true);
  });
});

describe('page-chrome-wired', () => {
  const wiringModule =
    "'use client';\n\nimport { usePageChrome } from '@flashmandu/app-bridge/react';\nimport { configurePageChrome } from '@flashmandu/app-bridge-ui/react';\n\nconfigurePageChrome(usePageChrome);\n\nexport function PageChromeSetup() {\n  return null;\n}\n";

  const layoutRenderingIt = "import { PageChromeSetup } from './PageChromeSetup';\nexport default function Layout({ children }) {\n  return (\n    <html>\n      <body>\n        <PageChromeSetup />\n        {children}\n      </body>\n    </html>\n  );\n}\n";

  it('passes when an app that never imports <Page> has no wiring', async () => {
    const dir = await tempDir();
    await write(dir, 'app/page.tsx', 'export default function Page() { return null; }');
    expect(rule('page-chrome-wired').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('passes when <Page> is imported and correctly wired from a use-client module rendered by layout.tsx', async () => {
    const dir = await tempDir();
    await write(dir, 'app/page.tsx', "import { Page } from '@flashmandu/app-bridge-ui/react';\nexport default function Home() { return <Page title=\"Home\" />; }");
    await write(dir, 'app/PageChromeSetup.tsx', wiringModule);
    await write(dir, 'app/layout.tsx', layoutRenderingIt);
    const findings = rule('page-chrome-wired').check(dir);
    expect(findings.every((f) => f.ok)).toBe(true);
  });

  it('fails when <Page> is imported but configurePageChrome is never called', async () => {
    const dir = await tempDir();
    await write(dir, 'app/page.tsx', "import { Page } from '@flashmandu/app-bridge-ui/react';\nexport default function Home() { return <Page title=\"Home\" />; }");
    const findings = rule('page-chrome-wired').check(dir);
    expect(findings.every((f) => f.ok)).toBe(false);
  });

  it('fails when the only configurePageChrome mention is inside a comment', async () => {
    const dir = await tempDir();
    await write(dir, 'app/page.tsx', "import { Page } from '@flashmandu/app-bridge-ui/react';\nexport default function Home() { return <Page title=\"Home\" />; }");
    await write(
      dir,
      'app/PageChromeSetup.tsx',
      "'use client';\n// TODO: call configurePageChrome(usePageChrome) here once wired up\nexport function PageChromeSetup() { return null; }\n",
    );
    const findings = rule('page-chrome-wired').check(dir);
    expect(findings.every((f) => f.ok)).toBe(false);
  });

  it('fails when the call exists but its file does not start with use client', async () => {
    const dir = await tempDir();
    await write(dir, 'app/page.tsx', "import { Page } from '@flashmandu/app-bridge-ui/react';\nexport default function Home() { return <Page title=\"Home\" />; }");
    await write(
      dir,
      'app/PageChromeSetup.tsx',
      "import { usePageChrome } from '@flashmandu/app-bridge/react';\nimport { configurePageChrome } from '@flashmandu/app-bridge-ui/react';\n\nconfigurePageChrome(usePageChrome);\n\nexport function PageChromeSetup() {\n  return null;\n}\n",
    );
    const findings = rule('page-chrome-wired').check(dir);
    expect(findings.some((f) => !f.ok && f.file === 'app/PageChromeSetup.tsx')).toBe(true);
  });

  it('allows a leading marker comment before the use client directive', async () => {
    const dir = await tempDir();
    await write(dir, 'app/page.tsx', "import { Page } from '@flashmandu/app-bridge-ui/react';\nexport default function Home() { return <Page title=\"Home\" />; }");
    await write(
      dir,
      'app/PageChromeSetup.tsx',
      `/* @flashmandu-template app/PageChromeSetup.tsx@0.4.1 */\n${wiringModule}`,
    );
    await write(dir, 'app/layout.tsx', layoutRenderingIt);
    const findings = rule('page-chrome-wired').check(dir);
    expect(findings.every((f) => f.ok)).toBe(true);
  });

  it('warns (does not fail) when the wired module is never referenced from layout.tsx', async () => {
    const dir = await tempDir();
    await write(dir, 'app/page.tsx', "import { Page } from '@flashmandu/app-bridge-ui/react';\nexport default function Home() { return <Page title=\"Home\" />; }");
    await write(dir, 'app/PageChromeSetup.tsx', wiringModule);
    // No layout.tsx at all, or one that does not reference PageChromeSetup.
    await write(dir, 'app/layout.tsx', 'export default function Layout({ children }) { return children; }');
    const findings = rule('page-chrome-wired').check(dir);
    expect(findings.some((f) => !f.ok && f.severity === 'warn')).toBe(true);
    expect(findings.some((f) => !f.ok && f.severity === 'error')).toBe(false);
  });
});

describe('section-blueprint-valid', () => {
  const manifestHeader = [
    'name = "Doctor Check App"',
    'version = "1.0.0"',
    'authorize_url = "https://example.com/authorize"',
    'token_url = "https://example.com/token"',
    'webhook_url = "https://example.com/webhooks"',
    '',
  ].join('\n');

  function manifestWith(sectionToml: string): string {
    return `${manifestHeader}${sectionToml}`;
  }

  it('passes trivially when the app declares no [[storefront_sections]] at all', async () => {
    const dir = await tempDir();
    await write(dir, 'flashmandu.app.toml', manifestHeader);
    expect(rule('section-blueprint-valid').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('passes trivially when there is no manifest file', async () => {
    const dir = await tempDir();
    expect(rule('section-blueprint-valid').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('passes with a valid blueprint_file section', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'flashmandu.app.toml',
      manifestWith(
        [
          '[[storefront_sections]]',
          'type = "events-calendar"',
          'name = "Events Calendar"',
          'source = "blueprint"',
          'blueprint_file = "sections/events-calendar.json"',
          '',
        ].join('\n'),
      ),
    );
    await write(dir, 'sections/events-calendar.json', '[{"type": "container", "children": []}]');
    expect(rule('section-blueprint-valid').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('passes with a valid inline element_tree section', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'flashmandu.app.toml',
      manifestWith(
        [
          '[[storefront_sections]]',
          'type = "events-calendar"',
          'name = "Events Calendar"',
          'source = "blueprint"',
          'element_tree = [{ type = "container" }]',
          '',
        ].join('\n'),
      ),
    );
    expect(rule('section-blueprint-valid').check(dir).every((f) => f.ok)).toBe(true);
  });

  it('fails naming the path when blueprint_file does not exist', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'flashmandu.app.toml',
      manifestWith(
        [
          '[[storefront_sections]]',
          'type = "events-calendar"',
          'name = "Events Calendar"',
          'source = "blueprint"',
          'blueprint_file = "sections/missing.json"',
          '',
        ].join('\n'),
      ),
    );
    const findings = rule('section-blueprint-valid').check(dir);
    expect(findings.some((f) => !f.ok && f.file === 'sections/missing.json' && /file not found/.test(f.detail ?? ''))).toBe(
      true,
    );
    expect(findings.every((f) => f.ok || f.severity === 'error')).toBe(true);
  });

  it('fails naming file and position when blueprint_file is malformed JSON', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'flashmandu.app.toml',
      manifestWith(
        [
          '[[storefront_sections]]',
          'type = "events-calendar"',
          'name = "Events Calendar"',
          'source = "blueprint"',
          'blueprint_file = "sections/broken.json"',
          '',
        ].join('\n'),
      ),
    );
    await write(dir, 'sections/broken.json', '[\n  { "type": "container", }\n]');
    const findings = rule('section-blueprint-valid').check(dir);
    const failure = findings.find((f) => !f.ok && f.file === 'sections/broken.json');
    expect(failure).toBeDefined();
    expect(failure?.line).toBeDefined();
    expect(failure?.detail).toMatch(/line \d+, column \d+/);
  });

  it('fails a blueprint source with neither inline element_tree nor blueprint_file', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'flashmandu.app.toml',
      manifestWith(
        [
          '[[storefront_sections]]',
          'type = "events-calendar"',
          'name = "Events Calendar"',
          'source = "blueprint"',
          '',
        ].join('\n'),
      ),
    );
    const findings = rule('section-blueprint-valid').check(dir);
    expect(findings.some((f) => !f.ok && /blueprint_file.*element_tree/.test(f.detail ?? ''))).toBe(true);
  });

  it('fails an endpoint source without endpoint_path', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'flashmandu.app.toml',
      manifestWith(
        [
          '[[storefront_sections]]',
          'type = "live-stock"',
          'name = "Live Stock"',
          'source = "endpoint"',
          '',
        ].join('\n'),
      ),
    );
    const findings = rule('section-blueprint-valid').check(dir);
    expect(findings.some((f) => !f.ok && /endpoint_path/.test(f.detail ?? ''))).toBe(true);
  });

  it('passes a valid endpoint source that declares endpoint_path', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'flashmandu.app.toml',
      manifestWith(
        [
          '[[storefront_sections]]',
          'type = "live-stock"',
          'name = "Live Stock"',
          'source = "endpoint"',
          'endpoint_path = "/sections/live-stock"',
          '',
        ].join('\n'),
      ),
    );
    expect(rule('section-blueprint-valid').check(dir).every((f) => f.ok)).toBe(true);
  });
});

describe('form-actions-in-command-bar', () => {
  const run = (dir: string) => rule('form-actions-in-command-bar').check(dir);
  const failures = (dir: string) => run(dir).filter((f) => !f.ok);

  it('is registered in DOCTOR_RULES', () => {
    expect(DOCTOR_RULES.map((r) => r.name)).toContain('form-actions-in-command-bar');
  });

  it('passes a form page rendered as <FormPage>', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'app/(admin)/tours/new/page.tsx',
      "import { FormPage, Field, Input } from '@flashmandu/app-bridge-ui/react';\nexport default function New() {\n  return (\n    <FormPage title=\"New tour\" dirty={dirty} onSubmit={save}>\n      <Field label=\"Name\"><Input /></Field>\n    </FormPage>\n  );\n}\n",
    );
    expect(run(dir).every((f) => f.ok)).toBe(true);
  });

  it('passes a <Page> with fields that publishes non-empty actions', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'app/settings/page.tsx',
      "export default function S() {\n  return (\n    <Page title=\"Settings\" dirty={dirty} actions={[{ id: 'save', label: 'Save', variant: 'primary', disabled: !dirty && x > 1 }]}>\n      <Input value={v} />\n    </Page>\n  );\n}\n",
    );
    expect(run(dir).every((f) => f.ok)).toBe(true);
  });

  it('passes pages with no form controls, a search box only, or a hidden input only', async () => {
    const dir = await tempDir();
    await write(dir, 'app/page.tsx', 'export default function H() { return <Page title="Home"><Card /></Page>; }');
    await write(dir, 'app/items/page.tsx', 'export default function I() { return <Page title="Items"><Input type="search" aria-label="Search" /></Page>; }');
    await write(dir, 'app/x/page.tsx', 'export default function X() { return <Page title="X"><input type="hidden" name="id" /></Page>; }');
    expect(run(dir).every((f) => f.ok)).toBe(true);
  });

  it('fails a page with fields and a footer Save but no command-bar actions, with file, line and fix hint', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'app/maps/[id]/edit/page.tsx',
      "export default function Edit() {\n  return (\n    <Page title=\"Edit map\" dirty={dirty}>\n      <Field label=\"Name\">\n        <Input value={name} />\n      </Field>\n      <Button onClick={save}>Save</Button>\n    </Page>\n  );\n}\n",
    );
    const found = failures(dir);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: path.join('app', 'maps', '[id]', 'edit', 'page.tsx'), line: 4, severity: 'error' });
    expect(found[0]!.detail).toMatch(/<FormPage/);
  });

  it('fails when <Page actions={[]}> is empty, and for a raw <form> under src/app', async () => {
    const dir = await tempDir();
    await write(dir, 'app/a/page.tsx', 'export default function A() { return <Page title="A" actions={[]}><Textarea /></Page>; }');
    await write(dir, 'src/app/b/page.tsx', 'export default function B() { return <main><form onSubmit={go}><input name="q" /></form></main>; }');
    expect(failures(dir).map((f) => f.file).sort()).toEqual([
      path.join('app', 'a', 'page.tsx'),
      path.join('src', 'app', 'b', 'page.tsx'),
    ]);
  });

  it('ignores form controls mentioned only in comments, and non-page files', async () => {
    const dir = await tempDir();
    await write(dir, 'app/page.tsx', '// renders <Input /> later\nexport default function H() { return <Page title="H" />; }');
    await write(dir, 'app/_components/MapForm.tsx', 'export function MapForm() { return <form><Input /></form>; }');
    expect(run(dir).every((f) => f.ok)).toBe(true);
  });
});
