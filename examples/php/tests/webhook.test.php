<?php
declare(strict_types=1);

// Uruchomienie: php tests/webhook.test.php (z katalogu examples/php). Kod wyjścia 0 = wszystko dobrze.
require __DIR__ . '/../lib/webhook.php';

$secret = 'sekret-testowy';
$body = '{"event":"message.delivered","at":"2026-08-26T10:00:00.000Z","id":"msg_1","status":"delivered"}';
$now = 1_756_200_000;
$sign = fn(int $ts, string $b): string => 'sha256=' . hash_hmac('sha256', "$ts.$b", $secret);

$fails = 0;
function check(string $name, bool $ok): void
{
    global $fails;
    echo ($ok ? 'OK   ' : 'BLAD ') . $name . "\n";
    if (!$ok) {
        $fails++;
    }
}

$good = verifyWebhook($body, ['X-MIG-Timestamp' => (string) $now, 'X-MIG-Signature' => $sign($now, $body)], $secret, $now);
check('poprawny podpis', $good['id'] === 'msg_1');

$lower = verifyWebhook($body, ['x-mig-timestamp' => (string) $now, 'x-mig-signature' => $sign($now, $body)], $secret, $now);
check('naglowki malymi literami', $lower['event'] === 'message.delivered');

try {
    verifyWebhook($body, ['X-MIG-Timestamp' => (string) $now, 'X-MIG-Signature' => 'sha256=00'], $secret, $now);
    check('zly podpis', false);
} catch (WebhookRejected) {
    check('zly podpis', true);
}

try {
    $old = $now - 301;
    verifyWebhook($body, ['X-MIG-Timestamp' => (string) $old, 'X-MIG-Signature' => $sign($old, $body)], $secret, $now);
    check('znacznik czasu poza tolerancja', false);
} catch (WebhookRejected $ex) {
    check('znacznik czasu poza tolerancja', str_contains($ex->getMessage(), 'tolerancj'));
}

try {
    verifyWebhook($body, [], $secret, $now);
    check('brak naglowka', false);
} catch (WebhookRejected) {
    check('brak naglowka', true);
}

try {
    verifyWebhook($body, ['X-MIG-Timestamp' => (string) $now, 'X-MIG-Signature' => 'sha256=' . hash_hmac('sha256', "$now.$body", '')], '', $now);
    check('pusty sekret odrzuca nawet pasujacy podpis', false);
} catch (WebhookRejected $ex) {
    check('pusty sekret odrzuca nawet pasujacy podpis', str_contains($ex->getMessage(), 'sekret'));
}

exit($fails === 0 ? 0 : 1);
