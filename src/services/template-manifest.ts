import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * `autohisab-business upgrade` — re-applies KIT-OWNED template files (the
 * pure wiring boilerplate: `next.config.js`, the OAuth/webhook route
 * factories, the route-state scaffolds) into an already-scaffolded app.
 *
 * Kit-owned files start with a marker header —
 * `/* @flashmandu-template <relPath>@<version> *\/` — written by `init`. This
 * module never reads that header (a hand-edit could leave it stale); instead
 * it fingerprints file CONTENT: every kit-owned file's sha256 hash is
 * recorded per template version it was ever shipped at. An app's local copy
 * is safe to overwrite exactly when its hash matches some KNOWN template
 * version — i.e. the developer never touched it. Any other hash means the
 * developer edited it on purpose, and `upgrade` must leave it alone and say
 * so, never silently clobber it.
 */

export const TEMPLATE_VERSION = '0.4.1';

/**
 * Kit-owned files, relative to the `next-js` template root — the wiring
 * boilerplate `upgrade` is allowed to touch. Deliberately narrow: example
 * content the developer is expected to rewrite from day one (`app/page.tsx`,
 * `app/items/page.tsx`, `app/(admin)/settings/page.tsx`) is NOT here, so
 * `upgrade` never fights a developer over their own dashboard.
 */
export const KIT_OWNED_FILES: readonly string[] = [
  'next.config.js',
  'app/globals.css',
  'app/layout.tsx',
  'app/PageChromeSetup.tsx',
  'app/loading.tsx',
  'app/error.tsx',
  'app/not-found.tsx',
  'app/oauth/authorize/route.ts',
  'app/oauth/callback/route.ts',
  'app/oauth/token/route.ts',
  'app/webhooks/flashmandu/route.ts',
  'lib/purge.ts',
];

/** relPath -> { templateVersion -> sha256(content) }. */
export type TemplateManifest = Record<string, Record<string, string>>;

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Resolve the bundled `next-js` template root, mirroring `init.ts`'s search order. */
export function resolveTemplateRoot(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'templates', 'next-js'),
    path.join(__dirname, '..', '..', 'src', 'templates', 'next-js'),
    path.join(process.cwd(), 'src', 'templates', 'next-js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`next-js template not found. Looked in:\n  ${candidates.join('\n  ')}`);
}

/**
 * Build the hash snapshot for every kit-owned file AS SHIPPED in
 * `templateRoot`, tagged under `version`. Called once for the CLI's current
 * template (`TEMPLATE_VERSION`); a future release with a newer template calls
 * it again for its own version and the two manifests are merged (see
 * `mergeManifests`), so hashes from every version the CLI has ever shipped
 * stay recognisable to `upgradeApp`.
 */
export function buildManifest(templateRoot: string, version: string): TemplateManifest {
  const manifest: TemplateManifest = {};
  for (const rel of KIT_OWNED_FILES) {
    const abs = path.join(templateRoot, rel);
    if (!existsSync(abs)) continue;
    manifest[rel] = { [version]: sha256(readFileSync(abs, 'utf8')) };
  }
  return manifest;
}

/** Merge two manifests, unioning the per-file version->hash maps. */
export function mergeManifests(a: TemplateManifest, b: TemplateManifest): TemplateManifest {
  const out: TemplateManifest = {};
  for (const rel of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[rel] = { ...(a[rel] ?? {}), ...(b[rel] ?? {}) };
  }
  return out;
}

/**
 * The manifest this build of the CLI knows about: the current template
 * (`TEMPLATE_VERSION`), as shipped. There is no earlier entry — the pre-0.4.0
 * template carried no marker header at all, so a file still at that shape has
 * no recorded hash and is (correctly) treated as forked/unknown rather than
 * silently upgraded.
 */
export function defaultManifest(): TemplateManifest {
  return buildManifest(resolveTemplateRoot(), TEMPLATE_VERSION);
}

export type UpgradeStatus = 'created' | 'upgraded' | 'unchanged' | 'forked';

export interface UpgradeResult {
  rel: string;
  status: UpgradeStatus;
}

/**
 * Re-apply kit-owned template files into `cwd`.
 *
 * Per file:
 *   - missing entirely            -> write it, report `created`
 *   - byte-identical to the shipped template -> `unchanged`
 *   - local hash matches a KNOWN template version (any version this manifest
 *     has a hash for) -> overwrite with the current template content, report
 *     `upgraded`
 *   - anything else (a hand-edit)  -> leave it alone, report `forked`
 */
export function upgradeApp(
  cwd: string,
  opts: { templateRoot?: string; manifest?: TemplateManifest } = {},
): UpgradeResult[] {
  const templateRoot = opts.templateRoot ?? resolveTemplateRoot();
  const manifest = opts.manifest ?? defaultManifest();
  const results: UpgradeResult[] = [];

  for (const rel of KIT_OWNED_FILES) {
    const srcAbs = path.join(templateRoot, rel);
    if (!existsSync(srcAbs)) continue;
    const srcContent = readFileSync(srcAbs, 'utf8');
    const destAbs = path.join(cwd, rel);

    if (!existsSync(destAbs)) {
      mkdirSync(path.dirname(destAbs), { recursive: true });
      writeFileSync(destAbs, srcContent);
      results.push({ rel, status: 'created' });
      continue;
    }

    const destContent = readFileSync(destAbs, 'utf8');
    if (destContent === srcContent) {
      results.push({ rel, status: 'unchanged' });
      continue;
    }

    const knownHashes = new Set(Object.values(manifest[rel] ?? {}));
    const destHash = sha256(destContent);
    if (knownHashes.has(destHash)) {
      writeFileSync(destAbs, srcContent);
      results.push({ rel, status: 'upgraded' });
    } else {
      results.push({ rel, status: 'forked' });
    }
  }

  return results;
}
