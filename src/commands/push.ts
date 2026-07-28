import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'node:path';
import { readManifest } from '../services/manifest';
import { post } from '../services/apiClient';

/**
 * `flashmandu-app push` — submit the app to the dev-box marketplace for
 * operator review. Reserved verb: marketplace publish ONLY. It NEVER touches a
 * production host. The CLI has no production host compiled in.
 *
 * Hits `POST /api/apps/app-submissions` (the open, throttled submission
 * endpoint) using metadata from `flashmandu.app.toml` plus developer fields
 * the developer must provide (name, email, source_url).
 */

interface SubmissionResponse {
  id: number | string;
  status: string;
}

export function makePushCommand(): Command {
  const cmd = new Command('push')
    .description('Submit this app to the dev-box marketplace for review. Does NOT touch prod.')
    .option('-d, --dir <path>', 'App directory', '.')
    .option('--developer-name <name>', 'Your name or org (required if missing from manifest)')
    .option('--developer-email <email>', 'Contact email (required if missing from manifest)')
    .option('--source-url <url>', 'Public source URL (e.g. github)')
    .option('--description <text>', 'Override the manifest description')
    .option('--yes', 'Skip the confirmation prompt')
    .action(
      async (opts: {
        dir: string;
        developerName?: string;
        developerEmail?: string;
        sourceUrl?: string;
        description?: string;
        yes?: boolean;
      }) => {
        const manifest = await readManifest(path.resolve(opts.dir));

        const developerName =
          opts.developerName ?? manifest.developer_name;
        const developerEmail =
          opts.developerEmail ?? manifest.developer_email;
        const sourceUrl = opts.sourceUrl ?? manifest.source_url;

        if (!developerName || !developerEmail) {
          throw new Error(
            'Marketplace submission requires developer_name and developer_email. ' +
              'Provide via flashmandu.app.toml or --developer-name / --developer-email.',
          );
        }

        const description = opts.description ?? manifest.description ?? '';

        if (!opts.yes) {
          const { confirm } = await import('@inquirer/prompts');
          const ok = await confirm({
            message: `Submit "${manifest.name}" (${manifest.id} v${manifest.version}) to the dev-box marketplace?`,
            default: false,
          });
          if (!ok) {
            console.log(chalk.dim('Aborted.'));
            return;
          }
        }

        const spinner = ora('Submitting…').start();
        try {
          const res = await post<SubmissionResponse>(
            '/api/apps/app-submissions',
            {
              developer_name: developerName,
              developer_email: developerEmail,
              app_id: manifest.id,
              name: manifest.name,
              provider_class: manifest.provider_class,
              source_url: sourceUrl,
              description,
            },
            // Submission is the open, throttled endpoint (no Bearer required);
            // but if a token is present it's still sent (harmless, and lets
            // the dev-box attribute the submission).
            { noAuth: true },
          );
          spinner.succeed(chalk.green(`Submitted (id #${res.id}, status: ${res.status}).`));
          console.log(
            chalk.dim('  An operator will review and approve. You cannot self-publish.'),
          );
        } catch (err) {
          spinner.fail('Submission failed.');
          throw err;
        }
      },
    );

  return cmd;
}
