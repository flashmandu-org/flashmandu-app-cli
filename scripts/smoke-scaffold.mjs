#!/usr/bin/env node
/**
 * Scaffold smoke test: prove a freshly generated app actually BUILDS.
 *
 * Why this exists
 * ---------------
 * Two independent failures shipped to real scaffolded apps because nothing
 * ever built the template end to end:
 *
 *  1. @flashmandu/app-bridge was published without its `./react` subpath, so
 *     every scaffolded app died with "Package path ./react is not exported".
 *     The reference app (interactive-map) used `file:` deps and resolved the
 *     working tree, so it never noticed.
 *
 *  2. app/embed/[type]/page.tsx was a 'use client' component importing
 *     node:crypto, which fails webpack outright — and read the App Secret in
 *     a browser bundle, which is worse than failing.
 *
 * Copying the template and running `next build` catches both classes in one
 * shot. Run before publishing the CLI, and in CI.
 *
 * By default the generated app is wired to the LOCAL package checkouts (so
 * unreleased changes are exercised). Pass --registry to install the published
 * versions instead, which is what validates a real `npm install`.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const template = path.join(repoRoot, 'src', 'templates', 'next-js');
const useRegistry = process.argv.includes('--registry');

/** Local checkouts, resolved as siblings of this repo. */
const localPackages = {
    '@flashmandu/app-bridge': path.resolve(repoRoot, '..', 'flashmandu-app-bridge'),
    '@flashmandu/app-bridge-ui': path.resolve(repoRoot, '..', 'flashmandu-app-bridge-ui'),
};

if (!existsSync(template)) {
    console.error(`✗ template not found at ${template}`);
    process.exit(1);
}

const workdir = mkdtempSync(path.join(tmpdir(), 'fm-scaffold-smoke-'));
const app = path.join(workdir, 'app');

try {
    cpSync(template, app, { recursive: true });

    // .gitignore ships as a template file; it does not affect the build.
    const pkgPath = path.join(app, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.name = 'scaffold-smoke-test';
    pkg.private = true;

    if (!useRegistry) {
        for (const [name, dir] of Object.entries(localPackages)) {
            if (!existsSync(dir)) {
                console.error(
                    `✗ local checkout for ${name} not found at ${dir}\n` +
                    '  Clone it beside this repo, or run with --registry.',
                );
                process.exit(1);
            }
            pkg.dependencies[name] = `file:${dir}`;
        }
    }

    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

    // A .env is required for the build to read config without throwing.
    if (existsSync(path.join(app, '.env.example'))) {
        cpSync(path.join(app, '.env.example'), path.join(app, '.env'));
    }

    const mode = useRegistry ? 'published packages' : 'local package checkouts';
    console.log(`→ scaffolding into ${app}`);
    console.log(`→ installing (${mode})…`);
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
        cwd: app,
        stdio: 'inherit',
    });

    console.log('→ building…');
    execFileSync('npx', ['next', 'build'], { cwd: app, stdio: 'inherit' });

    console.log(`\n✓ scaffolded app installs and builds cleanly (${mode}).`);
} catch (error) {
    console.error(`\n✗ scaffold smoke test FAILED: ${error.message}`);
    console.error(`  Generated app left at ${app} for inspection.`);
    process.exit(1);
}

rmSync(workdir, { recursive: true, force: true });
