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
