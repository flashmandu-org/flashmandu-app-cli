import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'node:path';
import { bumpPatch, readManifest, updateManifestFields } from '../services/manifest';
import { post } from '../services/apiClient';
import { isPlaceholderUrl } from '../services/verify';

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
  /** Canonical, publisher-namespaced id the platform assigned. */
  app_id?: string;
}

export function makePushCommand(): Command {
  const cmd = new Command('push')
    .description('Submit this app to the dev-box marketplace for review. Does NOT touch prod.')
    .option('-d, --dir <path>', 'App directory', '.')
    .option('--developer-name <name>', 'Your name or org (required if missing from manifest)')
    .option('--developer-email <email>', 'Contact email (required if missing from manifest)')
    .option('--source-url <url>', 'Public source URL (e.g. github)')
    .option('--description <text>', 'Override the manifest description')
    .option('--version <semver>', 'Submit this exact version instead of auto-bumping')
    .option('--no-bump', 'Submit the manifest version as-is, without bumping')
    .option('--yes', 'Skip the confirmation prompt')
    // `--target` is accepted only to reject it with an explanation. Hosting is
    // chosen by `deploy` and recorded in the manifest as hosting_target; `push`
    // is marketplace publish only. Accepting the flag turns commander's opaque
    // "unknown option '--target'" into a message that points at `deploy`.
    .option('-t, --target <target>', 'Rejected: hosting is chosen by `deploy`, not `push`')
    .action(
      async (opts: {
        dir: string;
        developerName?: string;
        developerEmail?: string;
        sourceUrl?: string;
        description?: string;
        version?: string;
        bump?: boolean;
        yes?: boolean;
        target?: string;
      }) => {
        if (opts.target) {
          throw new Error(pushTargetNotSupported(opts.target));
        }

        const manifest = await readManifest(path.resolve(opts.dir));

        // The template ships https://APP-HOST/... placeholders. Pushing those
        // produced an app that listed in the marketplace and then dead-ended
        // at ERR_NAME_NOT_RESOLVED when a merchant clicked Connect.
        const badUrls = (['authorize_url', 'token_url', 'webhook_url'] as const)
          .filter((field) => isPlaceholderUrl(manifest[field] ?? ''));

        if (badUrls.length > 0) {
          throw new Error(
            `Cannot push: ${badUrls.join(', ')} still ${badUrls.length === 1 ? 'holds a' : 'hold'} placeholder host.\n` +
              `Run \`flashmandu-app deploy --target vercel\` or \`--target self\` to set a real host first.`,
          );
        }

        // Developer identity is asked for ONCE. The first push writes it into
        // the manifest, so every later version of the same app reuses it and
        // the developer never re-types it.
        const developerName =
          opts.developerName ?? manifest.developer_name;
        const developerEmail =
          opts.developerEmail ?? manifest.developer_email;
        const sourceUrl = opts.sourceUrl ?? manifest.source_url;

        if (!developerName || !developerEmail) {
          throw new Error(
            'First submission needs developer_name and developer_email. ' +
              'Pass --developer-name / --developer-email once — they are saved to ' +
              'flashmandu.app.toml and reused for every later push.',
          );
        }

        // Each push is a NEW version for review; resubmitting the same one
        // leaves the operator unable to tell the builds apart. Bump the patch
        // by default, and persist it so the manifest and the marketplace agree.
        const submittedVersion =
          opts.version ?? (opts.bump === false ? manifest.version : bumpPatch(manifest.version));

        const description = opts.description ?? manifest.description ?? '';

        if (!opts.yes) {
          const { confirm } = await import('@inquirer/prompts');
          const ok = await confirm({
            message: `Submit "${manifest.name}" (${manifest.slug} v${submittedVersion}) to the dev-box marketplace?`,
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
              // Leaf slug only — the platform namespaces it under the
              // developer's publisher handle so ids match installed apps
              // (`owner-1/interactive-map`) and cannot collide across devs.
              app_id: manifest.slug,
              name: manifest.name,
              provider_class: manifest.provider_class,
              source_url: sourceUrl,
              description,
              // A remote app is installed over OAuth and contributes blocks /
              // nav items. Without these the platform had nothing to list or
              // install with, so approving a pushed app did nothing at all.
              authorize_url: manifest.authorize_url,
              token_url: manifest.token_url,
              webhook_url: manifest.webhook_url,
              version: submittedVersion,
              scopes: manifest.scopes ?? [],
              subscribed_events: manifest.subscribed_events ?? [],
              embed_blocks: manifest.embed_blocks ?? [],
              nav_items: manifest.nav_items ?? [],
            },
            // Submission is the open, throttled endpoint (no Bearer required);
            // but if a token is present it's still sent (harmless, and lets
            // the dev-box attribute the submission).
            { noAuth: true },
          );
          spinner.succeed(chalk.green(`Submitted (id #${res.id}, status: ${res.status}).`));
          // Persist only AFTER the submission is accepted, so a failed push
          // does not burn a version number or record an unused identity.
          await updateManifestFields(path.resolve(opts.dir), {
            version: submittedVersion,
            developer_name: developerName,
            developer_email: developerEmail,
          });
          if (submittedVersion !== manifest.version) {
            console.log(chalk.dim(`  Version bumped ${manifest.version} -> ${submittedVersion} in flashmandu.app.toml`));
          }
          if (res.app_id) {
            // The platform namespaces the slug under the developer's publisher
            // handle; show it so the developer knows the id merchants install
            // and storefront blocks reference.
            console.log(chalk.dim(`  Marketplace id: ${res.app_id}`));
          }
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

/**
 * Message shown when a developer passes `--target` to `push`. Hosting is a
 * property of deployment, not of a submission: `deploy` chooses it and records
 * it in the manifest as `hosting_target`, so duplicating the flag on `push`
 * would let the two disagree. Reject it with an explanation instead of
 * commander's generic "unknown option" error.
 */
export function pushTargetNotSupported(target: string): string {
  return (
    `\`push\` does not take --target (${target}). Hosting is chosen by ` +
      `\`flashmandu-app deploy\` and recorded in the manifest as hosting_target; ` +
      `\`push\` only submits the app to the marketplace for review. ` +
      `Run \`flashmandu-app deploy --target ${target}\` to set the host.`
  );
}
