import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';

import { MANIFEST_FILENAME, readManifest } from '../services/manifest';
import { readSandboxIdentity } from '../services/sandboxSecrets';
import { getActive } from '../services/credentials';
import {
  runAndReport,
  watchSections,
  type SectionDevEvent,
} from '../services/sectionDev';

/**
 * `autohisab-business section dev` — the no-server iteration loop for
 * `[[storefront_sections]]` (Tier 1: declarative blueprint sections).
 *
 * Unlike `autohisab-business dev`, this never starts an app server or a
 * tunnel: a blueprint section is pure data (an element tree built from
 * existing page-builder elements), so there is nothing to run. The loop is
 * edit-JSON → save → the dev-box's section library updates.
 *
 * Auth reuses the sandbox secrets file `autohisab-business dev` writes
 * (`.flashmandu/sandbox-secrets.<app>.json`) rather than inventing a second
 * session: `PUT /api/apps/dev/sections` resolves identity from the bearer,
 * exactly like `/dev/register` and `/dev/deliveries`, so pushing with the
 * developer LOGIN token would silently target the `dev/cli` app instead of
 * this one.
 */

function printEvent(evt: SectionDevEvent): void {
  const ts = chalk.dim(new Date().toLocaleTimeString());
  switch (evt.type) {
    case 'pushed':
      console.log(`${ts} ${chalk.green('✓')} ${evt.message}`);
      return;
    case 'blueprint-error':
      console.log(`${ts} ${chalk.red('✗')} ${evt.message}`);
      console.log(chalk.dim('  Not pushed — fix the file above and save again.'));
      return;
    case 'rejected':
      console.log(`${ts} ${chalk.red('✗ rejected by the host:')} ${evt.message}`);
      return;
    case 'error':
      console.log(`${ts} ${chalk.red('✗')} ${evt.message}`);
      return;
  }
}

export function makeSectionCommand(): Command {
  const cmd = new Command('section').description(
    'Manage [[storefront_sections]] (Tier 1 declarative blueprint sections).',
  );

  cmd
    .command('dev')
    .description(
      'Watch the manifest and referenced blueprint_file JSON, pushing to the dev-box on every save. No server required.',
    )
    .option('-d, --dir <path>', 'App directory', '.')
    .option('--once', 'Push once and exit instead of watching')
    .action(async (opts: { dir: string; once?: boolean }) => {
      const appDir = path.resolve(opts.dir);
      const manifest = await readManifest(appDir);

      if (!manifest.storefront_sections || manifest.storefront_sections.length === 0) {
        console.log(
          chalk.yellow(
            `No [[storefront_sections]] declared in ${MANIFEST_FILENAME} — nothing to push. ` +
              'Add a section block first (see the SDK README for the TOML shape).',
          ),
        );
        return;
      }

      const { token, appId } = await readSandboxIdentity(appDir, manifest.slug);
      if (!token) {
        console.log(
          chalk.dim(
            'No .flashmandu/sandbox-secrets file found — falling back to the login token, which ' +
              'resolves to the dev/cli app, not yours. Run `autohisab-business dev` once first so ' +
              'sections push onto YOUR app.',
          ),
        );
      }

      const profile = await getActive();
      const displayId = appId ?? manifest.slug;
      console.log(
        chalk.cyan(
          `Preview: ${profile.base_url.replace(/\/+$/, '')} — open the page builder on your sandbox ` +
            `profile; sections from "${displayId}" appear in the section library badged "App: ${manifest.name}".`,
        ),
      );

      if (opts.once) {
        await runAndReport(appDir, { token }, printEvent);
        return;
      }

      console.log(
        chalk.dim(`Watching ${MANIFEST_FILENAME} and referenced blueprint files. Ctrl+C to stop.`),
      );
      const handle = watchSections(appDir, { token }, printEvent);

      await new Promise<void>((resolve) => {
        const stop = (): void => {
          console.log(chalk.dim('\nShutting down…'));
          handle.close();
          resolve();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });

  return cmd;
}
