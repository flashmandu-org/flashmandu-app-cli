import { Command } from 'commander';
import chalk from 'chalk';
import { getActiveName } from '../services/credentials';
import { get } from '../services/apiClient';

interface MeResponse {
  app_id?: string;
  name?: string;
  profile_id?: number;
  scopes?: string[];
  subscribed_events?: string[];
}

/** `autohisab-business whoami` — verify the stored token against `GET /api/apps/me`. */
export function makeWhoamiCommand(): Command {
  return new Command('whoami')
    .description('Show the currently authenticated developer / app identity.')
    .action(async () => {
      const profile = await getActiveName();
      const me = await get<MeResponse>('/api/apps/me');
      console.log(chalk.green(`✓ Authenticated`));
      if (profile) console.log(chalk.dim(`  Profile:  ${profile}`));
      if (me.app_id) console.log(chalk.dim(`  App ID:   ${me.app_id}`));
      if (me.name) console.log(chalk.dim(`  Name:     ${me.name}`));
      if (me.profile_id !== undefined) console.log(chalk.dim(`  Profile:  ${me.profile_id}`));
      if (me.scopes?.length) console.log(chalk.dim(`  Scopes:   ${me.scopes.join(', ')}`));
      if (me.subscribed_events?.length) {
        console.log(chalk.dim(`  Events:   ${me.subscribed_events.join(', ')}`));
      }
    });
}
