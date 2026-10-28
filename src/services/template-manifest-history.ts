import type { TemplateManifest } from './template-manifest';

/**
 * Hashes of kit-owned template files AS THEY SHIPPED at template versions
 * that are no longer reachable by reading the current working tree.
 *
 * Why this file exists (and isn't computed at runtime)
 * ------------------------------------------------------
 * `buildManifest()` in `template-manifest.ts` can only hash content that
 * still exists on disk — the CURRENT template, under the CURRENT
 * `TEMPLATE_VERSION`. Once a release bumps `TEMPLATE_VERSION`, the previous
 * version's file content is gone from the working tree (it only survives in
 * git history), so there is nothing left for `buildManifest()` to hash for
 * it. Without a durable record, `upgradeApp()` can never recognise an app
 * scaffolded at an older version as "untouched" — every such app gets
 * misreported `forked`, which defeats the whole point of `upgrade`.
 *
 * This constant is that durable record. It is a plain committed TypeScript
 * object (not generated at build time, not fetched from git at runtime —
 * git history is a CLI implementation detail an installed npm package does
 * not carry) so it survives `npm run build` / `npm publish` and is available
 * to every future run of the CLI, regardless of what git history is present
 * on the machine running it.
 *
 * `defaultManifest()` merges this with the freshly-computed current-version
 * manifest via `mergeManifests()`, so `upgradeApp()` recognises content from
 * every version the CLI has ever shipped, not just the current one.
 *
 * -----------------------------------------------------------------------
 * PROCEDURE: recording a version's hashes before bumping TEMPLATE_VERSION
 * -----------------------------------------------------------------------
 * Do this as the LAST step before a commit that changes `TEMPLATE_VERSION`,
 * against the commit that is about to become "old" (i.e. before the content
 * change lands, or at the tag/commit that shipped the outgoing version):
 *
 *   1. Find the commit whose `src/templates/next-js/**` tree is exactly what
 *      shipped at the outgoing version (usually just `HEAD`, before the
 *      content edit you're about to make).
 *   2. Run `node scripts/record-template-hashes.mjs <commit-ish> <version>`.
 *      It reads each `KIT_OWNED_FILES` entry via `git show
 *      <commit-ish>:src/templates/next-js/<rel>` (so it works even after
 *      the working tree has moved on) and prints a ready-to-paste object
 *      literal.
 *   3. Paste the printed block in as a new entry below, keyed by that
 *      version string.
 *   4. Add/confirm a test asserting `HISTORICAL_TEMPLATE_HASHES[rel][version]`
 *      equals `sha256(<the real committed content>)` for at least the
 *      file(s) that changed (see `tests/templateManifestHistory.test.ts`).
 *   5. Now bump `TEMPLATE_VERSION` and make the content change. The outgoing
 *      version's hashes are safely on record before its content disappears
 *      from the working tree.
 *
 * A file that DIDN'T change between two versions does not need a new entry
 * at the new version — its old-version hash already equals its current
 * hash, and `buildManifest()` will (re-)record that same hash under the new
 * version at runtime. Only add an entry here when a file's content actually
 * differs from what `buildManifest()` can compute today.
 */
export const HISTORICAL_TEMPLATE_HASHES: TemplateManifest = {
  // Recovered from commit 4bc4b56 (`fix(template): move usePageChrome
  // wiring out of the Server Component layout`) — the last commit whose
  // `src/templates/next-js` tree matches what actually shipped under
  // TEMPLATE_VERSION '0.4.0', immediately before 9feb5e0 bumped to '0.4.1'
  // and edited app/PageChromeSetup.tsx.
  //
  // Only app/PageChromeSetup.tsx's content differs between 0.4.0 and 0.4.1
  // (the obsolete `as unknown as PageChromeHook` cast and a stale docblock
  // paragraph were removed). Every other kit-owned file is byte-identical
  // between the two versions, so its 0.4.0 hash equals its current hash —
  // recorded here anyway for a complete, self-contained record of what
  // 0.4.0 actually shipped.
  // 0.5.1 -> 0.6.0: next.config.js gained `output: 'standalone'` (platform
  // images ship the traced standalone server). The 0.5.1 content is byte-identical
  // to 0.4.0, so both versions share one hash (recorded from f41deb5's file, HEAD
  // before the 0.6.0 edit).
  'next.config.js': {
    '0.4.0': '604475885ca24caadba16b0fea95f51e704c4fb1436ae3b78b9d9f50e4847305',
    '0.5.1': '604475885ca24caadba16b0fea95f51e704c4fb1436ae3b78b9d9f50e4847305',
  },
  'app/globals.css': {
    '0.4.0': 'f3e0691b0cf1e32ce33b2e641c9052ef263f7b5475c23960700dcc740d5b7f9b',
  },
  'app/layout.tsx': {
    '0.4.0': '488336401cae7d4b7b8fc653273cfd4156ee38662876920071873f2139840b3c',
  },
  'app/PageChromeSetup.tsx': {
    '0.4.0': 'c3b1f6437233872942388e07ea69ed044842f2d1f4a108cbcd80dbb36fe6a0dd',
  },
  'app/loading.tsx': {
    '0.4.0': 'b33bbf0be1662561f95ce95487b9aabc3d7ac2bb3fb11526890f7094ffcef640',
  },
  'app/error.tsx': {
    '0.4.0': 'f50e21232f592cf51d593b194bf06a92d1233c18e3383830dcc3f234f91ff1ee',
  },
  'app/not-found.tsx': {
    '0.4.0': '127f63095c2e1017481956c065e76ae22906697c250111a92174ecdc6c3efe57',
  },
  'app/oauth/authorize/route.ts': {
    '0.4.0': 'e36e15b87adc7a8de25926ea3cd453afedcbb91c1fb0602e7ade71b9ff55b499',
  },
  'app/oauth/callback/route.ts': {
    '0.4.0': 'c4362e43ed56f69303dd0a03cc56eed997abbbf1368ae951a30d061f2a152af4',
  },
  'app/oauth/token/route.ts': {
    '0.4.0': '494bbb5e9ebce845459f781de76bce216f6891725dbc89edf0d60f734d3f97ef',
  },
  'app/webhooks/flashmandu/route.ts': {
    '0.4.0': '8f54be9318b1d296d2012d1a3a5954a7f0db5e133c9fc8ea0990aa924f32e161',
  },
  'lib/purge.ts': {
    '0.4.0': '48366a7ebb3da83cb39ec743cf372ce9eae7f69a0bbf63a9a352045a565dce9c',
  },
  // 0.5.0 -> 0.5.1: only lib/storage.ts changed (private buckets by default,
  // get() with Range for the gated file route, AWS/R2 config, human
  // 'unavailable' storage errors). Recorded from 0523a46, the last commit
  // whose storage.ts is what shipped as 0.5.0 (Tours 0.1.9 vendors it).
  'lib/storage.ts': {
    '0.5.0': 'e1ea509de5b6c1bf2749554bd65bbd7056c80d6cbaa433a4e9bd5808759165ea',
  },
};
