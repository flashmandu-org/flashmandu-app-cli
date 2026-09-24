import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * A scaffolded app must be born on the CURRENT kit surfaces and on the current
 * product decisions. Both have drifted before, and both drift silently: a
 * template that is merely out of date still compiles, still runs, and teaches
 * every new app the old shape on day one.
 *
 * Two rules are locked down here.
 *
 * 1. ACTION PLACEMENT (product decision, 2026-08-11). The host command bar
 *    carries the dirty-state form pair — Save / Discard / Cancel — and nothing
 *    else. Create, Preview and cross-surface navigation render IN THE PAGE,
 *    above the content, exactly where the host's own index pages put them. The
 *    template used to publish "New item" to the command bar and documented
 *    that as intentional, which put it in direct contradiction with the first
 *    app shipped against it.
 *
 * 2. THE FILTER SECTION. A list surface is not a search box. The kit's
 *    `FilterBar` carries the platform's whole filter contract — one attached
 *    Filter menu, quick filters, chips, and the save-as-default pin — and the
 *    example list has to demonstrate it, or nothing scaffolded from here will
 *    ever have the pin.
 */

const ITEMS_PAGE = path.join(__dirname, '..', 'src', 'templates', 'next-js', 'app', 'items', 'page.tsx');

async function itemsPage(): Promise<string> {
    return fs.readFile(ITEMS_PAGE, 'utf8');
}

/** The file with its block and line comments removed — prose is not code. */
function codeOnly(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the scaffolded list surface', () => {
    it('renders create IN THE PAGE, not in the host command bar', async () => {
        const code = codeOnly(await itemsPage());

        // No `actions` prop on AppPage at all on a list route: the bar is for
        // Save/Discard, and this page has no form.
        expect(code).not.toMatch(/actions=\{\[/);
        expect(code).toMatch(/className="fm-page-actions"/);
        expect(code).toMatch(/New item/);
    });

    it('demonstrates the kit filter section, pin included', async () => {
        const code = codeOnly(await itemsPage());

        expect(code).toContain('FilterBar');
        // `defaults` IS the pin. Without it the app cannot save a default view,
        // which every native list on the platform can.
        expect(code).toMatch(/defaults=\{\{\s*scope:/);
        // Scoped per merchant, or two profiles on one browser share a default.
        expect(code).toMatch(/profileId/);
    });

    it('declares no page padding — the kit container owns it', async () => {
        const code = codeOnly(await itemsPage());

        expect(code).not.toMatch(/padding\s*:/i);
        expect(code).not.toMatch(/margin\s*:\s*['"`]?\d/);
    });
});

describe('the scaffolded form surface (PG-329a)', () => {
    it('renders the settings form as <FormPage>, never a hand-published Save', async () => {
        const settings = path.join(__dirname, '..', 'src', 'templates', 'next-js', 'app', '(admin)', 'settings', 'page.tsx');
        const code = codeOnly(await fs.readFile(settings, 'utf8'));

        expect(code).toMatch(/<FormPage[\s\S]*dirty=\{dirty\}[\s\S]*onSubmit=\{save\}/);
        expect(code).not.toMatch(/<Page[\s>]/);
        expect(code).not.toMatch(/id:\s*'save'/);
    });
});
