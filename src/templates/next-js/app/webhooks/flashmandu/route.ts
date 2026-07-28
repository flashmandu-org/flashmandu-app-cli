import { NextResponse } from 'next/server';
import { verifyWebhook, readWebhookHeaders } from '@/lib/hmac';
import { loadConfig } from '@/lib/config';

/**
 * Flashmandu webhook receiver.
 *
 * The host POSTs every subscribed event here with body
 *   { "event": "<hook-name>", "payload": { ... } }
 * and headers:
 *   X-App-Signature  = hex_hmac_sha256( "${timestamp}.${body}", webhook_secret )
 *   X-App-Timestamp  = unix seconds
 *   X-App-Delivery    = per-attempt UUID
 *   X-App-Event       = hook name (also in the JSON body)
 *
 * Verification MUST run over the RAW body string (Next.js gives us text()).
 * Respond 2xx to acknowledge; the host retries on non-2xx.
 */

// Disable body parsing so we can read the raw bytes for HMAC.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const headers = readWebhookHeaders(req.headers);
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    // Credentials not provisioned yet.
    return NextResponse.json(
      { error: 'not_provisioned', detail: (err as Error).message },
      { status: 503 },
    );
  }

  const result = verifyWebhook(raw, headers, cfg.webhookSecret);
  if (!result.ok) {
    return NextResponse.json(
      { error: 'invalid_signature', reason: result.reason },
      { status: 401 },
    );
  }

  let parsed: { event?: string; payload?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // --- Dispatch the event. ---------------------------------------------
  // Replace with your router / queue / domain logic.
  console.log(
    `[flashmandu] delivery=${result.deliveryId} event=${parsed.event ?? result.event}`,
  );

  return NextResponse.json({ ok: true });
}
