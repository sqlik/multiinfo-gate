<?php
declare(strict_types=1);

// Weryfikacja podpisu webhooka bramki. Podpis to HMAC-SHA256 z sekretu klucza po
// "<X-MIG-Timestamp>.<surowe body>". Body bierzemy przed parsowaniem JSON - każda
// zmiana bajtów (nawet spacji) unieważnia podpis.

final class WebhookRejected extends RuntimeException
{
}

/** Tolerancja znacznika czasu w sekundach - chroni przed odtworzeniem starego żądania. */
const WEBHOOK_TOLERANCE_S = 300;

/**
 * Zwraca zdekodowane zdarzenie albo rzuca WebhookRejected z powodem.
 * $headers: getallheaders() albo dowolna tablica nagłówek => wartość (wielkość liter bez znaczenia).
 * $now: bieżący czas uniksowy; podawany w testach, w produkcji zostaw null.
 */
function verifyWebhook(string $rawBody, array $headers, string $secret, ?int $now = null): array
{
    // Pusty sekret to brak konfiguracji, nie „podpis pustym kluczem”: HMAC z pustym kluczem
    // policzy każdy, kto zna treść, więc takie żądanie odrzucamy przed sprawdzaniem podpisu.
    if ($secret === '') {
        throw new WebhookRejected('brak sekretu webhooka w config.php');
    }
    $h = array_change_key_case($headers, CASE_LOWER);
    $signature = $h['x-mig-signature'] ?? null;
    $timestamp = $h['x-mig-timestamp'] ?? null;
    if ($signature === null || $timestamp === null) {
        throw new WebhookRejected('brak nagłówka X-MIG-Signature albo X-MIG-Timestamp');
    }
    if (!ctype_digit((string) $timestamp)) {
        throw new WebhookRejected('X-MIG-Timestamp nie jest liczbą');
    }
    if (abs(($now ?? time()) - (int) $timestamp) > WEBHOOK_TOLERANCE_S) {
        throw new WebhookRejected('znacznik czasu poza tolerancją ' . WEBHOOK_TOLERANCE_S . ' s');
    }

    $expected = 'sha256=' . hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
    // hash_equals porównuje w stałym czasie - zwykłe === zdradzałoby po czasie, ile bajtów się zgadza.
    if (!hash_equals($expected, (string) $signature)) {
        throw new WebhookRejected('podpis nie pasuje');
    }

    $decoded = json_decode($rawBody, true);
    if (!is_array($decoded)) {
        throw new WebhookRejected('body nie jest poprawnym JSON-em');
    }
    return $decoded;
}
