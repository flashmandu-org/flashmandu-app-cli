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
import { listSecretKeys, setSecret, unsetSecret } from '../services/apiClient';
import { readManifest, MANIFEST_FILENAME } from '../services/manifest';
import { resolveAppId } from '../services/appIdentity';

/**
 * `autohisab-business config` — two things, disambiguated by where you run it:
 *
 * 1. CLI configuration — `config set base_url <url>` points the CLI at a
 *    dev-box host. There is intentionally no base_url compiled in.
 * 2. Hosted-app secrets (capability spec §8.1) — `config set KEY=value`,
 *    `config list`, `config unset KEY` inside an app directory. Values are
 *    encrypted at rest on the host and injected as env vars into the tenant
 *    container on deploy.
 *
 * Secrets are WRITE-ONLY: the platform ships no read-back endpoint, so
 * `config list` can only ever show KEY NAMES. That is deliberate — this is
 * where FB app secrets and API keys live, explicitly NOT in `settings_schema`
 * (settings are host-readable and surfaced in the admin UI).
 *
 * Self-hosted apps get guidance instead of a silent no-op: their environment
 * is their own to manage.
 */

/** Env-var shaped: UPPER_SNAKE, not starting with a digit. */
export const SECRET_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Split `KEY=value` into its parts. Only the FIRST `=` separates, so values
 * may contain `=` (base64, connection strings).
 */
export function parseSecretAssignment(input: string): { key: string; value: string } | null {
  const idx = input.indexOf('=');
  if (idx <= 0) return null;
  return { key: input.slice(0, idx).trim(), value: input.slice(idx + 1) };
}

/** Guidance printed for apps that are not platform-hosted. */
export function selfHostedSecretsGuidance(target: string | undefined): string {
  return (
    `This app's hosting_target is "${target ?? 'unset'}", so the platform does not run its container ` +
    'and has nowhere to inject secrets. Your environment is your own:\n' +
    '  • Vercel   — `vercel env add KEY production`\n' +
    '  • Your own server — your process manager / .env / secret store\n' +
    'Hosted secrets apply only to `deploy --target platform` apps.'
  );
}

/** True when `dir` holds a manifest file, regardless of whether it parses. */
async function hasManifest(dir: string): Promise<boolean> {
  return fs
    .access(path.join(dir, MANIFEST_FILENAME))
    .then(() => true)
    .catch(() => false);
}

async function requireHostedApp(dir: string): Promise<{ appId: string }> {
  if (!(await hasManifest(dir))) {
    throw new Error(
      `No ${MANIFEST_FILENAME} in ${dir}. Run hosted-secret commands from your app directory.`,
    );
  }

  // Deliberately NOT wrapped: a manifest that exists but does not parse must
  // surface its own validation report, not be flattened into "no manifest".
  const manifest = await readManifest(dir);

  if (manifest.hosting_target !== 'platform') {
    throw new Error(selfHostedSecretsGuidance(manifest.hosting_target));
  }

  return { appId: await resolveAppId(dir, manifest) };
}

