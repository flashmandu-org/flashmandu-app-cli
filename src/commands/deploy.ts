import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bumpPatch, readManifest, updateManifestFields } from '../services/manifest';
import { deriveUrls, type HostingTarget } from '../services/hosting';
import { probeUrl } from '../services/verify';
import { ensureDocker } from '../services/dockerRuntime';
import { fetchCapabilities } from '../services/platformCapabilities';
import { submitAppForReview } from '../services/submissions';
import { printAppConfigSync } from '../services/appSync';
import { publisherHandleFromEmail } from '../services/appIdentity';
import {
  applyPushLine,
  createPushState,
  DockerRunError,
  formatBytes,
  parseBuildLine,
  pushSummary,
  runStreaming,
  tail,
} from '../services/dockerProgress';

/**
 * `autohisab-business deploy` — record a real production host on the manifest.
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
    .option('--platform-host <host>', 'AutoHisab Business platform hostname (platform target; defaults to the logged-in profile)')
    .action(async (opts: {
      dir: string;
      target?: HostingTarget;
      baseUrl?: string;
      registry?: string;
      platformHost?: string;
    }, cmd: Command) => {
      const dir = path.resolve(opts.dir);
      const manifest = await readManifest(dir);

      // Declarative `[webhooks]` + `[[schedules]]` ride along with whatever
      // this deploy submits. A `[webhooks].url` declared in the toml outranks
      // the URL derived from the hosting target — say so rather than silently
      // deploying to one host and delivering webhooks to another.
      printAppConfigSync(manifest);
      if (manifest.webhooks?.url) {
        console.log(
          chalk.dim(
            `  Note: [webhooks].url is declared, so webhooks go to ${manifest.webhooks.url} ` +
              'regardless of the hosting target. Remove it to follow the deployed host.',
          ),
        );
      }

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
            { value: 'platform', name: 'AutoHisab Business platform — build, push and run on its cluster' },
          ],
        });
      }

      let baseUrl = opts.baseUrl ?? merged.baseUrl;

      if (target === 'platform') {
        const { getActive } = await import('../services/credentials');
        try { await getActive(); } catch {
          throw new Error('Log in first (`autohisab-business login`).');
        }

        const caps = await fetchCapabilities();
        if (!caps.platform_hosting || !caps.tenant_registry) {
          throw new Error(
            'This platform cannot host platform apps (production only). Run `autohisab-business dev` for local development.',
          );
        }
        const registry = caps.tenant_registry;
        const registryUser = caps.registry_push_user;
        const registryPassword = caps.registry_push_password;
        if (!registryUser || !registryPassword) {
          throw new Error('The platform did not advertise a registry push credential.');
        }

        // 1. Ensure Docker is available (installs OrbStack/etc. if missing).
        ensureDocker();

        const handle = publisherHandleFromEmail(manifest.developer_email);
        const repo = `${registry}/${handle}/${manifest.slug}`;

        const isTTY = Boolean(process.stdout.isTTY);
        const spinner = ora(`Building ${repo}…`);
        if (isTTY) spinner.start();
        else console.log(chalk.dim(`Building ${repo}…`));
        try {
          execFileSync('docker', ['login', '-u', registryUser, '--password-stdin', registry], {
            cwd: dir,
            stdio: ['pipe', 'pipe', 'pipe'],
            input: registryPassword,
          });
          // Build for linux/amd64 — the tenant cluster runs on x86_64. Building
          // on Apple Silicon without --platform produces an arm64-only image that
          // k3s cannot run ("no match for platform in manifest"). --progress=plain
          // gives parseable `#<n> <stage>` lines for the live spinner text.
          const buildStart = Date.now();
          const elapsed = (): string => `${Math.round((Date.now() - buildStart) / 1000)}s`;
          await runStreaming(
            ['build', '--progress=plain', '--platform', 'linux/amd64', '-t', repo, '.'],
            { cwd: dir },
            (line) => {
              if (!isTTY) {
                process.stdout.write(`${line}\n`);
                return;
              }
              const step = parseBuildLine(line);
              if (step) spinner.text = `Building ${repo} — ${step} (${elapsed()})`;
            },
          );

          const size = Number(
            execFileSync('docker', ['image', 'inspect', repo, '--format={{.Size}}'], {
              cwd: dir,
              encoding: 'utf8',
            }).trim(),
          );
          const builtMsg = `Built ${repo} (${formatBytes(size)}) in ${elapsed()}`;
          if (isTTY) spinner.succeed(builtMsg);
          else console.log(builtMsg);

          const pushStart = Date.now();
          const pushState = createPushState();
          if (isTTY) spinner.start(`Pushing ${repo}…`);
          else console.log(chalk.dim(`Pushing ${repo}…`));
          await runStreaming(['push', repo], { cwd: dir }, (line) => {
            if (!isTTY) {
              process.stdout.write(`${line}\n`);
              return;
            }
            if (applyPushLine(pushState, line)) {
              const s = pushSummary(pushState);
              const secs = Math.round((Date.now() - pushStart) / 1000);
              spinner.text =
                s.total > 0
                  ? `Pushing ${repo}… ${formatBytes(s.current)}/${formatBytes(s.total)} (${s.percent}%, ${secs}s)`
                  : `Pushing ${repo}… ${formatBytes(s.current)} (${secs}s)`;
            }
          });
        } catch (err) {
          if (isTTY) spinner.fail('Docker build/push failed.');
          else console.error(chalk.red('✗ Docker build/push failed.'));
          const output =
            err instanceof DockerRunError ? tail(err.output) : (err as Error).message;
          throw new Error(`Could not build or push ${repo}.\n${output}`);
        }

        const digestRef = execFileSync('docker', ['inspect', '--format={{index .RepoDigests 0}}', repo], {
          cwd: dir, encoding: 'utf8',
        }).trim();
        const digest = digestRef.split('@')[1] ?? '';
        if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
          spinner.fail('Could not resolve an image digest.');
          throw new Error(`docker inspect returned "${digestRef}" — expected <repo>@sha256:<64 hex>.`);
        }
        spinner.succeed(`Pushed ${digestRef}`);

        const version = bumpPatch(manifest.version);
        const platformHost = opts.platformHost ?? (await platformHostFromProfile());
        const urls = deriveUrls('', { target: 'platform', slug: manifest.slug, platformHost });

        // 2. Submit the versioned app for review — deploy does everything.
        // Spread the derived real URLs over the in-memory manifest so the
        // helper's placeholder-URL check sees the just-persisted platform URLs
        // (the manifest read at the top still carries the originals, which for
        // a first deploy of a fresh template are APP-HOST placeholders).
        await submitAppForReview({ ...manifest, ...urls, hosting_target: 'platform', image_digest: digest }, { version });

        // Persist the version + digest only after the submission succeeds, so a
        // failed submit does not burn a version number (mirrors `push`).
        await updateManifestFields(dir, { ...urls, hosting_target: 'platform', image_digest: digest, version });

        console.log(chalk.green(`\n  Built, pushed and submitted ${handle}/${manifest.slug} v${version}:`));
        console.log(chalk.dim(`    image_digest = ${digest}`));
        console.log(chalk.dim(`    version      = ${version}`));
        console.log(chalk.dim('\n  Next: an operator reviews and approves the submission.'));
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
      console.log(chalk.dim('\n  Next: autohisab-business push'));
    });
}

/** The platform hostname defaults to the AutoHisab Business host the CLI is logged into. */
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
    'Could not determine the platform host. Log in (`autohisab-business login`) or pass --platform-host.',
  );
}

