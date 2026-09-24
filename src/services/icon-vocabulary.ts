import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The icon vocabulary `doctor`'s `manifest-icons` rule and `push`'s warning
 * check validate `nav_items[].icon` / `embed_blocks[].icon` against (PG-333).
 *
 * Shipped as a generated asset (`assets/icon-vocabulary.json`,
 * `scripts/generate-icon-vocabulary.mjs`) rather than derived at CLI runtime:
 * the CLI is a separate package from the host, so it has no Flux install to
 * glob the way the host's own `IconVocabulary`
 * (packages/flashmandu/apps/src/Support/IconVocabulary.php) does. The asset
 * IS that same derivation, snapshotted at generation time — never a
 * hand-written list.
 */

const ASSET_PATH = path.join(__dirname, '..', '..', 'assets', 'icon-vocabulary.json');

/** Rendered wherever an unknown icon would otherwise leave a row blank — matches the host's `IconVocabulary::DEFAULT_ICON`. */
export const DEFAULT_ICON = 'squares-2x2';

interface IconVocabularyAsset {
  icons: string[];
}

let cached: Set<string> | null = null;

/** The full vocabulary as a Set, loaded once per process. */
export function iconVocabulary(): Set<string> {
  if (cached) return cached;

  const raw = JSON.parse(readFileSync(ASSET_PATH, 'utf8')) as IconVocabularyAsset;
  cached = new Set(raw.icons);
  return cached;
}

/** Shape check mirroring the host's — lowercase alphanumeric + hyphen only. */
const ICON_SHAPE_RE = /^[a-z0-9-]+$/;

export function isKnownIcon(icon: string): boolean {
  const trimmed = icon.trim();
  if (trimmed === '' || !ICON_SHAPE_RE.test(trimmed)) return false;
  return iconVocabulary().has(trimmed);
}
