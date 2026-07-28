import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readManifest } from '../services/manifest';
import { startTunnel, type Tunnel, type TunnelProvider } from '../services/tunnel';
import { registerSandbox, type DevRegisterResponse } from '../services/devRegistrar';
import { getActive } from '../services/credentials';

/**
 * `flashmandu-app dev` — the local dev loop. Reserved verb: NO marketplace
 * publish, NO production host contact. Only the dev-box.
 *
 * Sequence:
 *   1. Read `flashmandu.app.toml`.
 *   2. Start the developer's app server (user-supplied command; default
 *      `npm run dev`).
 *   3. Start a public https tunnel (cloudflared quick tunnel, ngrok fallback,
 *      or bring-your-own via --tunnel-url).
 *   4. POST /api/apps/dev/register with the tunnel URL substituted into the
 *      manifest's authorize/token/webhook URLs. Receive api_token +
 *      webhook_secret ONCE.
 *   5. Write secrets to `.flashmandu/sandbox-secrets.<app>.json` (0600,
 *      gitignored) so the developer's app server can read them via
 *      FLASHMANDU_API_TOKEN / FLASHMANDU_WEBHOOK_SECRET.
 *   6. Open the app in the browser via the dev-box embed shell
 *      (/apps/{appId}/embed), which frames the app through its tunnel URL.
 *   7. Watch the tunnel URL — if it changes (provider reconnect), re-register.
 *
 * The CLI never writes secrets to disk anywhere except the per-app sandbox
 * file. It never prints the api_token to stdout.
 */

const SANDBOX_DIR = '.flashmandu';

interface SandboxSecrets {
  app_id: string;
  profile_id: number;
  api_token: string;
  webhook_secret: string;
  webhook_url: string;
  dev_box_base_url: string;
  scopes: string[];
  issued_at: string;
}

function substituteHost(url: string, host: string): string {
  // Replace the manifest's sentinel/old host with the live tunnel host.
  const parsed = new URL(url);
  const live = new URL(host);
  parsed.protocol = live.protocol;
  parsed.host = live.host;
  return parsed.toString().replace(/\/+$/, '');
}

async function writeSandboxSecrets(file: string, secrets: SandboxSecrets): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(secrets, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.chmod(file, 0o600);

  // Ensure .gitignore covers the sandbox dir.
  const gitignore = path.join(process.cwd(), '.gitignore');
  try {
    let lines: string[] = [];
    try {
      lines = (await fs.readFile(gitignore, 'utf8')).split('\n');
    } catch {
      /* create */
    }
    if (!lines.some((l) => l.trim() === SANDBOX_DIR)) {
      lines.push('', SANDBOX_DIR, '');
      await fs.writeFile(gitignore, lines.join('\n'), 'utf8');
    }
  } catch {
    /* best-effort */
  }
}

async function openBrowser(url: string): Promise<void> {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start ""'
        : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* non-fatal */
  }
}

function safeAppSlug(id: string): string {
  return id.replace(/[^a-z0-9-]/gi, '-');
}

/** True if something is already listening on the port (e.g. a stale dev server). */
async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => {
      probe.close(() => resolve(false));
    });
    probe.listen(port);
  });
}

