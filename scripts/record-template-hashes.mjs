#!/usr/bin/env node
/**
 * Prints a ready-to-paste `HISTORICAL_TEMPLATE_HASHES` entry for one
 * template version, by hashing `KIT_OWNED_FILES` content as it existed at a
 * given git commit-ish — NOT the working tree, so this still works after
 * later commits have moved the template on.
 *
 * Usage:
 *   node scripts/record-template-hashes.mjs <commit-ish> <version>
 *
 * Example (recording what shipped at 0.4.0, from the last commit before the
 * 0.4.1 content change landed):
 *   node scripts/record-template-hashes.mjs 4bc4b56 0.4.0
 *
 * See the PROCEDURE doc comment in src/services/template-manifest-history.ts
 * for when to run this (the last step before bumping TEMPLATE_VERSION).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [, , commitish, version] = process.argv;

if (!commitish || !version) {
  console.error('Usage: node scripts/record-template-hashes.mjs <commit-ish> <version>');
  process.exit(1);
}

// Kept in sync with KIT_OWNED_FILES in src/services/template-manifest.ts —
// duplicated as a plain list (rather than imported) so this script has no
// build step and runs directly with `node`.
const KIT_OWNED_FILES = [
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

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

console.log(`  // ${version} — recorded from ${commitish}`);
for (const rel of KIT_OWNED_FILES) {
  let content;
  try {
    content = execFileSync('git', ['show', `${commitish}:src/templates/next-js/${rel}`], {
      encoding: 'utf8',
    });
  } catch {
    console.log(`  // '${rel}': not present at ${commitish}, skipped`);
    continue;
  }
  console.log(`  '${rel}': { '${version}': '${sha256(content)}' },`);
}
