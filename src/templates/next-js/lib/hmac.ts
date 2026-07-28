import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies the Flashmandu platform webhook signature.
 *
 * The host signs every delivery with:
 *
 *   signature = hash_hmac('sha256', $timestamp.'.'.$body, $webhook_secret)
 *
 * and sends the result in `X-App-Signature`, alongside:
 *   - X-App-Timestamp  (unix seconds)
 *   - X-App-Delivery   (per-attempt UUID for replay protection)
 *   - X-App-Event      (the hook name, e.g. order.status.changed)
 *
 * Verification:
 *   1. Recompute HMAC over `${timestamp}.${rawBody}` with the shared secret.
 *   2. Constant-time compare against X-App-Signature.
 *   3. Reject if the timestamp is more than `maxSkewSeconds` old (replay
 *      defence). Default 5 minutes.
 *   4. Track X-App-Delivery to reject replays within the skew window.
 */

export interface WebhookHeaders {
  signature: string | null;
  timestamp: string | null;
  delivery: string | null;
  event: string | null;
}

export function readWebhookHeaders(h: Headers): WebhookHeaders {
  return {
    signature: h.get('x-app-signature'),
    timestamp: h.get('x-app-timestamp'),
    delivery: h.get('x-app-delivery'),
    event: h.get('x-app-event'),
  };
}

function safeEqualHex(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'hex');
  const bBuf = Buffer.from(b, 'hex');
  if (aBuf.length !== bBuf.length || aBuf.length === 0) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export interface VerifyOptions {
  /** Max age of the X-App-Timestamp before the delivery is rejected (seconds). */
  maxSkewSeconds?: number;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  event?: string;
  deliveryId?: string;
}

/** Verify the HMAC + timestamp over the RAW body bytes. */
export function verifyWebhook(
  rawBody: string,
  headers: WebhookHeaders,
  webhookSecret: string,
  opts: VerifyOptions = {},
): VerifyResult {
  const maxSkew = opts.maxSkewSeconds ?? 300;

  if (!headers.signature || !headers.timestamp) {
    return { ok: false, reason: 'missing signature or timestamp header' };
  }

  const ts = Number.parseInt(headers.timestamp, 10);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'invalid X-App-Timestamp' };
  }
  const ageSeconds = Math.abs(Date.now() / 1000 - ts);
  if (ageSeconds > maxSkew) {
    return { ok: false, reason: `timestamp skew ${ageSeconds}s > ${maxSkew}s` };
  }

  const expected = createHmac('sha256', webhookSecret)
    .update(`${headers.timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  if (!safeEqualHex(expected, headers.signature)) {
    return { ok: false, reason: 'signature mismatch' };
  }

  return {
    ok: true,
    event: headers.event ?? undefined,
    deliveryId: headers.delivery ?? undefined,
  };
}
