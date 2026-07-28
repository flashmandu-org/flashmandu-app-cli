import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { input, password } from '@inquirer/prompts';
import { setProfile } from '../services/credentials';
import { get, post } from '../services/apiClient';

/**
 * `flashmandu-app login` — authenticate against the dev-box and store a
 * developer Bearer token in `~/.flashmandu/credentials.toml` (0600).
 *
 * Flow (device-code style):
 *   1. Ask for the dev-box base_url (no production host is ever compiled in).
 *   2. Ask for a profile name (default: "default").
 *   3. POST the developer's username/password to `/api/apps/dev/login` and
 *      receive `{ token, expires_at }`. The dev-box issues a long-lived dev
 *      token scoped to sandbox operations only.
 *   4. Verify with `GET /api/apps/me` and persist.
 *
 * The exact auth backend on the dev-box is pluggable; this CLI only needs a
 * Bearer token out. If/when the dev-box exposes a true OAuth device-code
 * endpoint, swap step 3 for it — the storage layer is unchanged.
 */

interface DevLoginResponse {
  token: string;
  expires_at?: string;
}

interface MeResponse {
  app_id?: string;
  name?: string;
  profile_id?: number;
  scopes?: string[];
  subscribed_events?: string[];
}

export function makeLoginCommand(): Command {
  const cmd = new Command('login').description(
    'Authenticate against the dev-box and store a developer token.',
  );

  cmd
    .option('-b, --base-url <url>', 'Dev-box base URL, e.g. https://dev.flashmandu.example')
    .option('-p, --profile <name>', 'Profile name to store this login under', 'default')
    .option('--token <token>', 'Use an existing token instead of prompting for credentials')
    .action(async (opts: { baseUrl?: string; profile: string; token?: string }) => {
      const baseUrl = (opts.baseUrl ?? (await input({
        message: 'Dev-box base URL (https://...):',
        validate: (v) => (/^https?:\/\//i.test(v) ? true : 'Include the http(s) scheme.'),
      }))).replace(/\/+$/, '');

      let token: string;
      if (opts.token) {
        token = opts.token;
      } else {
        const user = await input({ message: 'Developer username / email:' });
        const pass = await password({ message: 'Password:', mask: '*' });
        const spinner = ora('Authenticating…').start();
        try {
          const res = await post<DevLoginResponse>(
            '/api/apps/dev/login',
            { username: user, password: pass },
            { baseUrl, noAuth: true },
          );
          token = res.token;
          spinner.succeed('Authenticated.');
        } catch (err) {
          spinner.fail('Login failed.');
          throw err;
        }
      }

      // Verify the token round-trips against /me.
      const me = await get<MeResponse>('/api/apps/me', { baseUrl, token });
      await setProfile(opts.profile, { token, base_url: baseUrl });

      console.log(chalk.green(`✓ Logged in as profile "${opts.profile}" at ${baseUrl}`));
      if (me.name) console.log(chalk.dim(`  Identity: ${me.name}`));
      console.log(chalk.dim(`  Token expires: store securely; rotate via the dev-box UI.`));
    });

  return cmd;
}
