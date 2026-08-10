import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Runtime config for the Flashmandu app template.
 *
 * Resolution order: process.env first, then the newest
 * `.flashmandu/sandbox-secrets.<app>.json` written by `autohisab-business dev`.
 * Reading the file here means the app works identically whether the server
 * was started by the CLI or directly (`npm run dev`) — no dotenv wiring
 * required. In deployed installs, set the env vars yourself from whatever
 * secret store you received the install-time credentials into.
 */

export interface FlashmanduConfig {
  /** Bearer token issued once by the dev-box at install/dev-register time. */
  apiToken: string;
  /** HMAC secret used to verify inbound webhook signatures. */
  webhookSecret: string;
  /** Dev-box base URL (never a production host). */
  devBoxBaseUrl: string;
}

/** Map env var names to their key in the sandbox-secrets JSON file. */
const SANDBOX_KEY: Record<string, string> = {
  FLASHMANDU_API_TOKEN: 'api_token',
  FLASHMANDU_WEBHOOK_SECRET: 'webhook_secret',
  FLASHMANDU_DEV_BOX_BASE_URL: 'dev_box_base_url',
};

function fromSandboxSecrets(name: string): string | undefined {
  try {
    const dir = path.join(process.cwd(), '.flashmandu');
    const file = readdirSync(dir)
      .filter((f) => /^sandbox-secrets\..+\.json$/.test(f))
      .sort()
      .pop();
    if (!file) {
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Record<
      string,
      unknown
    >;
    const value = parsed[SANDBOX_KEY[name] ?? ''];
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

function required(name: string): string {
  const v = process.env[name] || fromSandboxSecrets(name);
  if (!v) {
    throw new Error(
      `Missing ${name}. Run \`autohisab-business dev\` — it registers your app on the ` +
        `dev-box and writes .flashmandu/sandbox-secrets.<app>.json, which this loader reads.`,
    );
  }
  return v;
}

export function loadConfig(): FlashmanduConfig {
  return {
    apiToken: required('FLASHMANDU_API_TOKEN'),
    webhookSecret: required('FLASHMANDU_WEBHOOK_SECRET'),
    devBoxBaseUrl: (
      process.env.FLASHMANDU_DEV_BOX_BASE_URL ??
      fromSandboxSecrets('FLASHMANDU_DEV_BOX_BASE_URL') ??
      ''
    ).replace(/\/+$/, ''),
  };
}