export function makeConfigCommand(): Command {
  const cmd = new Command('config').description(
    'CLI configuration (base_url, profiles) and hosted-app secrets (KEY=value, write-only).',
  );

  cmd
    .command('set <assignment> [value]')
    .description(
      'Set a value. `base_url <url>` configures the CLI; `KEY=value` sets a hosted-app secret (write-only).',
    )
    .option('-d, --dir <path>', 'App directory (for secrets)', '.')
    .action(async (assignment: string, value: string | undefined, opts: { dir: string }) => {
      // CLI config keeps both spellings: `set base_url <url>` and `set base_url=<url>`.
      const pair = parseSecretAssignment(assignment);
      const key = pair ? pair.key : assignment;

      if (key === 'base_url') {
        await setBaseUrl(pair ? pair.value : value);
        return;
      }

      if (!pair) {
        throw new Error(
          `Expected KEY=value (got "${assignment}"). Hosted-app secrets are set as ` +
            '`autohisab-business config set STRIPE_KEY=sk_live_…`; the only CLI setting is `base_url`.',
        );
      }
      if (value !== undefined) {
        throw new Error(
          'Pass the secret as a single KEY=value argument — a separate value argument would ' +
            'end up in your shell history split across words.',
        );
      }
      if (!SECRET_KEY_RE.test(pair.key)) {
        throw new Error(
          `Secret key "${pair.key}" must be UPPER_SNAKE_CASE (it becomes an env var in your container).`,
        );
      }
      if (pair.value === '') {
        throw new Error(
          `Refusing to store an empty value for ${pair.key}. Use \`config unset ${pair.key}\` to remove it.`,
        );
      }

      const dir = path.resolve(opts.dir);
      const { appId } = await requireHostedApp(dir);
      await setSecret(appId, pair.key, pair.value);
      console.log(chalk.green(`✓ ${pair.key} stored for ${appId}.`));
      console.log(
        chalk.dim(
          '  Encrypted at rest; injected as an env var on the next deploy. Write-only — ' +
            'the platform never reads it back, so keep your own copy.',
        ),
      );
    });

  cmd
    .command('get <key>')
    .description('Print a CLI config value. Secrets are write-only and cannot be read back.')
    .action(async (key: string) => {
      if (key === 'base_url') {
        const entry = await getActive();
        console.log(entry.base_url);
        return;
      }
      throw new Error(
        `"${key}" is not a CLI setting. If you meant a hosted-app secret: secrets are WRITE-ONLY — ` +
          'the platform exposes key names (`config list`) but never values, by design.',
      );
    });

  cmd
    .command('list')
    .description(
      'Inside an app directory: hosted secret KEY NAMES (never values). Elsewhere: CLI profiles.',
    )
    .option('-d, --dir <path>', 'App directory', '.')
    .option('--profiles', 'List CLI profiles instead of hosted secrets')
    .action(async (opts: { dir: string; profiles?: boolean }) => {
      const dir = path.resolve(opts.dir);
      const inAppDir = !opts.profiles && (await hasManifest(dir));

      if (!inAppDir) {
        const { active, names } = await listProfiles();
        if (names.length === 0) {
          console.log(chalk.yellow('No profiles. Run `autohisab-business login`.'));
          return;
        }
        for (const name of names) {
          const marker = name === active ? chalk.green('* ') : '  ';
          console.log(`${marker}${name}`);
        }
        return;
      }

      const { appId } = await requireHostedApp(dir);
      const { keys } = await listSecretKeys(appId);
      if (!keys || keys.length === 0) {
        console.log(chalk.yellow(`No secrets set for ${appId}.`));
        return;
      }
      console.log(chalk.dim(`Secrets for ${appId} (names only — values are never readable):`));
      for (const key of [...keys].sort()) {
        console.log(`  ${key}`);
      }
    });

  cmd
    .command('unset <key>')
    .description('Delete a hosted-app secret.')
    .option('-d, --dir <path>', 'App directory', '.')
    .action(async (key: string, opts: { dir: string }) => {
      if (!SECRET_KEY_RE.test(key)) {
        throw new Error(`Secret key "${key}" must be UPPER_SNAKE_CASE.`);
      }
      const { appId } = await requireHostedApp(path.resolve(opts.dir));
      await unsetSecret(appId, key);
      console.log(chalk.green(`✓ ${key} removed from ${appId}.`));
      console.log(chalk.dim('  Takes effect on the next deploy.'));
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

async function setBaseUrl(value: string | undefined): Promise<void> {
  if (!value) {
    throw new Error(
      'Usage: autohisab-business config set base_url <https://your-dev-box>',
    );
  }
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(
      `base_url must include the scheme, e.g. https://dev.autohisab.example (got "${value}")`,
    );
  }
  const normalized = value.replace(/\/+$/, '');
  const active = await getActiveName();
  if (!active) {
    throw new Error(
      'No active profile. Run `autohisab-business login` first; base_url is stored per profile.',
    );
  }
  const entry = await getActive();
  await setProfile(active, { ...entry, base_url: normalized });
  console.log(chalk.green(`✓ Platform base_url for profile "${active}" set to ${normalized}`));
  console.log(
    chalk.dim(
      '  This is the AutoHisab Business host the CLI talks to — your app’s public URL comes from the `dev` tunnel, not this setting.',
    ),
  );
}
