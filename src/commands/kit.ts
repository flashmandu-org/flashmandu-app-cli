import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';

import { kitStatus, kitSync, type KitStatusRow } from '../services/kit';

/**
 * `autohisab-business kit status` / `kit sync` — see `src/services/kit.ts` for
 * why this exists (spec §2.2: the bridge SDK is hand-vendored three different
 * ways, with nothing keeping the copies in step).
 */

function formatRow(row: KitStatusRow): string {
  const current = row.style !== 'missing' && row.installed === row.pinned && row.style !== 'dir';
  const styleLabel = row.style === 'missing' ? chalk.red('missing') : row.style;

  if (current) {
    return `${chalk.green('✓')} ${row.short.padEnd(14)} ${chalk.dim('tgz')} ${row.pinned}`;
  }

  return (
    `${chalk.yellow('✗')} ${row.short.padEnd(14)} ${styleLabel} ${row.installed} → tgz ${row.pinned}` +
    `  ${chalk.dim('(run: autohisab-business kit sync)')}`
  );
}

export function makeKitCommand(): Command {
  const cmd = new Command('kit').description(
    'Manage the vendored bridge SDK kit (@flashmandu/app-bridge, app-bridge-ui).',
  );

  cmd
    .command('status')
    .description('Show installed vs CLI-pinned kit versions.')
    .option('-d, --dir <path>', 'App directory', '.')
    .action((opts: { dir: string }) => {
      const cwd = path.resolve(opts.dir);
      const rows = kitStatus(cwd);
      for (const row of rows) {
        console.log(formatRow(row));
      }
      const stale = rows.some((r) => r.style === 'dir' || r.style === 'missing' || r.installed !== r.pinned);
      if (stale) process.exitCode = 1;
    });

  cmd
    .command('sync')
    .description('Vendor the pinned kit tgz files into vendor/, rewrite package.json, and npm install.')
    .option('-d, --dir <path>', 'App directory', '.')
    .action((opts: { dir: string }) => {
      const cwd = path.resolve(opts.dir);
      kitSync(cwd);
      console.log(chalk.green('✓ Kit synced to the pinned versions.'));
      for (const row of kitStatus(cwd)) {
        console.log(formatRow(row));
      }
    });

  return cmd;
}
