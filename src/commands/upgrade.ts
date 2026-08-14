import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';

import { upgradeApp, type UpgradeResult } from '../services/template-manifest';

/**
 * `autohisab-business upgrade` — see `src/services/template-manifest.ts` for
 * the hash-matching contract this re-applies kit-owned template files under.
 */

function formatResult(r: UpgradeResult): string {
  switch (r.status) {
    case 'created':
      return `${chalk.green('+')} ${r.rel} ${chalk.dim('(created — was missing)')}`;
    case 'upgraded':
      return `${chalk.green('✓')} ${r.rel} ${chalk.dim('(upgraded)')}`;
    case 'unchanged':
      return `${chalk.dim('·')} ${r.rel} ${chalk.dim('(unchanged)')}`;
    case 'forked':
      return `${chalk.yellow('⚠')} ${r.rel} ${chalk.yellow('skipped (forked)')}`;
  }
}

export function makeUpgradeCommand(): Command {
  return new Command('upgrade')
    .description('Re-apply kit-owned template files (next.config.js, route factories, route-state scaffolds) from the current CLI template.')
    .option('-d, --dir <path>', 'App directory', '.')
    .action((opts: { dir: string }) => {
      const cwd = path.resolve(opts.dir);
      const results = upgradeApp(cwd);

      for (const r of results) {
        console.log(formatResult(r));
      }

      const upgraded = results.filter((r) => r.status === 'upgraded' || r.status === 'created').length;
      const forked = results.filter((r) => r.status === 'forked').length;

      console.log('');
      console.log(
        chalk.green(`✓ upgrade: ${upgraded} file(s) updated`) +
          (forked > 0 ? chalk.yellow(`, ${forked} skipped (forked) — review them by hand.`) : '.'),
      );
    });
}
