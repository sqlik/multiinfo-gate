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

$received = ['event' => 'message.received', 'at' => '2026-08-29T07:14:02.000Z', 'id' => 'in_1', 'serviceId' => '24138',
    'from' => '48601000001', 'to' => '7968', 'kind' => 'text', 'text' => 'Dziekuje', 'receivedAt' => '2026-08-29T07:14:00.000Z',
    'relatedMessageId' => 'msg_1'];
$entry = inboundEntry($received);
check('wpis odebranej: identyfikator i nadawca', $entry['id'] === 'in_1' && $entry['od'] === '48601000001');
check('wpis odebranej: tresc i powiazanie', $entry['tresc'] === 'Dziekuje' && $entry['odpowiedz_na'] === 'msg_1');
check('wpis odebranej: usluga, numer i czas odbioru', $entry['usluga'] === '24138' && $entry['na'] === '7968' && $entry['odebrana'] === '2026-08-29T07:14:00.000Z');
$binary = inboundEntry(['event' => 'message.received', 'id' => 'in_2', 'from' => '48601000001', 'kind' => 'binary', 'hex' => '0605 48']);
check('wpis odebranej binarnej', $binary['tresc'] === '[binarna] 0605 48' && $binary['odpowiedz_na'] === null);

exit($fails === 0 ? 0 : 1);
