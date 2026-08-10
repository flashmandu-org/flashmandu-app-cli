<?php

declare(strict_types=1);

namespace Acme\AutohisabBusinessApp;

/**
 * Verifies the AutoHisab Business platform webhook signature.
 *
 *   signature = hash_hmac('sha256', $timestamp.'.'.$body, $webhook_secret)
 *
 * Sent in:
 *   X-App-Signature, X-App-Timestamp, X-App-Delivery, X-App-Event.
 *
 * This copy is deliberately dependency-free so `php -S` works before
 * `composer install`. **Once you are on composer, delete it and use
 * `Flashmandu\AppSdk\Webhooks\Verifier` from `flashmandu/app-sdk`** — same
 * algorithm, typed result object, case-insensitive/PSR-7 header handling.
 *
 * Feed it php://input VERBATIM: re-serializing the JSON changes bytes and the
 * HMAC will not match.
 *
 * Deliveries are at-least-once. The retry ladder is 6 attempts — 1m, 5m, 30m,
 * 2h, 8h — then dead-letter. `X-App-Delivery` is per ATTEMPT: record it and
 * treat a repeat as a duplicate. Payloads carry a per-resource monotonic
 * `sequence`; drop anything below what you already applied. Respond within
 * 10s — accept with 202 and continue asynchronously if the work is slow.
 */
final class WebhookVerifier
{
    public function __construct(
        private readonly string $webhookSecret,
        private readonly int $maxSkewSeconds = 300,
    ) {}

    /**
     * @return array{ok: bool, reason?: string, event?: string, delivery_id?: string}
     */
    public function verify(string $rawBody, array $headers): array
    {
        $sig = $headers['X-App-Signature'] ?? null;
        $ts = $headers['X-App-Timestamp'] ?? null;
        $delivery = $headers['X-App-Delivery'] ?? null;
        $event = $headers['X-App-Event'] ?? null;

        if (!is_string($sig) || !is_string($ts)) {
            return ['ok' => false, 'reason' => 'missing signature or timestamp'];
        }

        $tsInt = (int) $ts;
        if ($tsInt <= 0) {
            return ['ok' => false, 'reason' => 'invalid X-App-Timestamp'];
        }

        $age = abs(time() - $tsInt);
        if ($age > $this->maxSkewSeconds) {
            return ['ok' => false, 'reason' => "timestamp skew {$age}s > {$this->maxSkewSeconds}s"];
        }

        $expected = hash_hmac('sha256', $ts.'.'.$rawBody, $this->webhookSecret);
        if (!hash_equals($expected, $sig)) {
            return ['ok' => false, 'reason' => 'signature mismatch'];
        }

        return [
            'ok' => true,
            'event' => is_string($event) ? $event : null,
            'delivery_id' => is_string($delivery) ? $delivery : null,
        ];
    }
}
