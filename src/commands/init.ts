import { Command } from 'commander';
import chalk from 'chalk';
import { select, input, confirm } from '@inquirer/prompts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { serializeManifest, APP_SLUG_RE, type AppManifest } from '../services/manifest';

/**
 * `flashmandu-app init` — scaffold a new app from one of the bundled
 * templates into the current (or target) directory. Copies the template
 * verbatim, then renders a `flashmandu.app.toml` from the developer's
 * answers.
 *
 * Templates live under `src/templates/<name>/` and ship in the npm package
 * (see `files` in package.json). They are framework-specific starters that
 * already wire the OAuth + webhook contracts.
 */

type TemplateName = 'next-js' | 'php-native';

const TEMPLATES: Record<TemplateName, { label: string; description: string }> = {
  'next-js': {
    label: 'Next.js (TypeScript)',
    description: 'App-router Next.js app with OAuth + HMAC webhook verifier.',
  },
  'php-native': {
    label: 'PHP (composer package)',
    description: 'Composer package skeleton requiring flashmandu/app-sdk.',
  },
};

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else {
      await fs.copyFile(s, d);
    }
  }
}

export function makeInitCommand(): Command {
  const cmd = new Command('init')
    .description('Scaffold a new Flashmandu app from a template.')
    .argument('[dir]', 'Target directory (default: current directory)', '.')
    .option('--template <name>', 'Template: next-js | php-native')
    .option('--app-slug <slug>', 'App slug (lowercase alphanumeric + dashes)')
    .option('--app-id <id>', 'Alias of --app-slug for back-compat (leaf after any "/" is used)')
    .option('--name <name>', 'Display name')
    .option('--base-url <url>', 'Dev-box base URL for the manifest OAuth paths')
    .action(async (dir: string, opts: Partial<Record<string, string>>) => {
      const template = (opts.template ?? (await select({
        message: 'Choose a template',
        choices: (Object.keys(TEMPLATES) as TemplateName[]).map((k) => ({
          name: `${TEMPLATES[k]!.label} — ${TEMPLATES[k]!.description}`,
          value: k,
        })),
      }))) as TemplateName;

      if (!TEMPLATES[template]) {
        throw new Error(`Unknown template "${template}". Available: ${Object.keys(TEMPLATES).join(', ')}`);
      }

      // Author a clean `slug` leaf (e.g. "my-app"), NOT a namespaced id. The
      // host derives the canonical `<publisher>/<slug>` identity. --app-id is
      // accepted for back-compat; its leaf after any "/" is used as the slug.
      const rawSlug = opts.appSlug ?? opts.appId;
      const normalizeSlug = (v: string): string =>
        v.includes('/') ? (v.split('/').pop() ?? v) : v;
      const appSlug =
        rawSlug
          ? normalizeSlug(rawSlug)
          : await input({
              message: 'App slug (lowercase alphanumeric + dashes, e.g. my-app):',
              validate: (v) => (APP_SLUG_RE.test(v)
                ? true
                : 'Use lowercase alphanumeric + dashes (1-96 chars). No namespace prefix.'),
            });
      if (!APP_SLUG_RE.test(appSlug)) {
        throw new Error(
          `Invalid app slug "${appSlug}". Use lowercase alphanumeric + dashes (1-96 chars).`,
        );
      }

      const appName =
        opts.name ??
        (await input({
          message: 'Display name:',
          default: appSlug,
        }));

      const target = path.resolve(dir);
      await fs.mkdir(target, { recursive: true });

      const nonManifest = (await fs.readdir(target)).filter((f) => f !== '.git');
      if (nonManifest.length > 0) {
        const ok = await confirm({
          message: `Target "${target}" is not empty. Continue and overwrite?`,
          default: false,
        });
        if (!ok) {
          console.log(chalk.dim('Aborted.'));
          return;
        }
      }

      // Resolve the bundled template directory. Candidate paths cover:
      //   - installed package layout:  <pkg>/templates/<name>  (built copy)
      //   - installed package layout:  <pkg>/src/templates/<name> (shipped src)
      //   - dev repo layout:            <cwd>/src/templates/<name>
      // __dirname at runtime is <pkg>/dist/commands, so ../.. reaches <pkg>.
      const candidates = [
        path.join(__dirname, '..', '..', 'templates', template),
        path.join(__dirname, '..', '..', 'src', 'templates', template),
        path.join(process.cwd(), 'src', 'templates', template),
      ];
      let templateSrc: string | undefined;
      for (const c of candidates) {
        try {
          const stat = await fs.stat(c);
          if (stat.isDirectory()) {
            templateSrc = c;
            break;
          }
        } catch {
          /* try next */
        }
      }
      if (!templateSrc) {
        throw new Error(
          `Template files not found. Looked in:\n  ${candidates.join('\n  ')}\n`,
        );
      }
      await copyDir(templateSrc, target);

      // Render manifest. The OAuth/webhook URLs are written with a sentinel
      // base so the developer can grep-and-replace; `app dev` overrides them
      // at runtime with the live tunnel URL.
      const manifest: AppManifest = {
        slug: appSlug,
        name: appName,
        version: '0.1.0',
        authorize_url: 'https://APP-HOST/oauth/authorize',
        token_url: 'https://APP-HOST/oauth/token',
        webhook_url: 'https://APP-HOST/webhooks/flashmandu',
        scopes: [],
        subscribed_events: [],
        developer_name: undefined,
        developer_email: undefined,
        source_url: undefined,
        provider_class: undefined,
      };
      await fs.writeFile(
        path.join(target, 'flashmandu.app.toml'),
        serializeManifest(manifest),
        'utf8',
      );

      console.log(chalk.green(`✓ Scaffolded "${template}" app in ${target}`));
      console.log(chalk.dim('  Next: edit flashmandu.app.toml, then `flashmandu-app dev`.'));
    });

  return cmd;
}
