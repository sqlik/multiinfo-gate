<?php
declare(strict_types=1);

// Strona testowa integratora: pojedynczy SMS, rozsyłka, ostatnie wysyłki, odebrane webhooki.
// Narzędzie i wzorzec kodu, nie produkt - nie wystawiaj tej strony do internetu.

require __DIR__ . '/lib/gate.php';
require __DIR__ . '/lib/store.php';

$configFile = __DIR__ . '/config.php';
if (!is_file($configFile)) {
    http_response_code(500);
    exit('Brak config.php - skopiuj config.example.php do config.php i uzupełnij wartości.');
}
$config = require $configFile;
$gate = new MultiinfoGate((string) $config['GATE_URL'], (string) $config['API_KEY']);
$dataDir = (string) $config['DATA_DIR'];

session_start();
$_SESSION['csrf'] ??= bin2hex(random_bytes(16));

/** Każdy wypis do HTML przechodzi tędy. */
function e(?string $s): string
{
    return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
}

function post(string $key): string
{
    return trim((string) ($_POST[$key] ?? ''));
}

/** Komunikat do pokazania po przekierowaniu (wzorzec POST-redirect-GET: F5 nie powtarza wysyłki). */
function redirectWith(string $tone, string $text): never
{
    $_SESSION['flash'] = ['tone' => $tone, 'text' => $text];
    header('Location: index.php');
    exit;
}

/** Numery po jednym w wierszu; puste wiersze pomijane. */
function numbers(string $raw): array
{
    $lines = preg_split('/\R/', $raw) ?: [];
    return array_values(array_filter(array_map('trim', $lines), fn(string $n) => $n !== ''));
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!hash_equals($_SESSION['csrf'], post('csrf'))) {
        http_response_code(400);
        exit('Nieprawidłowy token formularza - odśwież stronę i spróbuj ponownie.');
    }
    try {
        switch (post('akcja')) {
            case 'sms':
                $r = $gate->sendMessage(post('numer'), post('tresc'), post('nadpis') ?: null);
                appendJsonl($dataDir, 'wyslane.jsonl', [
                    'id' => $r['id'], 'typ' => 'sms', 'czas' => date('c'), 'do' => post('numer'), 'status' => $r['status'],
                ]);
                redirectWith('ok', "SMS przyjęty: {$r['id']}, kodowanie {$r['encoding']}, części: {$r['parts']}.");
            case 'rozsylka':
                $nums = numbers(post('numery'));
                if ($nums === []) {
                    redirectWith('fail', 'Podaj przynajmniej jeden numer.');
                }
                $recipients = array_map(fn(string $n) => ['to' => $n], $nums);
                $r = $gate->createPackage($recipients, post('tresc'), post('nadpis') ?: null);
                appendJsonl($dataDir, 'wyslane.jsonl', [
                    'id' => $r['id'], 'typ' => 'rozsylka', 'czas' => date('c'),
                    'do' => count($nums) . ' numerów', 'status' => $r['status'], 'raport' => 'none',
                ]);
                redirectWith('ok', "Rozsyłka przyjęta: {$r['id']}, odbiorców: {$r['recipients']}.");
            case 'odswiez':
                $id = post('id');
                if (post('typ') === 'rozsylka') {
                    $r = $gate->getPackage($id);
                    updateJsonl($dataDir, 'wyslane.jsonl', $id, ['status' => $r['status'], 'raport' => $r['report']['status']]);
                    redirectWith('ok', "$id: {$r['status']}, raport: {$r['report']['status']}.");
                }
                $r = $gate->getMessage($id);
                updateJsonl($dataDir, 'wyslane.jsonl', $id, ['status' => $r['status']]);
                redirectWith('ok', "$id: {$r['status']}" . ($r['error'] ? " ({$r['error']})" : '') . '.');
            case 'raport':
                $id = post('id');
                $r = $gate->orderReport($id);
                updateJsonl($dataDir, 'wyslane.jsonl', $id, ['raport' => $r['report']['status']]);
                redirectWith('ok', "Raport $id zamówiony - odśwież stan za minutę.");
            default:
                redirectWith('fail', 'Nieznana akcja.');
        }
    } catch (GateException $ex) {
        redirectWith('fail', "Bramka odrzuciła żądanie ({$ex->gateCode}): {$ex->getMessage()}");
    }
}

if (isset($_GET['pobierz'])) {
    $id = (string) $_GET['pobierz'];
    if (!preg_match('/^pkg_[a-f0-9]+$/', $id)) {
        http_response_code(400);
        exit('Zły identyfikator rozsyłki.');
    }
    try {
        $csv = $gate->downloadReport($id);
    } catch (GateException $ex) {
        http_response_code(409);
        exit(e($ex->getMessage()));
    }
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $id . '.csv"');
    exit($csv);
}

