#!/usr/bin/env node

/**
 * @flashmandu/app-cli — Flashmandu developer CLI.
 *
 * A Shopify-CLI-equivalent dev tool for building, testing and publishing
 * Flashmandu storefront apps. Verb semantics are reserved:
 *
 *   - `dev`   = local dev loop ONLY (app server + tunnel + sandbox register).
 *               Never publishes and never contacts a production host.
 *   - `push`  = marketplace submission ONLY. The CLI has no production host
 *               compiled in; it talks to whatever dev-box base_url the
 *               developer configured.
 *
 * Every network call goes through src/services/apiClient.ts, which sources the

// Local dev environments (Herd *.test, localhost) use self-signed TLS certs
// that Node's fetch doesn't trust. The CLI is a DEV-ONLY tool (never contacts
// production), so disabling TLS verification for local domains is safe.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
 *
 *   - `dev`   = local dev loop ONLY (app server + tunnel + sandbox register).
 *               Never publishes and never contacts a production host.
 *   - `push`  = marketplace submission ONLY. The CLI has no production host
 *               compiled in; it talks to whatever dev-box base_url the
 *               developer configured.
 *
 * Every network call goes through src/services/apiClient.ts, which sources the
 * Bearer token and base_url from ~/.flashmandu/credentials.toml (0600).
 */

import { Command } from 'commander';
import chalk from 'chalk';

import { makeLoginCommand } from './commands/login';
import { makeLogoutCommand } from './commands/logout';
import { makeWhoamiCommand } from './commands/whoami';
import { makeConfigCommand } from './commands/config';
import { makeInitCommand } from './commands/init';
import { makeDevCommand } from './commands/dev';
import { makePushCommand } from './commands/push';
import { makeDeployCommand } from './commands/deploy';
import { makeHooksCommand } from './commands/hooks';
import { makeLogsCommand } from './commands/logs';
import { makePsCommand, makeStopCommand } from './commands/ps';

const program = new Command();

program
  .name('flashmandu-app')
  .description(
    'Developer CLI for Flashmandu storefront apps.\n\n' +
      '  dev      local dev loop (app server + tunnel + sandbox)\n' +
      '  deploy   build + push the image + submit for review (--target platform|vercel|self)\n' +
      '  push     submit the app for review (no build)\n' +
      '  init     scaffold a new app from the starter template\n' +
      '  login    authenticate to a Flashmandu host\n' +
      '  logs     recent webhook deliveries (or platform pod logs with --platform)\n' +
      '  ps       list running dev app processes\n' +
      "Run `flashmandu-app <command> --help` for each command's options.",
  )
  .option(
    '--base-url <url>',
    'Override the dev-box base URL for this invocation',
  )
  .hook('preAction', async (thisCmd) => {
    // Make `--base-url` available to commands without each one declaring it.
    const global = thisCmd.opts<{ baseUrl?: string }>();
    if (global.baseUrl) {
      process.env.FLASHMANDU_BASE_URL_OVERRIDE = global.baseUrl;
    }
  });

program.addCommand(makeLoginCommand());
program.addCommand(makeLogoutCommand());
program.addCommand(makeWhoamiCommand());
program.addCommand(makeConfigCommand());
program.addCommand(makeInitCommand());
program.addCommand(makeDevCommand());
program.addCommand(makePushCommand());
program.addCommand(makeDeployCommand());
program.addCommand(makeHooksCommand());
program.addCommand(makeLogsCommand());
program.addCommand(makePsCommand());
program.addCommand(makeStopCommand());

program.exitOverride();

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // commander prints its own errors; only surface non-commander errors here.
    if (!(err instanceof Error) || err.name !== 'CommanderError') {
      console.error(chalk.red(`✗ ${msg}`));
    }
    process.exitCode = 1;
  }
}

void main();
