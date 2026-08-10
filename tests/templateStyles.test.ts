import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * The template stylesheets must not fight the kit.
 *
 * THE BUG THIS LOCKS DOWN
 * -----------------------
 * `templates/next-js/app/globals.css` imported
 * `@flashmandu/app-bridge-ui`'s stylesheets and then redefined six of the
 * kit's own classes BELOW the import. Same selector, same specificity, later
 * in the cascade — the template won, silently, in every app ever scaffolded:
 *
 *   .fm-container  kit: max-width 1280px, padding 16/24px, gap 24px
 *                  tpl: max-width  880px, no padding,      gap 20px
 *   .fm-card       kit: padding 24px (measured against the host's Flux cards)
 *                  tpl: padding 20px (precisely what bridge-ui 333a237 removed)
 *
 * A scaffolded app therefore rendered as an 880px centred reading column — the
 * generic Next.js-docs silhouette — inside a host that renders full-bleed
 * content in a 1280px main. Every app was wrong from birth, and nothing
 * failed: an override at equal specificity produces no error anywhere.
 *
 * THE RULE
 * --------
 * The `.fm-*` class namespace belongs to @flashmandu/app-bridge-ui. A template
 * stylesheet may CONSUME those classes in markup and may override `--fm-*`
 * TOKENS (the supported seam — tokens theme cleanly and cascade into the kit's
 * own rules). It may not define a rule whose selector targets an `.fm-*`
 * class, at any specificity: a kit gap is a kit gap, to be filed against
 * bridge-ui, not patched around locally where it will drift on the next kit
 * release. Local styling uses the `app-` prefix.
 *
 * The check is namespace-wide rather than a diff against the kit's current
 * class list on purpose: the CLI does not depend on bridge-ui, and a snapshot
 * of its classes would go stale exactly when the kit grows a new one — which
 * is the moment a pre-existing template rule silently starts overriding it.
 */

const TEMPLATES_DIR = path.join(__dirname, '..', 'src', 'templates');

/** Files that can carry CSS: stylesheets, plus anything with a <style> block. */
const STYLE_BEARING = /\.(css|scss|php|html|htm|tsx|jsx|vue|svelte)$/i;

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      out.push(...(await walk(full)));
    } else if (STYLE_BEARING.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The CSS a file contributes: the whole file for a stylesheet, otherwise only
 * the contents of its `<style>` blocks. Comments are stripped so that prose
 * explaining the rule (which necessarily names `.fm-container`) is not read as
 * a rule itself.
 */
function cssIn(file: string, source: string): string {
  const raw = /\.(css|scss)$/i.test(file)
    ? source
    : [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');

  return raw.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Selector text of every rule in a stylesheet: everything between the end of
 * the previous block and the `{` that opens this one. Skips at-rule preludes
 * (`@media …`, `@layer …`) but keeps descending into their bodies, which the
 * flat scan reaches anyway since their inner rules also end in `{`.
 */
function selectorsIn(css: string): string[] {
  const out: string[] = [];
  for (const match of css.matchAll(/(^|[};])\s*([^{};@][^{}]*?)\s*\{/g)) {
    const selector = match[2].replace(/\s+/g, ' ').trim();
    // A declaration value can contain `{` only inside a string; a selector
    // never contains `:` followed by a `;`-terminated value, so anything left
    // here is a real selector list.
    if (selector !== '') out.push(selector);
  }
  return out;
}

describe('template stylesheets never override the kit', () => {
  it('defines no rule targeting a .fm-* class', async () => {
    const files = await walk(TEMPLATES_DIR);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];

    for (const file of files) {
      const css = cssIn(file, await fs.readFile(file, 'utf8'));
      if (css.trim() === '') continue;

      for (const selector of selectorsIn(css)) {
        const claimed = [...selector.matchAll(/\.(fm-[A-Za-z0-9_-]+)/g)].map((m) => m[1]);
        for (const cls of claimed) {
          violations.push(`${path.relative(TEMPLATES_DIR, file)}:  ${selector}   (claims .${cls})`);
        }
      }
    }

    expect(
      violations,
      violations.length === 0
        ? ''
        : `Template stylesheets must not define .fm-* rules — that namespace belongs to\n` +
            `@flashmandu/app-bridge-ui, and a same-name rule after the kit's import wins\n` +
            `silently at equal specificity. Use a kit modifier, override the --fm-* token,\n` +
            `or name the class app-*. If the kit is genuinely missing something, file it\n` +
            `against bridge-ui.\n\n${violations.join('\n')}\n`,
    ).toEqual([]);
  });

  it('loads no webfont from a third-party origin', async () => {
    // The kit self-hosts the platform typeface (Instrument Sans) and points
    // --fm-font-sans at it, so a template needs no font request of its own. A
    // Google Fonts @import would re-add two third-party handshakes on the
    // critical path and fail silently — as an unstyled fallback typeface — on
    // exactly the slow and filtered connections this product serves.
    const files = await walk(TEMPLATES_DIR);
    const offenders: string[] = [];

    for (const file of files) {
      const source = await fs.readFile(file, 'utf8');
      if (/fonts\.googleapis\.com|fonts\.gstatic\.com|fonts\.bunny\.net|use\.typekit/.test(source)) {
        offenders.push(path.relative(TEMPLATES_DIR, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});