$flash = $_SESSION['flash'] ?? null;
unset($_SESSION['flash']);
$csrf = $_SESSION['csrf'];
$wyslane = readJsonl($dataDir, 'wyslane.jsonl', 20);
$webhooki = readJsonl($dataDir, 'webhooki.jsonl', 20);
?>
<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Multiinfo Gate - przykład PHP</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 24px; color: #1c2024; background: #f4f4f2; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin: 28px 0 8px; }
  form { background: #fff; border: 1px solid #d8d8d3; padding: 14px 16px; max-width: 520px; }
  label { display: block; font-weight: 600; margin: 8px 0 3px; }
  input, textarea { width: 100%; box-sizing: border-box; padding: 6px 8px; font: inherit; }
  button { margin-top: 10px; padding: 7px 14px; font: inherit; cursor: pointer; }
  table { border-collapse: collapse; background: #fff; width: 100%; }
  th, td { border-bottom: 1px solid #e3e3df; padding: 6px 8px; text-align: left; font-size: 13px; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #666; }
  .flash { padding: 10px 12px; margin-bottom: 16px; border-left: 3px solid; }
  .ok { background: #e4f3e6; border-color: #2f8f46; } .fail { background: #fbe4e4; border-color: #c0392b; }
  .inline { display: inline; background: none; border: 0; padding: 0; margin: 0; }
  .inline button { margin: 0 4px 0 0; padding: 3px 8px; font-size: 12px; }
  code { font-family: ui-monospace, monospace; font-size: 12.5px; }
</style>
</head>
<body>
<h1>Multiinfo Gate - przykład PHP</h1>
<p>Bramka: <code><?= e($config['GATE_URL']) ?></code>. Narzędzie testowe - nie wystawiaj go do internetu.</p>

<?php if ($flash): ?>
  <div class="flash <?= e($flash['tone']) ?>"><?= e($flash['text']) ?></div>
<?php endif; ?>

<h2>Pojedynczy SMS</h2>
<form method="post">
  <input type="hidden" name="csrf" value="<?= e($csrf) ?>">
  <input type="hidden" name="akcja" value="sms">
  <label for="numer">Numer</label>
  <input id="numer" name="numer" placeholder="48601000001" required>
  <label for="tresc">Treść</label>
  <textarea id="tresc" name="tresc" rows="3" required></textarea>
  <label for="nadpis">Nadpis (opcjonalnie)</label>
  <input id="nadpis" name="nadpis" placeholder="Firma Info">
  <button type="submit">Wyślij SMS</button>
</form>

<h2>Rozsyłka</h2>
<form method="post">
  <input type="hidden" name="csrf" value="<?= e($csrf) ?>">
  <input type="hidden" name="akcja" value="rozsylka">
  <label for="numery">Numery, po jednym w wierszu</label>
  <textarea id="numery" name="numery" rows="4" placeholder="48601000001&#10;48605000001" required></textarea>
  <label for="tresc2">Treść</label>
  <textarea id="tresc2" name="tresc" rows="3" required></textarea>
  <label for="nadpis2">Nadpis (opcjonalnie)</label>
  <input id="nadpis2" name="nadpis" placeholder="Firma Info">
  <button type="submit">Wyślij rozsyłkę</button>
</form>

<h2>Ostatnie wysyłki</h2>
<table>
  <tr><th>Id</th><th>Typ</th><th>Czas</th><th>Do</th><th>Stan</th><th>Raport</th><th></th></tr>
  <?php foreach ($wyslane as $w): ?>
    <tr>
      <td><code><?= e($w['id'] ?? '') ?></code></td>
      <td><?= e($w['typ'] ?? '') ?></td>
      <td><?= e(substr((string) ($w['czas'] ?? ''), 0, 19)) ?></td>
      <td><?= e($w['do'] ?? '') ?></td>
      <td><?= e($w['status'] ?? '') ?></td>
      <td><?= e($w['raport'] ?? '-') ?></td>
      <td>
        <form method="post" class="inline">
          <input type="hidden" name="csrf" value="<?= e($csrf) ?>">
          <input type="hidden" name="akcja" value="odswiez">
          <input type="hidden" name="id" value="<?= e($w['id'] ?? '') ?>">
          <input type="hidden" name="typ" value="<?= e($w['typ'] ?? '') ?>">
          <button type="submit">Odśwież stan</button>
        </form>
        <?php if (($w['typ'] ?? '') === 'rozsylka'): ?>
          <form method="post" class="inline">
            <input type="hidden" name="csrf" value="<?= e($csrf) ?>">
            <input type="hidden" name="akcja" value="raport">
            <input type="hidden" name="id" value="<?= e($w['id'] ?? '') ?>">
            <button type="submit">Zamów raport</button>
          </form>
          <?php if (($w['raport'] ?? '') === 'ready'): ?>
            <a href="?pobierz=<?= e($w['id'] ?? '') ?>">Pobierz CSV</a>
          <?php endif; ?>
        <?php endif; ?>
      </td>
    </tr>
  <?php endforeach; ?>
  <?php if ($wyslane === []): ?><tr><td colspan="7">Jeszcze nic nie wysłano</td></tr><?php endif; ?>
</table>

<h2>Odebrane webhooki</h2>
<table>
  <tr><th>Czas</th><th>Zdarzenie</th><th>Id</th><th>Stan</th><th>Do</th><th>Błąd</th></tr>
  <?php foreach ($webhooki as $h): ?>
    <tr>
      <td><?= e(substr((string) ($h['czas'] ?? ''), 0, 19)) ?></td>
      <td><?= e($h['zdarzenie'] ?? '') ?></td>
      <td><code><?= e($h['id'] ?? '') ?></code></td>
      <td><?= e($h['status'] ?? '') ?></td>
      <td><?= e($h['do'] ?? '') ?></td>
      <td><?= e($h['blad'] ?? '') ?></td>
    </tr>
  <?php endforeach; ?>
  <?php if ($webhooki === []): ?><tr><td colspan="6">Brak zdarzeń - sprawdź adres webhooka przy kluczu i sekret w config.php</td></tr><?php endif; ?>
</table>
</body>
</html>
