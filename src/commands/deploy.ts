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
    .option('-t, --target <target>', 'Hosting target: vercel | self | platform')
    .option('--base-url <url>', 'Base URL (required for --target self)')
    .option('--registry <registry>', 'Tenant image registry (platform target; env FLASHMANDU_TENANT_REGISTRY)')
    .option('--platform-host <host>', 'Flashmandu platform hostname (platform target; defaults to the logged-in profile)')
    .action(async (opts: {
      dir: string;
      target?: HostingTarget;
      baseUrl?: string;
      registry?: string;
      platformHost?: string;
    }, cmd: Command) => {
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
            { value: 'platform', name: 'Flashmandu platform — build, push and run on their cluster' },
          ],
        });
      }

      let baseUrl = opts.baseUrl ?? merged.baseUrl;

      if (target === 'platform') {
        const registry = opts.registry
          ?? process.env.FLASHMANDU_TENANT_REGISTRY
          ?? '10.10.0.2:5000';
        const platformHost = opts.platformHost ?? (await platformHostFromProfile());

        // The platform namespaces the slug under the publisher handle derived
        // from the developer identity; mirror that derivation so the image
        // path matches the app id the platform will run.
        const handle = publisherHandleFromEmail(manifest.developer_email);
        const repo = `${registry}/${handle}/${manifest.slug}`;

        const spinner = ora(`Building ${repo}…`).start();
        try {
          execFileSync('docker', ['build', '-t', repo, '.'], { cwd: dir, stdio: 'pipe' });
          execFileSync('docker', ['push', repo], { cwd: dir, stdio: 'pipe' });
        } catch (err) {
          spinner.fail('Docker build/push failed.');
          throw new Error(
            `Could not build or push ${repo}. Is Docker running and can it reach ${registry}?\n` +
              (err as Error).message,
          );
        }

        // Resolve the digest from the pushed image — a tag can be repointed
        // after review; the digest is the exact thing the operator approves
        // and the exact thing the cluster runs.
        const digestRef = execFileSync(
          'docker',
          ['inspect', '--format={{index .RepoDigests 0}}', repo],
          { cwd: dir, encoding: 'utf8' },
        ).trim();
        const digest = digestRef.split('@')[1] ?? '';
        if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
          spinner.fail('Could not resolve an image digest.');
          throw new Error(`docker inspect returned "${digestRef}" — expected <repo>@sha256:<64 hex>.`);
        }
        spinner.succeed(`Pushed ${digestRef}`);

        // Platform URLs are derived on the platform's own hostname scheme,
        // not probed against a developer host.
        const urls = deriveUrls('', { target: 'platform', slug: manifest.slug, platformHost });

        await updateManifestFields(dir, {
          ...urls,
          hosting_target: 'platform',
          image_digest: digest,
        });

        console.log(chalk.green(`\n  Recorded platform deployment for ${handle}/${manifest.slug} in flashmandu.app.toml:`));
        console.log(chalk.dim(`    image_digest = ${digest}`));
        for (const [field, url] of Object.entries(urls)) {
          console.log(chalk.dim(`    ${field} = ${url}`));
        }
        console.log(chalk.dim('\n  Next: flashmandu-app push'));
        return;
      }

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

/** The platform hostname defaults to the Flashmandu host the CLI is logged into. */
async function platformHostFromProfile(): Promise<string> {
  const override = process.env.FLASHMANDU_BASE_URL_OVERRIDE;
  if (override) return override;

  try {
    const { getActive } = await import('../services/credentials');
    const profile = await getActive();
    if (profile?.base_url) return profile.base_url;
  } catch {
    // Fall through to the explicit error below.
  }

  throw new Error(
    'Could not determine the platform host. Log in (`flashmandu-app login`) or pass --platform-host.',
  );
}

/**
 * Mirror of the platform's publisher-handle derivation (AppManager::publisherHandle
 * with no username): email local-part, lowercased, non-alphanumerics to dashes.
 * The image path must match the `<handle>/<slug>` app id the platform runs.
 */
function publisherHandleFromEmail(email: string | undefined): string {
  const raw = (email ?? '').split('@')[0] ?? '';
  const handle = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

  if (!handle) {
    throw new Error(
      'Cannot derive a publisher handle — set developer_email in flashmandu.app.toml first.',
    );
  }

  return handle;
}
