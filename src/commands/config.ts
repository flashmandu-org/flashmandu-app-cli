import { Command } from 'commander';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getActive,
  getActiveName,
  listProfiles,
  setProfile,
} from '../services/credentials';

/**
 * `flashmandu-app config` — manage the active profile's `base_url` (the
 * dev-box host). There is intentionally no `base_url` compiled into the CLI;
 * the developer points it at whichever dev box they're targeting.
 *
 *   flashmandu-app config set base_url https://dev.flashmandu.example
 *   flashmandu-app config get base_url
 *   flashmandu-app config list
 */
export function makeConfigCommand(): Command {
  const cmd = new Command('config').description(
    'Manage CLI configuration (base_url, active profile).',
  );

  cmd
    .command('set <key> <value>')
    .description('Set a config value. Supported keys: base_url (the platform/dev-box host, NOT your app URL).')
    .action(async (key: string, value: string) => {
      if (key !== 'base_url') {
        throw new Error(
          `Unknown config key "${key}". Only "base_url" is configurable via this command.`,
        );
      }
      if (!/^https?:\/\//i.test(value)) {
        throw new Error(
          `base_url must include the scheme, e.g. https://dev.flashmandu.example (got "${value}")`,
        );
      }
      const normalized = value.replace(/\/+$/, '');
      const active = await getActiveName();
      if (!active) {
        throw new Error(
          'No active profile. Run `flashmandu-app login` first; base_url is stored per profile.',
        );
      }
      const entry = await getActive();
      await setProfile(active, { ...entry, base_url: normalized });
      console.log(chalk.green(`✓ Platform base_url for profile "${active}" set to ${normalized}`));
      console.log(chalk.dim('  This is the Flashmandu host the CLI talks to — your app’s public URL comes from the `dev` tunnel, not this setting.'));
    });

  cmd
    .command('get <key>')
    .description('Print a config value.')
    .action(async (key: string) => {
      if (key !== 'base_url') {
        throw new Error(`Unknown config key "${key}".`);
      }
      const entry = await getActive();
      console.log(entry.base_url);
    });

  cmd
    .command('list')
    .description('List all configured profiles.')
    .action(async () => {
      const { active, names } = await listProfiles();
      if (names.length === 0) {
        console.log(chalk.yellow('No profiles. Run `flashmandu-app login`.'));
        return;
      }
      for (const name of names) {
        const marker = name === active ? chalk.green('* ') : '  ';
        console.log(`${marker}${name}`);
      }
    });

  cmd
    .command('reset-profiles')
    .description('Delete ALL stored profiles (interactive).')
    .action(async () => {
      const ok = await confirm({
        message: 'Delete every profile in ~/.flashmandu/credentials.toml?',
        default: false,
      });
      if (!ok) {
        console.log(chalk.dim('Aborted.'));
        return;
      }
      const file = path.join(os.homedir(), '.flashmandu', 'credentials.toml');
      await fs.rm(file, { force: true });
      console.log(chalk.green('✓ All profiles removed.'));
    });

  return cmd;
}
