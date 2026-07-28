/**
 * Runtime config for the Flashmandu app template. Reads from process.env,
 * which `flashmandu-app dev` populates by writing
 * `.flashmandu/sandbox-secrets.<app>.json` (the developer wires that file into
 * the runtime — typically via `dotenv` or a startup hook).
 */

export interface FlashmanduConfig {
  /** Bearer token issued once by the dev-box at install/dev-register time. */
  apiToken: string;
  /** HMAC secret used to verify inbound webhook signatures. */
  webhookSecret: string;
  /** Dev-box base URL (never a production host). */
  devBoxBaseUrl: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v === '') {
    throw new Error(
      `Missing required env var ${name}. Run \`flashmandu-app dev\` and wire ` +
        `.flashmandu/sandbox-secrets.<app>.json into your runtime.`,
    );
  }
  return v;
}

export function loadConfig(): FlashmanduConfig {
  return {
    apiToken: required('FLASHMANDU_API_TOKEN'),
    webhookSecret: required('FLASHMANDU_WEBHOOK_SECRET'),
    devBoxBaseUrl: (process.env.FLASHMANDU_DEV_BOX_BASE_URL ?? '').replace(/\/+$/, ''),
  };
}
