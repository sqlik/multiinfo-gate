<?php
declare(strict_types=1);

// Odbiornik webhooków bramki. Poprawny podpis: wpis w webhooki.jsonl, aktualizacja stanu
// w wyslane.jsonl, odpowiedź 204. Odrzucony: wpis w odrzucone.jsonl, odpowiedź 401
// (bramka nie ponawia po 4xx - to decyzja odbiorcy).

require __DIR__ . '/lib/webhook.php';
require __DIR__ . '/lib/store.php';

$configFile = __DIR__ . '/config.php';
if (!is_file($configFile)) {
    http_response_code(500);
    exit('Brak config.php');
}
$config = require $configFile;
$dataDir = $config['DATA_DIR'];

$raw = (string) file_get_contents('php://input');
$headers = function_exists('getallheaders') ? getallheaders() : [];

try {
    $event = verifyWebhook($raw, $headers, (string) $config['WEBHOOK_SECRET']);
} catch (WebhookRejected $ex) {
    appendJsonl($dataDir, 'odrzucone.jsonl', [
        'czas' => date('c'), 'powod' => $ex->getMessage(), 'cialo' => mb_substr($raw, 0, 300),
    ]);
    http_response_code(401);
    exit;
}

appendJsonl($dataDir, 'webhooki.jsonl', [
    'czas' => date('c'),
    'zdarzenie' => (string) ($event['event'] ?? '?'),
    'id' => (string) ($event['id'] ?? '?'),
    'status' => isset($event['status']) ? (string) $event['status'] : null,
    'do' => isset($event['to']) ? (string) $event['to'] : null,
    'blad' => isset($event['error']) ? (string) $event['error'] : null,
]);

if (isset($event['id'])) {
    $patch = [];
    if (isset($event['status'])) {
        $patch['status'] = (string) $event['status'];
    }
    if (isset($event['report'])) {
        $patch['raport'] = (string) $event['report'];
    }
    if ($patch !== []) {
        updateJsonl($dataDir, 'wyslane.jsonl', (string) $event['id'], $patch);
    }
}

http_response_code(204);
