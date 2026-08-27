<?php
// Skopiuj ten plik do config.php (config.php jest w .gitignore) i uzupełnij wartości.
return [
    // Adres publicznego API bramki, bez ukośnika na końcu.
    'GATE_URL' => 'http://127.0.0.1:8080',
    // Klucz API z panelu bramki (pokazany raz przy utworzeniu).
    'API_KEY' => 'mig_live_...',
    // Sekret webhooka tego klucza (pokazany raz razem z kluczem). Pusty = webhook.php odrzuca każde żądanie (401).
    'WEBHOOK_SECRET' => '',
    // Katalog na pliki jsonl. Poza katalogiem WWW albo chroniony przez data/.htaccess.
    'DATA_DIR' => __DIR__ . '/data',
];
