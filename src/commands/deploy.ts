import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readManifest, updateManifestFields } from '../services/manifest';
import { deriveUrls, type HostingTarget } from '../services/hosting';
import { probeUrl } from '../services/verify';

/**
 * `flashmandu-app deploy` — record a real production host on the manifest.
 *
 * `push` is marketplace publish only and never touches a host; this is where
 * hosting is decided. It deliberately does NOT ship code over SSH or hold
 * credentials: for `--target self` the developer deploys with their own
 * tooling and supplies the resulting URL, which keeps the CLI stack-agnostic.
 */
export function makeDeployCommand(): Command {
  return new Command('deploy')
    .description('Point this app at a real production host and record it in the manifest.')
    .option('-d, --dir <path>', 'App directory', '.')
    .option('-t, --target <target>', 'Hosting target: vercel | self')
    .option('--base-url <url>', 'Base URL (required for --target self)')
    .action(async (opts: { dir: string; target?: HostingTarget; baseUrl?: string }, cmd: Command) => {
      const dir = path.resolve(opts.dir);
      const manifest = await readManifest(dir);

      // The program already owns a global --base-url; commander gives the
      // flag to the parent, so read the merged view to pick it up.
      const merged = cmd.optsWithGlobals() as { baseUrl?: string };

      let target = opts.target;
      if (!target) {
        const { select } = await import('@inquirer/prompts');
        target = await select<HostingTarget>({
          message: `Where is "${manifest.name}" hosted?`,
          choices: [
            { value: 'vercel', name: 'Vercel — deploy now with the Vercel CLI' },
            { value: 'self', name: 'My own server — I have already deployed it' },
          ],
        });
      }

      let baseUrl = opts.baseUrl ?? merged.baseUrl;

      if (target === 'vercel') {
        const spinner = ora('Deploying to Vercel…').start();
        try {
          // The Vercel CLI owns its own auth; shelling out avoids
          // reimplementing token handling here.
          baseUrl = execFileSync('vercel', ['deploy', '--prod', '--yes'], {
            cwd: dir,
            encoding: 'utf8',
          }).trim().split('\n').pop();
          spinner.succeed(`Deployed to ${baseUrl}`);
        } catch (err) {
          spinner.fail('Vercel deploy failed.');
          throw new Error(
            `Could not deploy with the Vercel CLI. Install it (npm i -g vercel) and run \`vercel login\`, ` +
              `or deploy yourself and use --target self --base-url <url>.\n${(err as Error).message}`,
          );
        }
      }

      if (!baseUrl) {
        const { input } = await import('@inquirer/prompts');
        baseUrl = await input({
          message: 'Base URL of your deployed app (https://…):',
        });
      }

      const urls = deriveUrls(baseUrl);

      const spinner = ora('Verifying URLs…').start();
      for (const [field, url] of Object.entries(urls)) {
        const result = await probeUrl(url);
        if (!result.ok) {
          spinner.fail(`${field} failed verification.`);
          throw new Error(
            `${result.error}\nThe platform probes these URLs too and will refuse to approve the app, ` +
              `so fix the host before pushing.`,
          );
        }
      }
      spinner.succeed('All URLs reachable.');

      await updateManifestFields(dir, { ...urls, hosting_target: target });

      console.log(chalk.green(`\n  Recorded ${target} host ${baseUrl} in flashmandu.app.toml:`));
      for (const [field, url] of Object.entries(urls)) {
        console.log(chalk.dim(`    ${field} = ${url}`));
      }
      console.log(chalk.dim('\n  Next: flashmandu-app push'));
    });
}
