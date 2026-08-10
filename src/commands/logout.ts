import { Command } from 'commander';
import chalk from 'chalk';
import { getActiveName, listProfiles, removeProfile } from '../services/credentials';

/** `autohisab-business logout [profile]` — remove a profile from the credential store. */
export function makeLogoutCommand(): Command {
  const cmd = new Command('logout')
    .description('Remove a stored profile (default: the active one).')
    .argument('[profile]', 'Profile name to remove')
    .action(async (profile?: string) => {
      const target = profile ?? (await getActiveName());
      if (!target) {
        console.log(chalk.yellow('No profiles to log out.'));
        return;
      }
      const removed = await removeProfile(target);
      if (!removed) {
        console.log(chalk.yellow(`No profile named "${target}".`));
        return;
      }
      console.log(chalk.green(`✓ Removed profile "${target}".`));
      const { names } = await listProfiles();
      if (names.length === 0) {
        console.log(chalk.dim('  No profiles remain.'));
      } else {
        console.log(chalk.dim(`  Remaining: ${names.join(', ')}`));
      }
    });

  return cmd;
}