export function makeDevCommand(): Command {
  const cmd = new Command('dev')
    .description('Run the local dev loop: app server + tunnel + dev-box registration. No publish.')
    .option('-p, --port <number>', 'Local app server port', '3000')
    .option('--app-command <cmd>', 'Command to start your app server', 'npm run dev')
    .option('--no-app-server', "Don't start the app server (you've started it separately)")
    .option('-d, --dir <path>', 'App directory (default: cwd)', '.')
    .option('--tunnel <provider>', 'Tunnel provider: cloudflared | ngrok')
    .option('--tunnel-url <url>', 'Use a pre-existing public https URL (no spawn)')
    .option('--no-open', 'Do not open the sandbox browser automatically')
    .option(
      '--sandbox-path <path>',
      'Dev-box URL path to open after registration; {appId} is substituted',
      '/apps/{appId}/embed',
    )
    .action(
      async (opts: {
        port: string;
        appCommand: string;
        appServer: boolean;
        dir: string;
        tunnel?: TunnelProvider;
        tunnelUrl?: string;
        open: boolean;
        sandboxPath: string;
      }) => {
        const appDir = path.resolve(opts.dir);
        const manifest = await readManifest(appDir);
        const port = Number.parseInt(opts.port, 10);
        if (!Number.isFinite(port) || port <= 0) {
          throw new Error(`--port must be a positive integer (got "${opts.port}")`);
        }

        let appServer: ReturnType<typeof spawn> | undefined;
        const spinner = ora();

        const cleanup = async (tunnel?: Tunnel): Promise<void> => {
          if (appServer && !appServer.killed) {
            try {
              appServer.kill('SIGTERM');
            } catch {
              /* ignore */
            }
          }
          if (tunnel) await tunnel.close();
        };

        // 2. Start app server (best-effort; user may start it themselves).
        if (opts.appServer) {
          // Preflight: a stale server on the port (e.g. an earlier `npm run
          // dev`) would spawn-then-die and the tunnel would silently point at
          // the WRONG process. Fail fast instead.
          if (await isPortInUse(port)) {
            throw new Error(
              `Port ${port} is already in use — another server is running there ` +
                `(a stale \`npm run dev\`?). Stop it first, or pass --no-app-server ` +
                `to attach to the running one, or --port <other>.`,
            );
          }

          spinner.start(`Starting app server: ${opts.appCommand}`);
          const [cmd, ...args] = opts.appCommand.split(/\s+/);
          if (!cmd) {
            spinner.fail();
            throw new Error('--app-command is empty.');
          }
          appServer = spawn(cmd, args, {
            cwd: appDir,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          appServer.on('exit', (code) => {
            if (code !== 0 && code !== null) {
              console.log(chalk.yellow(`App server exited with code ${code}.`));
            }
          });
          spinner.succeed(`App server started (port ${port}).`);
        } else {
          console.log(chalk.dim('Skipping app-server start per --no-app-server.'));
        }

        // 3. Start tunnel.
        spinner.start('Opening public tunnel…');
        let tunnel: Tunnel;
        try {
          tunnel = await startTunnel({
            port,
            provider: opts.tunnel as TunnelProvider | undefined,
            externalUrl: opts.tunnelUrl,
          });
        } catch (err) {
          spinner.fail();
          await cleanup();
          throw err;
        }
        spinner.succeed(chalk.green(`Tunnel ready: ${tunnel.url}`));

        // Re-register if the tunnel URL ever changes (provider reconnect).
        let currentHost = tunnel.url;
        tunnel.onClose(() => {
          console.log(chalk.yellow('Tunnel closed unexpectedly. Restart `flashmandu-app dev`.'));
        });

        // 4. Register sandbox with the dev-box.
        const registerOnce = async (host: string): Promise<DevRegisterResponse> => {
          return registerSandbox({
            app_id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            webhook_url: substituteHost(manifest.webhook_url, host),
            authorize_url: substituteHost(manifest.authorize_url, host),
            token_url: substituteHost(manifest.token_url, host),
            credential_delivery_url: manifest.credential_delivery_url
              ? substituteHost(manifest.credential_delivery_url, host)
              : undefined,
            scopes: manifest.scopes,
            subscribed_events: manifest.subscribed_events,
          });
        };

        const doRegister = async (): Promise<void> => {
          spinner.start('Registering sandbox with dev-box…');
          try {
            const reg = await registerOnce(currentHost);
            spinner.succeed(chalk.green('Sandbox registered.'));
            await printSecretsBanner(reg, currentHost);

            const profile = await getActive();
            const file = path.join(
              appDir,
              SANDBOX_DIR,
              `sandbox-secrets.${safeAppSlug(manifest.id)}.json`,
            );
            await writeSandboxSecrets(file, {
              app_id: manifest.id,
              profile_id: reg.profile_id,
              api_token: reg.api_token,
              webhook_secret: reg.webhook_secret,
              webhook_url: substituteHost(manifest.webhook_url, currentHost),
              dev_box_base_url: profile.base_url,
              scopes: manifest.scopes,
              issued_at: new Date().toISOString(),
            });
            console.log(chalk.dim(`  Secrets written to ${file} (0600, gitignored).`));
            console.log(
              chalk.dim(
                '  Point your app at FLASHMANDU_API_TOKEN / FLASHMANDU_WEBHOOK_SECRET (see .flashmandu/).',
              ),
            );
          } catch (err) {
            spinner.fail('Dev registration failed.');
            await cleanup(tunnel);
            throw err;
          }
        };

        await doRegister();

        // 6. Open the browser at the dev-box page for the freshly-registered
        // app. Default is the embed shell (/apps/{appId}/embed), which frames
        // the app through its tunnel URL. The app id is substituted RAW — the
        // host route matches ids containing slashes with a `.+` pattern, and
        // %2F would 404.
        if (opts.open) {
          // The dev-box base URL comes from the credential store via apiClient.
          const profile = await getActive();
          const sandboxUrl = `${profile.base_url.replace(/\/+$/, '')}${opts.sandboxPath.replace('{appId}', manifest.id)}`;
          console.log(chalk.cyan(`Opening sandbox: ${sandboxUrl}`));
          await openBrowser(sandboxUrl);
        }

        // 7. Watch for tunnel URL changes (provider-specific; best-effort).
        // cloudflared exposes a new URL on reconnect via a fresh child; the
        // current Tunnel surface doesn't emit URL-change events, so we
        // re-register only if the user restarts `app dev`. Documented.
        const profile = await getActive();
        console.log(
          chalk.dim(
            `\nDev loop running. Dev-box: ${profile.base_url}\nPress Ctrl+C to stop. Re-run if the tunnel URL changes.`,
          ),
        );

        // Keep the process alive until interrupted.
        await new Promise<void>((resolve) => {
          const stop = async (): Promise<void> => {
            console.log(chalk.dim('\nShutting down…'));
            await cleanup(tunnel);
            resolve();
          };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
      },
    );

  return cmd;
}

async function printSecretsBanner(reg: DevRegisterResponse, host: string): Promise<void> {
  console.log(chalk.green(`  app_id: ${reg.app_id}`));
  console.log(chalk.green(`  profile_id: ${reg.profile_id}`));
  console.log(chalk.green(`  webhook_url: ${host}`));
  console.log(chalk.dim('  api_token: [hidden — written to .flashmandu/]'));
  console.log(chalk.dim('  webhook_secret: [hidden — written to .flashmandu/]'));
}
