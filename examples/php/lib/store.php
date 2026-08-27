<?php
declare(strict_types=1);

// Magazyn przykładu: pliki jsonl (jeden JSON na wiersz). Wystarcza do narzędzia
// testowego; w prawdziwej aplikacji te dane trafiłyby do bazy.

function ensureDataDir(string $dir): void
{
    if (!is_dir($dir) && !mkdir($dir, 0750, true) && !is_dir($dir)) {
        throw new RuntimeException("Nie można utworzyć katalogu $dir");
    }
}

function appendJsonl(string $dir, string $file, array $entry): void
{
    ensureDataDir($dir);
    $line = json_encode($entry, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR) . "\n";
    file_put_contents("$dir/$file", $line, FILE_APPEND | LOCK_EX);
}

/** Ostatnie $last wpisów, od najnowszego. */
function readJsonl(string $dir, string $file, int $last): array
{
    $path = "$dir/$file";
    if (!is_file($path)) {
        return [];
    }
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
    $rows = array_map(fn(string $l) => json_decode($l, true), array_slice($lines, -$last));
    return array_reverse(array_values(array_filter($rows, 'is_array')));
}

/** Nadpisuje pola wpisu o danym id. Plik jest mały - przepisujemy go w całości pod blokadą. */
function updateJsonl(string $dir, string $file, string $id, array $patch): void
{
    $path = "$dir/$file";
    if (!is_file($path)) {
        return;
    }
    $fh = fopen($path, 'c+');
    if ($fh === false) {
        throw new RuntimeException("Nie można otworzyć $path");
    }
    flock($fh, LOCK_EX);
    $lines = [];
    while (($line = fgets($fh)) !== false) {
        $line = rtrim($line, "\r\n");
        if ($line !== '') {
            $lines[] = $line;
        }
    }
    $out = array_map(function (string $line) use ($id, $patch): string {
        $row = json_decode($line, true);
        if (is_array($row) && ($row['id'] ?? null) === $id) {
            $row = $patch + $row;
            return json_encode($row, JSON_UNESCAPED_UNICODE);
        }
        return $line;
    }, $lines);
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, $out === [] ? '' : implode("\n", $out) . "\n");
    flock($fh, LOCK_UN);
    fclose($fh);
}
