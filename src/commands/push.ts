import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'node:path';
import { bumpPatch, readManifest, updateManifestFields } from '../services/manifest';
import { submitAppForReview } from '../services/submissions';

/**
 * `flashmandu-app push` — submit the app to the dev-box marketplace for
 * operator review. Reserved verb: marketplace publish ONLY. It NEVER builds,
 * deploys, or touches a production host — use `deploy` for that. The submit
 * mechanics (placeholder-URL guard, identity validation, POST) live in
 * `submitAppForReview`, shared with `deploy`.
 */

export function makePushCommand(): Command {
  const cmd = new Command('push')
    .description('Submit this app to the marketplace for operator review. Does NOT build or deploy — use `deploy` for that.')
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

        // Each push is a NEW version for review; resubmitting the same one
        // leaves the operator unable to tell the builds apart. Bump the patch
        // by default, and persist it so the manifest and the marketplace agree.
        const submittedVersion =
          opts.version ?? (opts.bump === false ? manifest.version : bumpPatch(manifest.version));

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

        // Developer identity is asked for ONCE. The first push writes it into
        // the manifest, so every later version of the same app reuses it and
        // the developer never re-types it. `submitAppForReview` validates that
        // both are present; here we only resolve them for persistence below.
        const developerName = opts.developerName ?? manifest.developer_name;
        const developerEmail = opts.developerEmail ?? manifest.developer_email;

        const spinner = ora('Submitting…').start();
        try {
          const res = await submitAppForReview(manifest, {
            version: submittedVersion,
            developerName: opts.developerName,
            developerEmail: opts.developerEmail,
            sourceUrl: opts.sourceUrl,
            description: opts.description,
          });
          spinner.succeed(chalk.green(`Submitted (id #${res.id}).`));
          // Persist only AFTER the submission is accepted, so a failed push
          // does not burn a version number or record an unused identity. The
          // non-null assertions are sound: `submitAppForReview` resolves these
          // the same way and has already thrown if either was missing.
          await updateManifestFields(path.resolve(opts.dir), {
            version: submittedVersion,
            developer_name: developerName!,
            developer_email: developerEmail!,
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
