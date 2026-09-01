# API bramki dla aplikacji klienckich

Bramka udostępnia aplikacjom interfejs HTTP z danymi w formacie JSON i obsługuje ruch w obie
strony. W stronę abonenta: aplikacja przekazuje numer odbiorcy i treść, a bramka odpowiada za
dobór kodowania, podział na części, uwierzytelnienie certyfikatem w Multiinfo, ponowienia,
raporty doręczeń i powiadomienia (rozdziały 3-6). Od abonenta: SMS-y wysłane na numer usługi
bramka odbiera z Multiinfo sama, w tle, i przekazuje aplikacji powiadomieniem `message.received`
na adres webhooka klucza, a ponadto udostępnia je do odczytu (`GET /v1/inbound`) i pozwala na nie
odpowiedzieć w wątku (`inReplyTo`) - rozdział 5a. Odbiór wymaga dwóch ustawień: kierowania
odebranych wiadomości do API na koncie Multiinfo (ustawia administrator Polkomtel) oraz
zaznaczenia odbioru przy kluczu API w panelu bramki. Dokument opisuje każde wywołanie w tym samym
układzie: przeznaczenie, pełne żądanie w siedmiu wariantach do wyboru zakładką (curl, surowy
HTTP, PHP, Python, Node.js, PowerShell, C#), odpowiedź oraz błędy tego wywołania wraz
z zalecanym postępowaniem.

## 1. Informacje ogólne

**Adres bazowy.** Po wystawieniu API pod domeną (`uruchomienie.md`, rozdział 6):
`https://<TWOJA-DOMENA>`. W trakcie testów przez tunel SSH (`uruchomienie.md`, punkt 5.1, a dla
kontenera LXC na Proxmoksie punkt 9.3): `http://127.0.0.1:8080`. Przykłady w tym dokumencie
używają domeny.

**Nagłówki.** Każde żądanie poza `GET /healthz` wymaga nagłówka
`Authorization: Bearer <TWOJ-KLUCZ>`. Żądania z body wymagają
`Content-Type: application/json`. Odpowiedzi mają typ `application/json; charset=utf-8`,
z wyjątkiem raportu rozsyłki w formacie CSV.

**Czas.** Wszystkie znaczniki czasu w żądaniach i odpowiedziach są zapisane w formacie ISO 8601
w strefie UTC, np. `2026-08-26T10:00:00.000Z`. Jedyny wyjątek to pole `changedAt` w raporcie
rozsyłki, przepisywane z Multiinfo w czasie polskim.

**Wartości przykładowe.** Numery (`48601000001`, `48605000001`), nadpis `Firma Info`,
identyfikator usługi `24138` oraz identyfikatory `msg_...` i `pkg_...` w przykładach są fikcyjne.

**Przykłady.** Wybór języka w dowolnym przykładzie przełącza wszystkie przykłady na stronie
i jest zapamiętywany w przeglądarce. Warianty nie wymagają bibliotek spoza języka: PHP używa
rozszerzenia curl, Python modułu `urllib` (z biblioteką `requests` kod jest krótszy, ale to
zależność do zainstalowania), Node.js wbudowanego `fetch` (Node 18 wzwyż, pliki `.mjs` albo
projekt z `"type": "module"`), PowerShell polecenia `Invoke-RestMethod` (PowerShell 7; w Windows
PowerShell 5.1 treść z polskimi znakami wymaga przekazania bajtów:
`-Body ([Text.Encoding]::UTF8.GetBytes($body))`), C# klasy `HttpClient` (.NET 8 wzwyż).
Przykłady pokazują samo wywołanie, bez obsługi błędów; błędy i zalecane postępowanie opisuje
rozdział 9, a przy każdym wywołaniu jego tabela błędów.

**Model przetwarzania.** Przyjęcie wiadomości i rozsyłki jest asynchroniczne: bramka odpowiada
kodem `202` natychmiast po zapisaniu żądania w kolejce, a wysyłka do Multiinfo, raport doręczenia
i ewentualna odmowa operatora następują później. Aktualny stan uzyskuje się odczytem
(rozdział 4) albo z powiadomień webhook (rozdział 6). Wiadomości przychodzące (SMS-y od
abonentów na numer usługi) bramka odbiera z Multiinfo sama i przekazuje aplikacji powiadomieniem
`message.received` (rozdział 6) oraz udostępnia do odczytu (rozdział 5a).

## 2. Uwierzytelnianie

Klucz API (`mig_live_...`) generuje administrator bramki w panelu i przekazuje go osobie
odpowiedzialnej za aplikację - razem z sekretem webhooka, jeżeli aplikacja ma odbierać
powiadomienia. Panel wyświetla obie wartości tylko raz; w bazie bramki pozostaje wyłącznie skrót
klucza. Utracony klucz zastępuje się nowym.

Klucz jest powiązany z jednym kontem Multiinfo, listą dozwolonych usług i nadpisów, limitem
liczby części jednej wiadomości, limitem żądań na minutę oraz datą ważności.

Błędy uwierzytelniania mają kod HTTP `401` i jedną z wartości `error.code`:

| `error.code` | Przyczyna | Postępowanie |
|---|---|---|
| `missing_api_key` | brak nagłówka `Authorization` albo nagłówek bez schematu `Bearer` | dodać nagłówek w postaci `Authorization: Bearer <TWOJ-KLUCZ>` |
| `invalid_api_key` | klucz nieznany albo w nieprawidłowym formacie | sprawdzić, czy klucz został skopiowany w całości, bez spacji i cudzysłowów |
| `revoked_api_key` | klucz odwołany w panelu | uzyskać nowy klucz od administratora |
| `expired_api_key` | upłynęła data ważności klucza; `message` podaje ostatni ważny dzień | poprosić administratora o przedłużenie ważności w panelu |

## 3. Wysyłka wiadomości: `POST /v1/messages`

**Przeznaczenie.** Wysłanie jednej wiadomości do jednego numeru albo tej samej treści do kilku
numerów (do 500). Bramka zapisuje wiadomość w kolejce i odpowiada natychmiast. Tablica numerów
jest przyjmowana w całości albo wcale: błędny numer na dowolnej pozycji odrzuca całe żądanie
kodem `400 invalid_phone` i żadna wiadomość nie trafia do kolejki.

**Żądanie:**

=== "curl"

    ```bash
    curl -s https://<TWOJA-DOMENA>/v1/messages \
      -H "Authorization: Bearer <TWOJ-KLUCZ>" \
      -H "Content-Type: application/json" \
      -d '{"to":"48601000001","text":"Przypominamy o wizycie 26.08 o 10:00.","orig":"Firma Info"}'
    ```

=== "HTTP"

    ```http
    POST /v1/messages HTTP/1.1
    Host: <TWOJA-DOMENA>
    Authorization: Bearer <TWOJ-KLUCZ>
    Content-Type: application/json

    {"to": "48601000001", "text": "Przypominamy o wizycie 26.08 o 10:00.", "orig": "Firma Info"}
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init('https://<TWOJA-DOMENA>/v1/messages');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode([
            'to' => '48601000001',
            'text' => 'Przypominamy o wizycie 26.08 o 10:00.',
            'orig' => 'Firma Info',
        ]),
        CURLOPT_HTTPHEADER => ['Authorization: Bearer <TWOJ-KLUCZ>', 'Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
    ]);
    $odpowiedz = json_decode(curl_exec($ch), true);
    echo $odpowiedz['id'];
    ```

=== "Python"

    ```python
    import json, urllib.request

    req = urllib.request.Request(
        "https://<TWOJA-DOMENA>/v1/messages",
        data=json.dumps({"to": "48601000001", "text": "Przypominamy o wizycie 26.08 o 10:00.", "orig": "Firma Info"}).encode(),
        headers={"Authorization": "Bearer <TWOJ-KLUCZ>", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as res:
        odpowiedz = json.load(res)
    print(odpowiedz["id"])
    ```

=== "Node.js"

    ```js
    const res = await fetch("https://<TWOJA-DOMENA>/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer <TWOJ-KLUCZ>", "Content-Type": "application/json" },
      body: JSON.stringify({"to": "48601000001", "text": "Przypominamy o wizycie 26.08 o 10:00.", "orig": "Firma Info"}),
    });
    const odpowiedz = await res.json();
    console.log(odpowiedz.id);
    ```

=== "PowerShell"

    ```powershell
    $naglowki = @{ Authorization = "Bearer <TWOJ-KLUCZ>" }
    $body = @{ to = "48601000001"; text = "Przypominamy o wizycie 26.08 o 10:00."; orig = "Firma Info" } | ConvertTo-Json
    $odpowiedz = Invoke-RestMethod -Method Post -Uri "https://<TWOJA-DOMENA>/v1/messages" -Headers $naglowki -ContentType "application/json; charset=utf-8" -Body $body
    $odpowiedz.id
    ```

=== "C#"

    ```csharp
    using System.Text;
    using System.Net.Http.Headers;
    using System.Text.Json;

    using var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "<TWOJ-KLUCZ>");

    var tresc = new StringContent("""{"to": "48601000001", "text": "Przypominamy o wizycie 26.08 o 10:00.", "orig": "Firma Info"}""", Encoding.UTF8, "application/json");
    var res = await http.PostAsync("https://<TWOJA-DOMENA>/v1/messages", tresc);
    var odpowiedz = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
    Console.WriteLine(odpowiedz.RootElement.GetProperty("id"));
    ```

Pola body żądania:

| Pole | Wymagane | Opis |
|---|---|---|
| `to` | tak | numer odbiorcy albo tablica numerów (najwyżej 500); numer bez kodu kraju otrzymuje kod domyślny konta (dla Polski `48`), spacje i myślniki są pomijane; numer z kodem `48` musi mieć dokładnie 11 cyfr, podwojony kod kraju (`4848…`) jest odrzucany |
| `text` | tak | treść wiadomości; znaki spoza alfabetu GSM (w tym polskie) są dozwolone, patrz `encoding` |
| `orig` | nie | nadpis nadawcy; musi należeć do nadpisów dozwolonych dla klucza; pominięty = nadpis domyślny klucza albo konta, a gdy żaden nie jest ustawiony - wysyłka bez nadpisu, z numerem przydzielonym kontu w Multiinfo jako nadawcą |
| `serviceId` | nie | identyfikator usługi Multiinfo; pominięty = usługa domyślna klucza |
| `encoding` | nie | `auto` (domyślnie: GSM-7, a przy znakach spoza GSM - UCS-2), `gsm` (wymusza GSM-7; Multiinfo zastępuje polskie znaki łacińskimi odpowiednikami), `unicode` (wymusza UCS-2) |
| `maxParts` | nie | 1-9, górna granica liczby części tej wiadomości; nie może przekraczać limitu klucza |
| `deliveryReport` | nie | domyślnie `true`; `false` oznacza rezygnację z raportu doręczenia - stan wiadomości kończy się na `sent` |
| `validTo` | nie | ISO 8601, najwyżej 72 godziny od przyjęcia; wiadomość niedoręczona do tego czasu otrzymuje stan `expired` |
| `costCenter` | nie | dowolny znacznik na potrzeby rozliczeń aplikacji; zwracany w odczycie wiadomości |
| `inReplyTo` | nie | identyfikator wiadomości przychodzącej (`in_...`), na którą to odpowiedź (rozdział 5a.3); bramka przekazuje go Multiinfo jako `smsInId`; dopuszczalny tylko przy jednym odbiorcy, którym jest nadawca tej wiadomości, i w tej samej usłudze, z której przyszła |

**Odpowiedź `202 Accepted`** (dla tablicy `to` - tablica takich obiektów, w kolejności numerów):

```json
{
  "id": "msg_3f9c2a7b1e4d8c6a5b2f",
  "status": "queued",
  "encoding": "gsm",
  "parts": 1,
  "characters": 39,
  "slots": 39,
  "slotsRemaining": 121
}
```

`parts` to liczba części, na które wiadomość została podzielona (każda część jest rozliczana
przez operatora osobno). `slots` to liczba zajętych miejsc: w kodowaniu GSM-7 znaki
`{ } [ ] ~ ^ | \ €` zajmują dwa miejsca. `slotsRemaining` to liczba wolnych miejsc w ostatniej
części.

### 3.1. Klucz idempotencji

Jeżeli aplikacja wyśle żądanie, ale nie otrzyma odpowiedzi (zerwane połączenie, przekroczony
czas oczekiwania), nie wie, czy wiadomość została przyjęta. Ponowienie żądania bez zabezpieczenia
może wysłać wiadomość dwukrotnie. Zabezpieczeniem jest nagłówek `Idempotency-Key` z wartością
jednoznacznie identyfikującą operację po stronie aplikacji (np. identyfikator zamówienia):

=== "curl"

    ```bash
    curl -s https://<TWOJA-DOMENA>/v1/messages \
      -H "Authorization: Bearer <TWOJ-KLUCZ>" \
      -H "Content-Type: application/json" \
      -H "Idempotency-Key: zamowienie-10422" \
      -d '{"to":"48601000001","text":"Zamowienie 10422 jest gotowe do odbioru."}'
    ```

=== "HTTP"

    ```http
    POST /v1/messages HTTP/1.1
    Host: <TWOJA-DOMENA>
    Authorization: Bearer <TWOJ-KLUCZ>
    Idempotency-Key: zamowienie-10422
    Content-Type: application/json

    {"to": "48601000001", "text": "Zamowienie 10422 jest gotowe do odbioru."}
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init('https://<TWOJA-DOMENA>/v1/messages');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode([
            'to' => '48601000001',
            'text' => 'Zamowienie 10422 jest gotowe do odbioru.',
        ]),
        CURLOPT_HTTPHEADER => ['Authorization: Bearer <TWOJ-KLUCZ>', 'Idempotency-Key: zamowienie-10422', 'Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
    ]);
    $odpowiedz = json_decode(curl_exec($ch), true);
    echo $odpowiedz['id'];
    ```

=== "Python"

    ```python
    import json, urllib.request

    req = urllib.request.Request(
        "https://<TWOJA-DOMENA>/v1/messages",
        data=json.dumps({"to": "48601000001", "text": "Zamowienie 10422 jest gotowe do odbioru."}).encode(),
        headers={"Authorization": "Bearer <TWOJ-KLUCZ>", "Idempotency-Key": "zamowienie-10422", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as res:
        odpowiedz = json.load(res)
    print(odpowiedz["id"])
    ```

=== "Node.js"

    ```js
    const res = await fetch("https://<TWOJA-DOMENA>/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer <TWOJ-KLUCZ>", "Idempotency-Key": "zamowienie-10422", "Content-Type": "application/json" },
      body: JSON.stringify({"to": "48601000001", "text": "Zamowienie 10422 jest gotowe do odbioru."}),
    });
    const odpowiedz = await res.json();
    console.log(odpowiedz.id);
    ```

=== "PowerShell"

    ```powershell
    $naglowki = @{ Authorization = "Bearer <TWOJ-KLUCZ>"; "Idempotency-Key" = "zamowienie-10422" }
    $body = @{ to = "48601000001"; text = "Zamowienie 10422 jest gotowe do odbioru." } | ConvertTo-Json
    $odpowiedz = Invoke-RestMethod -Method Post -Uri "https://<TWOJA-DOMENA>/v1/messages" -Headers $naglowki -ContentType "application/json; charset=utf-8" -Body $body
    $odpowiedz.id
    ```

=== "C#"

    ```csharp
    using System.Text;
    using System.Net.Http.Headers;
    using System.Text.Json;

    using var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "<TWOJ-KLUCZ>");
    http.DefaultRequestHeaders.Add("Idempotency-Key", "zamowienie-10422");

    var tresc = new StringContent("""{"to": "48601000001", "text": "Zamowienie 10422 jest gotowe do odbioru."}""", Encoding.UTF8, "application/json");
    var res = await http.PostAsync("https://<TWOJA-DOMENA>/v1/messages", tresc);
    var odpowiedz = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
    Console.WriteLine(odpowiedz.RootElement.GetProperty("id"));
    ```

Ponowione żądanie z tym samym kluczem idempotencji, numerem i treścią wiadomości zwraca dane wiadomości
przyjętej za pierwszym razem, bez tworzenia nowej. Żądanie z tym samym kluczem, ale inną treścią wiadomości
albo numerem, jest odrzucane kodem `409 idempotency_conflict`. Przy tablicy `to` bramka
rozszerza klucz o przyrostek `#<indeks>` dla każdego numeru.

### 3.2. Błędy wywołania

| HTTP | `error.code` | Przyczyna | Postępowanie |
|---|---|---|---|
| 400 | `invalid_body` | body żądania nie przechodzi walidacji; `message` wymienia pola | poprawić wskazane pola |
| 400 | `invalid_phone` | numer nie daje się znormalizować: znaki inne niż cyfry, zła liczba cyfr, podwojony kod kraju (`4848…`); `message` podaje powód | podać numer w postaci `48601000001` |
| 400 | `invalid_orig` | nadpis pusty, dłuższy niż 11 znaków albo ze znakami sterującymi | użyć nadpisu ze słownika konta |
| 400 | `too_many_parts` | treść przekracza limit części; `message` podaje, ile miejsc należy usunąć | skrócić treść albo uzgodnić wyższy limit klucza |
| 400 | `service_required` | klucz nie ma usługi domyślnej, a `serviceId` nie podano | podać `serviceId` |
| 400 | `valid_to_in_past`, `valid_to_too_far` | `validTo` w przeszłości albo dalej niż 72 godziny | poprawić `validTo` |
| 403 | `service_not_allowed` | usługa spoza uprawnień klucza | użyć usługi przypisanej do klucza |
| 403 | `orig_not_allowed` | nadpis spoza uprawnień klucza; `message` wymienia dozwolone | użyć jednego z wymienionych |
| 409 | `idempotency_conflict` | ten sam `Idempotency-Key` z inną treścią wiadomości albo numerem | użyć nowego klucza idempotencji |
| 429 | `rate_limited` | przekroczony limit żądań klucza na minutę | odczekać minutę; nie ponawiać w pętli |

Odmowa po stronie Multiinfo (np. nieuruchomiony nadpis, kod `-14`) nie jest błędem HTTP:
żądanie zostaje przyjęte kodem `202`, a odmowa pojawia się w stanie wiadomości jako `failed`
z polami `providerCode` i `error` oraz w powiadomieniu `message.failed`.

## 4. Stan wiadomości, lista, anulowanie

### 4.1. Stan wiadomości: `GET /v1/messages/{id}`

**Przeznaczenie.** Odczyt bieżącego stanu wiadomości: czy została wysłana, doręczona, a jeżeli
nie - z jakiego powodu.

=== "curl"

    ```bash
    curl -s https://<TWOJA-DOMENA>/v1/messages/msg_3f9c2a7b1e4d8c6a5b2f \
      -H "Authorization: Bearer <TWOJ-KLUCZ>"
    ```

=== "HTTP"

    ```http
    GET /v1/messages/msg_3f9c2a7b1e4d8c6a5b2f HTTP/1.1
    Host: <TWOJA-DOMENA>
    Authorization: Bearer <TWOJ-KLUCZ>
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init('https://<TWOJA-DOMENA>/v1/messages/msg_3f9c2a7b1e4d8c6a5b2f');
    curl_setopt_array($ch, [
        CURLOPT_HTTPHEADER => ['Authorization: Bearer <TWOJ-KLUCZ>'],
        CURLOPT_RETURNTRANSFER => true,
    ]);
    $odpowiedz = json_decode(curl_exec($ch), true);
    echo $odpowiedz['status'];
    ```

=== "Python"

    ```python
    import json, urllib.request

    req = urllib.request.Request(
        "https://<TWOJA-DOMENA>/v1/messages/msg_3f9c2a7b1e4d8c6a5b2f",
        headers={"Authorization": "Bearer <TWOJ-KLUCZ>"},
    )
    with urllib.request.urlopen(req) as res:
        odpowiedz = json.load(res)
    print(odpowiedz["status"])
    ```

=== "Node.js"

    ```js
    const res = await fetch("https://<TWOJA-DOMENA>/v1/messages/msg_3f9c2a7b1e4d8c6a5b2f", {
      headers: { Authorization: "Bearer <TWOJ-KLUCZ>" },
    });
    const odpowiedz = await res.json();
    console.log(odpowiedz.status);
    ```

=== "PowerShell"

    ```powershell
    $naglowki = @{ Authorization = "Bearer <TWOJ-KLUCZ>" }
    $odpowiedz = Invoke-RestMethod -Uri "https://<TWOJA-DOMENA>/v1/messages/msg_3f9c2a7b1e4d8c6a5b2f" -Headers $naglowki
    $odpowiedz.status
    ```

=== "C#"

    ```csharp
    using System.Net.Http.Headers;
    using System.Text.Json;

    using var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "<TWOJ-KLUCZ>");

    var odpowiedz = JsonDocument.Parse(await http.GetStringAsync("https://<TWOJA-DOMENA>/v1/messages/msg_3f9c2a7b1e4d8c6a5b2f"));
    Console.WriteLine(odpowiedz.RootElement.GetProperty("status"));
    ```

**Odpowiedź `200`:**

```json
{
  "id": "msg_3f9c2a7b1e4d8c6a5b2f",
  "status": "delivered",
  "to": "48601000001",
  "text": "Przypominamy o wizycie 26.08 o 10:00.",
  "encoding": "gsm",
  "parts": 1,
  "slots": 39,
  "orig": "Firma Info",
  "serviceId": "24138",
  "inReplyTo": null,
  "costCenter": null,
  "createdAt": "2026-08-26T10:00:00.000Z",
  "sentAt": "2026-08-26T10:00:01.000Z",
  "finalAt": "2026-08-26T10:00:12.000Z",
  "providerCode": null,
  "error": null
}
```

Pole `text` występuje tylko wtedy, gdy konto Multiinfo ma włączone przechowywanie treści.
Pole `inReplyTo` to identyfikator wiadomości przychodzącej, gdy wysyłka była odpowiedzią
w wątku (rozdział 5a.3), w pozostałych przypadkach `null`. Wartości `status` objaśnia rozdział 7.

| HTTP | `error.code` | Przyczyna | Postępowanie |
|---|---|---|---|
| 404 | `message_not_found` | brak wiadomości o tym identyfikatorze albo wiadomość należy do innego klucza | sprawdzić identyfikator z odpowiedzi `202` |

### 4.2. Lista wiadomości: `GET /v1/messages`

**Przeznaczenie.** Przegląd wiadomości wysłanych danym kluczem, z filtrowaniem - np. wszystkie
niedoręczone z bieżącego dnia.

=== "curl"

    ```bash
    curl -s "https://<TWOJA-DOMENA>/v1/messages?status=failed&from=2026-08-26T00:00:00Z&limit=50" \
      -H "Authorization: Bearer <TWOJ-KLUCZ>"
    ```

=== "HTTP"

    ```http
    GET /v1/messages?status=failed&from=2026-08-26T00:00:00Z&limit=50 HTTP/1.1
    Host: <TWOJA-DOMENA>
    Authorization: Bearer <TWOJ-KLUCZ>
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init('https://<TWOJA-DOMENA>/v1/messages?status=failed&from=2026-08-26T00:00:00Z&limit=50');
    curl_setopt_array($ch, [
        CURLOPT_HTTPHEADER => ['Authorization: Bearer <TWOJ-KLUCZ>'],
        CURLOPT_RETURNTRANSFER => true,
    ]);
    $odpowiedz = json_decode(curl_exec($ch), true);
    foreach ($odpowiedz['data'] as $w) {
        echo $w['id'], ' ', $w['status'], PHP_EOL;
    }
    ```

=== "Python"

    ```python
    import json, urllib.request

    req = urllib.request.Request(
        "https://<TWOJA-DOMENA>/v1/messages?status=failed&from=2026-08-26T00:00:00Z&limit=50",
        headers={"Authorization": "Bearer <TWOJ-KLUCZ>"},
    )
    with urllib.request.urlopen(req) as res:
        odpowiedz = json.load(res)
    for w in odpowiedz["data"]:
        print(w["id"], w["status"])
    ```

=== "Node.js"

    ```js
    const res = await fetch("https://<TWOJA-DOMENA>/v1/messages?status=failed&from=2026-08-26T00:00:00Z&limit=50", {
      headers: { Authorization: "Bearer <TWOJ-KLUCZ>" },
    });
    const odpowiedz = await res.json();
    for (const w of odpowiedz.data) console.log(w.id, w.status);
    ```

=== "PowerShell"

    ```powershell
    $naglowki = @{ Authorization = "Bearer <TWOJ-KLUCZ>" }
    $odpowiedz = Invoke-RestMethod -Uri "https://<TWOJA-DOMENA>/v1/messages?status=failed&from=2026-08-26T00:00:00Z&limit=50" -Headers $naglowki
    $odpowiedz.data | ForEach-Object { "$($_.id) $($_.status)" }
    ```

=== "C#"

    ```csharp
    using System.Net.Http.Headers;
    using System.Text.Json;

    using var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "<TWOJ-KLUCZ>");

    var odpowiedz = JsonDocument.Parse(await http.GetStringAsync("https://<TWOJA-DOMENA>/v1/messages?status=failed&from=2026-08-26T00:00:00Z&limit=50"));
    foreach (var w in odpowiedz.RootElement.GetProperty("data").EnumerateArray())
        Console.WriteLine(w.GetProperty("id") + " " + w.GetProperty("status"));
    ```

Parametry zapytania (wszystkie opcjonalne):

| Parametr | Opis |
|---|---|
| `status` | jedna z wartości ze słownika w rozdziale 7 |
| `to` | numer odbiorcy po normalizacji, np. `48601000001` |
| `from`, `until` | zakres czasu przyjęcia, ISO 8601 |
| `limit` | liczba wyników, domyślnie 25, najwyżej 200 |
| `offset` | liczba pominiętych wyników od początku listy |

**Odpowiedź `200`:** `{ "data": [ ... ], "hasMore": true }` - obiekty jak w punkcie 4.1,
od najnowszej. `hasMore: true` oznacza, że lista ma dalsze pozycje; pobiera się je, zwiększając
`offset` o wartość `limit`.

### 4.3. Anulowanie: `POST /v1/messages/{id}/cancel`

**Przeznaczenie.** Zatrzymanie wiadomości, która nie dotarła jeszcze do odbiorcy. Wiadomość
w kolejce bramki jest anulowana natychmiast; wiadomość przekazana już do Multiinfo jest
anulowana po stronie operatora, o ile nie została jeszcze doręczona.

=== "curl"

    ```bash
    curl -s -X POST https://<TWOJA-DOMENA>/v1/messages/msg_3f9c2a7b1e4d8c6a5b2f/cancel \
      -H "Authorization: Bearer <TWOJ-KLUCZ>"
    ```

=== "HTTP"

    ```http
    POST /v1/messages/msg_3f9c2a7b1e4d8c6a5b2f/cancel HTTP/1.1
    Host: <TWOJA-DOMENA>
    Authorization: Bearer <TWOJ-KLUCZ>
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init('https://<TWOJA-DOMENA>/v1/messages/msg_3f9c2a7b1e4d8c6a5b2f/cancel');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => '',
        CURLOPT_HTTPHEADER => ['Authorization: Bearer <TWOJ-KLUCZ>'],
        CURLOPT_RETURNTRANSFER => true,
    ]);
    $odpowiedz = json_decode(curl_exec($ch), true);
    echo $odpowiedz['status'];
    ```

=== "Python"

    ```python
    import json, urllib.request

    req = urllib.request.Request(
        "https://<TWOJA-DOMENA>/v1/messages/msg_3f9c2a7b1e4d8c6a5b2f/cancel",
        headers={"Authorization": "Bearer <TWOJ-KLUCZ>"},
        method="POST",
    )
    with urllib.request.urlopen(req) as res:
        odpowiedz = json.load(res)
    print(odpowiedz["status"])
    ```

=== "Node.js"

    ```js
    const res = await fetch("https://<TWOJA-DOMENA>/v1/messages/msg_3f9c2a7b1e4d8c6a5b2f/cancel", {
      method: "POST",
      headers: { Authorization: "Bearer <TWOJ-KLUCZ>" },
    });
    const odpowiedz = await res.json();
    console.log(odpowiedz.status);
    ```

=== "PowerShell"

    ```powershell
    $naglowki = @{ Authorization = "Bearer <TWOJ-KLUCZ>" }
    $odpowiedz = Invoke-RestMethod -Method Post -Uri "https://<TWOJA-DOMENA>/v1/messages/msg_3f9c2a7b1e4d8c6a5b2f/cancel" -Headers $naglowki
    $odpowiedz.status
    ```

=== "C#"

    ```csharp
    using System.Net.Http.Headers;
    using System.Text.Json;

    using var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "<TWOJ-KLUCZ>");

    var res = await http.PostAsync("https://<TWOJA-DOMENA>/v1/messages/msg_3f9c2a7b1e4d8c6a5b2f/cancel", null);
    var odpowiedz = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
    Console.WriteLine(odpowiedz.RootElement.GetProperty("status"));
    ```

**Odpowiedź `200`:** `{ "id": "msg_3f9c2a7b1e4d8c6a5b2f", "status": "cancelled" }`

| HTTP | `error.code` | Przyczyna | Postępowanie |
|---|---|---|---|
| 404 | `message_not_found` | brak wiadomości albo wiadomość innego klucza | sprawdzić identyfikator |
| 409 | `already_final` | wiadomość ma już stan ostateczny (`delivered`, `failed` itd.) | anulowanie nie jest możliwe |
| 409 | `already_passed` | Multiinfo odmówiło (`providerCode: -41`): wiadomość została już przekazana do sieci | anulowanie nie jest możliwe |
| 502 | `provider_error` | inny błąd Multiinfo; `providerCode` w body odpowiedzi | ponowić po chwili; przy powtarzaniu przekazać `providerCode` administratorowi |
| 503 | `account_certificate` | Multiinfo odrzuciło certyfikat bramki | przekazać administratorowi; wymaga interwencji po stronie certyfikatu |

Wiadomość wieloczęściowa jest anulowana część po części. Jeżeli którejś części nie da się cofnąć,
bramka przerywa operację: części już anulowane pozostają anulowane, a odpowiedź ma kod `409`.

Anulowanie może trafić do bramki w chwili, w której wiadomość jest właśnie przekazywana do
Multiinfo. Bramka odpowiada wtedy `cancelled`, a po zakończeniu przekazania cofa części
u operatora. Jeżeli operator odmówi, bo wiadomość poszła już do sieci, wiadomość wraca do stanu
`sent`, a w jej przebiegu w panelu pojawia się wpis „Anulowanie nieskuteczne”. Aplikacja, dla
której to rozróżnienie ma znaczenie, sprawdza stan wiadomości (4.1) po kilku sekundach.

## 5. Rozsyłki

Rozsyłka to jedno zlecenie z listą do 5000 odbiorców, z których większość otrzymuje tę samą
treść. Każdy odbiorca może mieć treść własną oraz identyfikator (`clientId`) zwracany w raporcie,
co ułatwia dopasowanie wyników do rekordów aplikacji. Rozsyłka jest przetwarzana asynchronicznie:
bramka odpowiada natychmiast, a stan i raport odczytuje się kolejnymi wywołaniami.

### 5.1. Utworzenie rozsyłki: `POST /v1/packages`

=== "curl"

    ```bash
    curl -s https://<TWOJA-DOMENA>/v1/packages \
      -H "Authorization: Bearer <TWOJ-KLUCZ>" \
      -H "Content-Type: application/json" \
      -d '{
        "defaultText": "Przypominamy o wizycie.",
        "recipients": [
          { "to": "48601000001" },
          { "to": "48605000001", "text": "Faktura 114 oczekuje na oplacenie.", "clientId": "faktura-114" }
        ],
        "orig": "Firma Info"
      }'
    ```

=== "HTTP"

    ```http
    POST /v1/packages HTTP/1.1
    Host: <TWOJA-DOMENA>
    Authorization: Bearer <TWOJ-KLUCZ>
    Content-Type: application/json

    {"defaultText": "Przypominamy o wizycie.", "recipients": [{"to": "48601000001"}, {"to": "48605000001", "text": "Faktura 114 oczekuje na oplacenie.", "clientId": "faktura-114"}], "orig": "Firma Info"}
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init('https://<TWOJA-DOMENA>/v1/packages');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode([
            'defaultText' => 'Przypominamy o wizycie.',
            'recipients' => [
                [
                    'to' => '48601000001',
                ],
                [
                    'to' => '48605000001',
                    'text' => 'Faktura 114 oczekuje na oplacenie.',
                    'clientId' => 'faktura-114',
                ],
            ],
            'orig' => 'Firma Info',
        ]),
        CURLOPT_HTTPHEADER => ['Authorization: Bearer <TWOJ-KLUCZ>', 'Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
    ]);
    $odpowiedz = json_decode(curl_exec($ch), true);
    echo $odpowiedz['id'];
    ```

=== "Python"

    ```python
    import json, urllib.request

    req = urllib.request.Request(
        "https://<TWOJA-DOMENA>/v1/packages",
        data=json.dumps({"defaultText": "Przypominamy o wizycie.", "recipients": [{"to": "48601000001"}, {"to": "48605000001", "text": "Faktura 114 oczekuje na oplacenie.", "clientId": "faktura-114"}], "orig": "Firma Info"}).encode(),
        headers={"Authorization": "Bearer <TWOJ-KLUCZ>", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as res:
        odpowiedz = json.load(res)
    print(odpowiedz["id"])
    ```

=== "Node.js"

    ```js
    const res = await fetch("https://<TWOJA-DOMENA>/v1/packages", {
      method: "POST",
      headers: { Authorization: "Bearer <TWOJ-KLUCZ>", "Content-Type": "application/json" },
      body: JSON.stringify({"defaultText": "Przypominamy o wizycie.", "recipients": [{"to": "48601000001"}, {"to": "48605000001", "text": "Faktura 114 oczekuje na oplacenie.", "clientId": "faktura-114"}], "orig": "Firma Info"}),
    });
    const odpowiedz = await res.json();
    console.log(odpowiedz.id);
    ```

=== "PowerShell"

    ```powershell
    $naglowki = @{ Authorization = "Bearer <TWOJ-KLUCZ>" }
    $body = @{ defaultText = "Przypominamy o wizycie."; recipients = @(
        @{ to = "48601000001" },
        @{ to = "48605000001"; text = "Faktura 114 oczekuje na oplacenie."; clientId = "faktura-114" }
    ); orig = "Firma Info" } | ConvertTo-Json
    $odpowiedz = Invoke-RestMethod -Method Post -Uri "https://<TWOJA-DOMENA>/v1/packages" -Headers $naglowki -ContentType "application/json; charset=utf-8" -Body $body
    $odpowiedz.id
    ```

=== "C#"

    ```csharp
    using System.Text;
    using System.Net.Http.Headers;
    using System.Text.Json;

    using var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "<TWOJ-KLUCZ>");

    var tresc = new StringContent("""{"defaultText": "Przypominamy o wizycie.", "recipients": [{"to": "48601000001"}, {"to": "48605000001", "text": "Faktura 114 oczekuje na oplacenie.", "clientId": "faktura-114"}], "orig": "Firma Info"}""", Encoding.UTF8, "application/json");
    var res = await http.PostAsync("https://<TWOJA-DOMENA>/v1/packages", tresc);
    var odpowiedz = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
    Console.WriteLine(odpowiedz.RootElement.GetProperty("id"));
    ```

| Pole | Wymagane | Opis |
|---|---|---|
| `recipients` | tak | od 1 do 5000 pozycji `{ "to", "text"?, "clientId"? }` |
| `defaultText` | nie | treść dla odbiorców bez własnego `text`; wymagana, jeżeli którykolwiek odbiorca jej nie ma |
| `recipients[].clientId` | nie | 1-20 znaków z zakresu `A-Z a-z 0-9 . _ -`; zwracany w raporcie |
| `orig`, `serviceId`, `encoding`, `deliveryReport`, `costCenter` | nie | znaczenie jak w rozdziale 3 |
| `startAt` | nie | ISO 8601 w przyszłości; Multiinfo rozpoczyna wysyłkę o tej godzinie |

Kodowanie jest wspólne dla całej rozsyłki: jeżeli którakolwiek treść wymaga UCS-2, wszystkie
wiadomości są wysyłane w UCS-2 (70 znaków na część zamiast 160). Każda treść musi mieścić się
w limicie części klucza.

**Odpowiedź `202`:**

```json
{ "id": "pkg_7c1e9a2b3d4f5a6b7c8d", "status": "queued", "recipients": 2, "encoding": "gsm", "multipart": false }
```

| HTTP | `error.code` | Przyczyna | Postępowanie |
|---|---|---|---|
| 400 | `invalid_body` | body nie przechodzi walidacji; `message` wymienia pola | poprawić wskazane pola |
| 400 | `invalid_phone` | numer odbiorcy nie daje się znormalizować (znaki inne niż cyfry, zła liczba cyfr, podwojony kod kraju); `message` wskazuje pozycję i powód | poprawić numer |
| 400 | `text_required` | odbiorca bez treści własnej i bez `defaultText` | dodać `defaultText` albo `text` odbiorcy |
| 400 | `invalid_client_id` | `clientId` poza dozwolonym wzorcem | użyć wyłącznie liter, cyfr, kropki, podkreślenia i myślnika, do 20 znaków |
| 400 | `too_many_parts` | treść przekracza limit części | skrócić treść |
| 400 | `invalid_orig`, `service_required`, `start_at_in_past` | jak nazwa kodu | poprawić pole |
| 403 | `service_not_allowed`, `orig_not_allowed` | usługa albo nadpis spoza uprawnień klucza | użyć wartości przypisanych do klucza |
| 429 | `rate_limited` | przekroczony limit żądań na minutę | odczekać minutę |

### 5.2. Stan rozsyłki: `GET /v1/packages/{id}`

=== "curl"

    ```bash
    curl -s https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d \
      -H "Authorization: Bearer <TWOJ-KLUCZ>"
    ```

=== "HTTP"

    ```http
    GET /v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d HTTP/1.1
    Host: <TWOJA-DOMENA>
    Authorization: Bearer <TWOJ-KLUCZ>
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init('https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d');
    curl_setopt_array($ch, [
        CURLOPT_HTTPHEADER => ['Authorization: Bearer <TWOJ-KLUCZ>'],
        CURLOPT_RETURNTRANSFER => true,
    ]);
    $odpowiedz = json_decode(curl_exec($ch), true);
    echo $odpowiedz['status'];
    ```

=== "Python"

    ```python
    import json, urllib.request

    req = urllib.request.Request(
        "https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d",
        headers={"Authorization": "Bearer <TWOJ-KLUCZ>"},
    )
    with urllib.request.urlopen(req) as res:
        odpowiedz = json.load(res)
    print(odpowiedz["status"])
    ```

=== "Node.js"

    ```js
    const res = await fetch("https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d", {
      headers: { Authorization: "Bearer <TWOJ-KLUCZ>" },
    });
    const odpowiedz = await res.json();
    console.log(odpowiedz.status);
    ```

=== "PowerShell"

    ```powershell
    $naglowki = @{ Authorization = "Bearer <TWOJ-KLUCZ>" }
    $odpowiedz = Invoke-RestMethod -Uri "https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d" -Headers $naglowki
    $odpowiedz.status
    ```

=== "C#"

    ```csharp
    using System.Net.Http.Headers;
    using System.Text.Json;

    using var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "<TWOJ-KLUCZ>");

    var odpowiedz = JsonDocument.Parse(await http.GetStringAsync("https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d"));
    Console.WriteLine(odpowiedz.RootElement.GetProperty("status"));
    ```

**Odpowiedź `200`:**

```json
{
  "id": "pkg_7c1e9a2b3d4f5a6b7c8d",
  "status": "completed",
  "recipients": 2,
  "remaining": 0,
  "encoding": "gsm",
  "multipart": false,
  "serviceId": "24138",
  "orig": "Firma Info",
  "startAt": null,
  "createdAt": "2026-08-26T10:00:00.000Z",
  "completedAt": "2026-08-26T10:03:40.000Z",
  "providerCode": null,
  "error": null,
  "report": { "status": "ready", "expiresAt": "2026-08-26T10:35:00.000Z" },
  "summary": { "delivered": 1, "failed": 1, "other": 0 }
}
```

Pole `summary` występuje tylko przy `report.status` równym `ready`.

| `status` | Znaczenie |
|---|---|
| `queued` | przyjęta, oczekuje na utworzenie w Multiinfo |
| `open` | utworzona w Multiinfo, oczekuje na rozpoczęcie |
| `sending` | w trakcie wysyłki; `remaining` maleje |
| `completed` | wysyłka zakończona; bramka zamawia raport samoczynnie |
| `cancelled` | anulowana po stronie Multiinfo |
| `failed` | odrzucona przez Multiinfo; przyczyna w `providerCode` i `error` |

| `report.status` | Znaczenie |
|---|---|
| `none` | raport nie został jeszcze zamówiony |
| `pending` | zamówiony; Multiinfo generuje go zwykle w ciągu kilku minut |
| `ready` | pobrany i dostępny przez `GET .../report` |
| `failed` | Multiinfo nie wygenerowało raportu; można zamówić ponownie |

| HTTP | `error.code` | Przyczyna | Postępowanie |
|---|---|---|---|
| 404 | `package_not_found` | brak rozsyłki albo rozsyłka innego klucza | sprawdzić identyfikator |

### 5.3. Ponowne zamówienie raportu: `POST /v1/packages/{id}/report`

**Przeznaczenie.** Bramka zamawia raport samoczynnie po zakończeniu rozsyłki. Wywołanie służy do
ponowienia zamówienia, gdy poprzedni raport ma stan `failed`.

=== "curl"

    ```bash
    curl -s -X POST https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report \
      -H "Authorization: Bearer <TWOJ-KLUCZ>"
    ```

=== "HTTP"

    ```http
    POST /v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report HTTP/1.1
    Host: <TWOJA-DOMENA>
    Authorization: Bearer <TWOJ-KLUCZ>
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init('https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => '',
        CURLOPT_HTTPHEADER => ['Authorization: Bearer <TWOJ-KLUCZ>'],
        CURLOPT_RETURNTRANSFER => true,
    ]);
    $odpowiedz = json_decode(curl_exec($ch), true);
    echo $odpowiedz['report']['status'];
    ```

=== "Python"

    ```python
    import json, urllib.request

    req = urllib.request.Request(
        "https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report",
        headers={"Authorization": "Bearer <TWOJ-KLUCZ>"},
        method="POST",
    )
    with urllib.request.urlopen(req) as res:
        odpowiedz = json.load(res)
    print(odpowiedz["report"]["status"])
    ```

=== "Node.js"

    ```js
    const res = await fetch("https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report", {
      method: "POST",
      headers: { Authorization: "Bearer <TWOJ-KLUCZ>" },
    });
    const odpowiedz = await res.json();
    console.log(odpowiedz.report.status);
    ```

=== "PowerShell"

    ```powershell
    $naglowki = @{ Authorization = "Bearer <TWOJ-KLUCZ>" }
    $odpowiedz = Invoke-RestMethod -Method Post -Uri "https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report" -Headers $naglowki
    $odpowiedz.report.status
    ```

=== "C#"

    ```csharp
    using System.Net.Http.Headers;
    using System.Text.Json;

    using var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "<TWOJ-KLUCZ>");

    var res = await http.PostAsync("https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report", null);
    var odpowiedz = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
    Console.WriteLine(odpowiedz.RootElement.GetProperty("report").GetProperty("status"));
    ```

**Odpowiedź `202`:** `{ "id": "pkg_7c1e9a2b3d4f5a6b7c8d", "report": { "status": "pending" } }`

| HTTP | `error.code` | Przyczyna | Postępowanie |
|---|---|---|---|
| 404 | `package_not_found` | brak rozsyłki | sprawdzić identyfikator |
| 409 | `package_not_completed` | rozsyłka jeszcze trwa | odczekać do stanu `completed` |

### 5.4. Pobranie raportu: `GET /v1/packages/{id}/report`

**Przeznaczenie.** Wynik doręczenia dla każdego odbiorcy, z jego `clientId`.

=== "curl"

    ```bash
    curl -s https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report \
      -H "Authorization: Bearer <TWOJ-KLUCZ>"
    ```

=== "HTTP"

    ```http
    GET /v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report HTTP/1.1
    Host: <TWOJA-DOMENA>
    Authorization: Bearer <TWOJ-KLUCZ>
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init('https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report');
    curl_setopt_array($ch, [
        CURLOPT_HTTPHEADER => ['Authorization: Bearer <TWOJ-KLUCZ>'],
        CURLOPT_RETURNTRANSFER => true,
    ]);
    $odpowiedz = json_decode(curl_exec($ch), true);
    foreach ($odpowiedz['rows'] as $w) {
        echo $w['to'], ' ', $w['status'], PHP_EOL;
    }
    ```

=== "Python"

    ```python
    import json, urllib.request

    req = urllib.request.Request(
        "https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report",
        headers={"Authorization": "Bearer <TWOJ-KLUCZ>"},
    )
    with urllib.request.urlopen(req) as res:
        odpowiedz = json.load(res)
    for w in odpowiedz["rows"]:
        print(w["to"], w["status"])
    ```

=== "Node.js"

    ```js
    const res = await fetch("https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report", {
      headers: { Authorization: "Bearer <TWOJ-KLUCZ>" },
    });
    const odpowiedz = await res.json();
    for (const w of odpowiedz.rows) console.log(w.to, w.status);
    ```

=== "PowerShell"

    ```powershell
    $naglowki = @{ Authorization = "Bearer <TWOJ-KLUCZ>" }
    $odpowiedz = Invoke-RestMethod -Uri "https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report" -Headers $naglowki
    $odpowiedz.rows | ForEach-Object { "$($_.to) $($_.status)" }
    ```

=== "C#"

    ```csharp
    using System.Net.Http.Headers;
    using System.Text.Json;

    using var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "<TWOJ-KLUCZ>");

    var odpowiedz = JsonDocument.Parse(await http.GetStringAsync("https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report"));
    foreach (var w in odpowiedz.RootElement.GetProperty("rows").EnumerateArray())
        Console.WriteLine(w.GetProperty("to") + " " + w.GetProperty("status"));
    ```

**Odpowiedź `200`** (JSON):

```json
{
  "id": "pkg_7c1e9a2b3d4f5a6b7c8d",
  "report": { "status": "ready", "expiresAt": "2026-08-26T10:35:00.000Z" },
  "rows": [
    { "to": "48601000001", "clientId": null, "miId": "9001", "status": "delivered", "miStatus": 21, "changedAt": "2026-08-26 12:00:00" },
    { "to": "48605000001", "clientId": "faktura-114", "miId": "9002", "status": "failed", "miStatus": 11, "changedAt": "2026-08-26 12:00:01" }
  ]
}
```

Ten sam raport w formacie CSV (separator: średnik; wiersz nagłówka
`numer;identyfikator_klienta;id_multiinfo;status;status_multiinfo;czas`):

=== "curl"

    ```bash
    curl -s "https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report?format=csv" \
      -H "Authorization: Bearer <TWOJ-KLUCZ>" -o raport.csv
    ```

=== "HTTP"

    ```http
    GET /v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report?format=csv HTTP/1.1
    Host: <TWOJA-DOMENA>
    Authorization: Bearer <TWOJ-KLUCZ>
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init('https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report?format=csv');
    curl_setopt_array($ch, [
        CURLOPT_HTTPHEADER => ['Authorization: Bearer <TWOJ-KLUCZ>'],
        CURLOPT_RETURNTRANSFER => true,
    ]);
    file_put_contents('raport.csv', curl_exec($ch));
    ```

=== "Python"

    ```python
    import json, urllib.request

    req = urllib.request.Request(
        "https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report?format=csv",
        headers={"Authorization": "Bearer <TWOJ-KLUCZ>"},
    )
    with urllib.request.urlopen(req) as res, open("raport.csv", "wb") as plik:
        plik.write(res.read())
    ```

=== "Node.js"

    ```js
    import { writeFile } from "node:fs/promises";

    const res = await fetch("https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report?format=csv", {
      headers: { Authorization: "Bearer <TWOJ-KLUCZ>" },
    });
    await writeFile("raport.csv", await res.text());
    ```

=== "PowerShell"

    ```powershell
    $naglowki = @{ Authorization = "Bearer <TWOJ-KLUCZ>" }
    Invoke-WebRequest -Uri "https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report?format=csv" -Headers $naglowki -OutFile raport.csv
    ```

=== "C#"

    ```csharp
    using System.Net.Http.Headers;

    using var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "<TWOJ-KLUCZ>");

    File.WriteAllBytes("raport.csv", await http.GetByteArrayAsync("https://<TWOJA-DOMENA>/v1/packages/pkg_7c1e9a2b3d4f5a6b7c8d/report?format=csv"));
    ```

`changedAt` jest przepisywane z Multiinfo bez przeliczania (czas polski). `status` odbiorcy używa
słownika z rozdziału 7; wartość `null` oznacza, że raport nie objął tego odbiorcy.

| HTTP | `error.code` | Przyczyna | Postępowanie |
|---|---|---|---|
| 404 | `package_not_found` | brak rozsyłki | sprawdzić identyfikator |
| 409 | `report_not_ready` | raport w stanie `none`, `pending` albo `failed`; odpowiedź zawiera `report.status` | przy `pending` powtórzyć po minucie; przy `failed` zamówić ponownie (5.3) |

## 5a. Wiadomości przychodzące

Abonent może odpowiedzieć na SMS-a albo napisać na numer usługi z własnej inicjatywy. Multiinfo
domyślnie kieruje takie wiadomości do swojego panelu WWW; administrator Polkomtel może przełączyć
kierowanie na API (wszystkie wiadomości albo tylko z określonym prefiksem treści). Bramka odbiera
je wtedy sama, bez udziału aplikacji, i przekazuje dwoma kanałami: powiadomieniem
`message.received` (rozdział 6) do każdego klucza, który ma włączony odbiór, oraz do odczytu
opisanego niżej. Odczyt nie wymaga włączonego odbioru - wystarczy, że klucz ma dostęp do usługi.

Bramka pyta Multiinfo o wiadomości tylko z tych usług, dla których odbiór ma włączony choć jeden
czynny klucz z adresem webhooka. Dopóki żaden klucz nie odbiera, wiadomości czekają po stronie
Multiinfo.

Polskie znaki w wiadomościach przychodzących zależą od kodowania, jakie wybrał telefon nadawcy:
przy Unicode (`codingScheme` = `8`, tak wysyłają współczesne telefony, gdy treść zawiera znak
spoza alfabetu GSM) „Zażółć” dociera jako „Zażółć”; przy alfabecie GSM (`codingScheme` = `0`)
Multiinfo zastępuje polskie znaki łacińskimi odpowiednikami („Zazolc”). Wiadomości
wieloczęściowe docierają sklejone.

### 5a.1. Lista: `GET /v1/inbound`

**Przeznaczenie.** Odczyt odebranych wiadomości z usług klucza - do pierwszego zasilenia
aplikacji, do dociągnięcia zaległości po awarii odbiornika webhooków i do sprawdzenia, czy
webhook niczego nie pominął.

=== "curl"

    ```bash
    curl -s "https://<TWOJA-DOMENA>/v1/inbound?since=2026-08-29T00:00:00Z&limit=50" \
      -H "Authorization: Bearer <TWOJ-KLUCZ>"
    ```

=== "HTTP"

    ```http
    GET /v1/inbound?since=2026-08-29T00:00:00Z&limit=50 HTTP/1.1
    Host: <TWOJA-DOMENA>
    Authorization: Bearer <TWOJ-KLUCZ>
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init('https://<TWOJA-DOMENA>/v1/inbound?since=2026-08-29T00:00:00Z&limit=50');
    curl_setopt_array($ch, [
        CURLOPT_HTTPHEADER => ['Authorization: Bearer <TWOJ-KLUCZ>'],
        CURLOPT_RETURNTRANSFER => true,
    ]);
    $odpowiedz = json_decode(curl_exec($ch), true);
    foreach ($odpowiedz['data'] as $w) {
        echo $w['id'], ' ', $w['from'], PHP_EOL;
    }
    ```

=== "Python"

    ```python
    import json, urllib.request

    req = urllib.request.Request(
        "https://<TWOJA-DOMENA>/v1/inbound?since=2026-08-29T00:00:00Z&limit=50",
        headers={"Authorization": "Bearer <TWOJ-KLUCZ>"},
    )
    with urllib.request.urlopen(req) as res:
        odpowiedz = json.load(res)
    for w in odpowiedz["data"]:
        print(w["id"], w["from"])
    ```

=== "Node.js"

    ```js
    const res = await fetch("https://<TWOJA-DOMENA>/v1/inbound?since=2026-08-29T00:00:00Z&limit=50", {
      headers: { Authorization: "Bearer <TWOJ-KLUCZ>" },
    });
    const odpowiedz = await res.json();
    for (const w of odpowiedz.data) console.log(w.id, w.from);
    ```

=== "PowerShell"

    ```powershell
    $naglowki = @{ Authorization = "Bearer <TWOJ-KLUCZ>" }
    $odpowiedz = Invoke-RestMethod -Uri "https://<TWOJA-DOMENA>/v1/inbound?since=2026-08-29T00:00:00Z&limit=50" -Headers $naglowki
    $odpowiedz.data | ForEach-Object { "$($_.id) $($_.from)" }
    ```

=== "C#"

    ```csharp
    using System.Net.Http.Headers;
    using System.Text.Json;

    using var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "<TWOJ-KLUCZ>");

    var odpowiedz = JsonDocument.Parse(await http.GetStringAsync("https://<TWOJA-DOMENA>/v1/inbound?since=2026-08-29T00:00:00Z&limit=50"));
    foreach (var w in odpowiedz.RootElement.GetProperty("data").EnumerateArray())
        Console.WriteLine(w.GetProperty("id") + " " + w.GetProperty("from"));
    ```

Parametry zapytania (wszystkie opcjonalne):

| Parametr | Opis |
|---|---|
| `serviceId` | jedna z usług klucza; inna daje `403 service_not_allowed` |
| `from` | numer nadawcy w dowolnym zapisie (`+48 601 000 001`, `601000001`); bramka sprowadza go do postaci, w jakiej zapisała nadawcę |
| `since`, `until` | zakres czasu odbioru przez Multiinfo, ISO 8601; zła data daje `400 invalid_query` |
| `limit` | liczba wyników, domyślnie 25, najwyżej 200 |
| `offset` | liczba pominiętych wyników od początku listy |

**Odpowiedź `200`:** `{ "data": [ ... ], "hasMore": true }` - obiekty jak w 5a.2, od najnowszej.

### 5a.2. Jedna wiadomość: `GET /v1/inbound/{id}`

=== "curl"

    ```bash
    curl -s https://<TWOJA-DOMENA>/v1/inbound/in_5c1d9e2b7a3f4d8e6b0a \
      -H "Authorization: Bearer <TWOJ-KLUCZ>"
    ```

=== "HTTP"

    ```http
    GET /v1/inbound/in_5c1d9e2b7a3f4d8e6b0a HTTP/1.1
    Host: <TWOJA-DOMENA>
    Authorization: Bearer <TWOJ-KLUCZ>
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init('https://<TWOJA-DOMENA>/v1/inbound/in_5c1d9e2b7a3f4d8e6b0a');
    curl_setopt_array($ch, [
        CURLOPT_HTTPHEADER => ['Authorization: Bearer <TWOJ-KLUCZ>'],
        CURLOPT_RETURNTRANSFER => true,
    ]);
    $odpowiedz = json_decode(curl_exec($ch), true);
    echo $odpowiedz['from'];
    ```

=== "Python"

    ```python
    import json, urllib.request

    req = urllib.request.Request(
        "https://<TWOJA-DOMENA>/v1/inbound/in_5c1d9e2b7a3f4d8e6b0a",
        headers={"Authorization": "Bearer <TWOJ-KLUCZ>"},
    )
    with urllib.request.urlopen(req) as res:
        odpowiedz = json.load(res)
    print(odpowiedz["from"])
    ```

=== "Node.js"

    ```js
    const res = await fetch("https://<TWOJA-DOMENA>/v1/inbound/in_5c1d9e2b7a3f4d8e6b0a", {
      headers: { Authorization: "Bearer <TWOJ-KLUCZ>" },
    });
    const odpowiedz = await res.json();
    console.log(odpowiedz.from);
    ```

=== "PowerShell"

    ```powershell
    $naglowki = @{ Authorization = "Bearer <TWOJ-KLUCZ>" }
    $odpowiedz = Invoke-RestMethod -Uri "https://<TWOJA-DOMENA>/v1/inbound/in_5c1d9e2b7a3f4d8e6b0a" -Headers $naglowki
    $odpowiedz.from
    ```

=== "C#"

    ```csharp
    using System.Net.Http.Headers;
    using System.Text.Json;

    using var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "<TWOJ-KLUCZ>");

    var odpowiedz = JsonDocument.Parse(await http.GetStringAsync("https://<TWOJA-DOMENA>/v1/inbound/in_5c1d9e2b7a3f4d8e6b0a"));
    Console.WriteLine(odpowiedz.RootElement.GetProperty("from"));
    ```

**Odpowiedź `200`:**

```json
{
  "id": "in_5c1d9e2b7a3f4d8e6b0a",
  "serviceId": "24138",
  "from": "48601000001",
  "to": "7968",
  "kind": "text",
  "text": "Dziekuje, wszystko jasne",
  "receivedAt": "2026-08-29T07:14:00.000Z",
  "relatedMessageId": "msg_3f9c2a7b1e4d8c6a5b2f",
  "protocolId": 0,
  "codingScheme": 0,
  "createdAt": "2026-08-29T07:14:02.000Z"
}
```

| Pole | Znaczenie |
|---|---|
| `from` | numer nadawcy; numer krótki albo nietypowy przepisany bez zmian |
| `to` | numer usługi, na który wiadomość przyszła |
| `kind` | `text` albo `binary`; przy `binary` zamiast `text` jest `hex` (dane szesnastkowe od Multiinfo, bez interpretacji) |
| `text` / `hex` | treść; brak obu pól, gdy konto Multiinfo ma wyłączone przechowywanie treści - wtedy treść jest tylko w powiadomieniu `message.received`, a tu zamiast niej `bodyHash` |
| `bodyHash` | SHA-256 treści (szesnastkowo), tylko gdy `text`/`hex` nie występują; pozwala dopasować odczyt do treści dostarczonej powiadomieniem |
| `receivedAt` | chwila odbioru przez Multiinfo (czas polski przeliczony na UTC) |
| `relatedMessageId` | identyfikator ostatniej wiadomości wysłanej z tej samej usługi na numer nadawcy w ciągu 48 godzin; podpowiedź kontekstu, nie stwierdzenie - Multiinfo nie przekazuje, na co abonent odpowiada, więc na numerze, na który aplikacja wysyła regularnie, pole będzie wypełnione także wtedy, gdy SMS nie jest odpowiedzią; `null`, gdy brak |
| `protocolId`, `codingScheme` | parametry protokołu SMS przepisane z Multiinfo; `protocolId` dla zwykłego tekstu `0`, `codingScheme` `0` dla alfabetu GSM i `8` dla Unicode (UCS-2, z zachowanymi polskimi znakami) |

| HTTP | `error.code` | Przyczyna | Postępowanie |
|---|---|---|---|
| 404 | `inbound_not_found` | brak wiadomości albo wiadomość z usługi spoza klucza | sprawdzić identyfikator z powiadomienia |

### 5a.3. Odpowiedź w wątku

`POST /v1/messages` z polem `inReplyTo` wysyła odpowiedź powiązaną z wiadomością przychodzącą:
bramka przekazuje Multiinfo identyfikator tej wiadomości (`smsInId`), a `GET /v1/messages/{id}`
i powiadomienia o tej wysyłce zwracają `inReplyTo`. Wiadomość przychodząca musi pochodzić
z tej samej usługi, z której idzie odpowiedź, a odpowiedź ma jednego odbiorcę - nadawcę tej
wiadomości (pole `from` z `message.received`).

=== "curl"

    ```bash
    curl -s -X POST https://<TWOJA-DOMENA>/v1/messages \
      -H "Authorization: Bearer <TWOJ-KLUCZ>" -H "Content-Type: application/json" \
      -d '{ "to": "48601000001", "text": "Dziekujemy za potwierdzenie.", "inReplyTo": "in_5c1d9e2b7a3f4d8e6b0a" }'
    ```

=== "HTTP"

    ```http
    POST /v1/messages HTTP/1.1
    Host: <TWOJA-DOMENA>
    Authorization: Bearer <TWOJ-KLUCZ>
    Content-Type: application/json

    {"to": "48601000001", "text": "Dziekujemy za potwierdzenie.", "inReplyTo": "in_5c1d9e2b7a3f4d8e6b0a"}
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init('https://<TWOJA-DOMENA>/v1/messages');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode([
            'to' => '48601000001',
            'text' => 'Dziekujemy za potwierdzenie.',
            'inReplyTo' => 'in_5c1d9e2b7a3f4d8e6b0a',
        ]),
        CURLOPT_HTTPHEADER => ['Authorization: Bearer <TWOJ-KLUCZ>', 'Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
    ]);
    $odpowiedz = json_decode(curl_exec($ch), true);
    echo $odpowiedz['id'];
    ```

=== "Python"

    ```python
    import json, urllib.request

    req = urllib.request.Request(
        "https://<TWOJA-DOMENA>/v1/messages",
        data=json.dumps({"to": "48601000001", "text": "Dziekujemy za potwierdzenie.", "inReplyTo": "in_5c1d9e2b7a3f4d8e6b0a"}).encode(),
        headers={"Authorization": "Bearer <TWOJ-KLUCZ>", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as res:
        odpowiedz = json.load(res)
    print(odpowiedz["id"])
    ```

=== "Node.js"

    ```js
    const res = await fetch("https://<TWOJA-DOMENA>/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer <TWOJ-KLUCZ>", "Content-Type": "application/json" },
      body: JSON.stringify({"to": "48601000001", "text": "Dziekujemy za potwierdzenie.", "inReplyTo": "in_5c1d9e2b7a3f4d8e6b0a"}),
    });
    const odpowiedz = await res.json();
    console.log(odpowiedz.id);
    ```

=== "PowerShell"

    ```powershell
    $naglowki = @{ Authorization = "Bearer <TWOJ-KLUCZ>" }
    $body = @{ to = "48601000001"; text = "Dziekujemy za potwierdzenie."; inReplyTo = "in_5c1d9e2b7a3f4d8e6b0a" } | ConvertTo-Json
    $odpowiedz = Invoke-RestMethod -Method Post -Uri "https://<TWOJA-DOMENA>/v1/messages" -Headers $naglowki -ContentType "application/json; charset=utf-8" -Body $body
    $odpowiedz.id
    ```

=== "C#"

    ```csharp
    using System.Text;
    using System.Net.Http.Headers;
    using System.Text.Json;

    using var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "<TWOJ-KLUCZ>");

    var tresc = new StringContent("""{"to": "48601000001", "text": "Dziekujemy za potwierdzenie.", "inReplyTo": "in_5c1d9e2b7a3f4d8e6b0a"}""", Encoding.UTF8, "application/json");
    var res = await http.PostAsync("https://<TWOJA-DOMENA>/v1/messages", tresc);
    var odpowiedz = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
    Console.WriteLine(odpowiedz.RootElement.GetProperty("id"));
    ```

## 6. Powiadomienia webhook

Webhook to mechanizm powiadomień zwrotnych: aplikacja udostępnia adres HTTP, a bramka wysyła
na niego żądanie `POST` przy każdej zmianie stanu - wysłaniu, doręczeniu, niepowodzeniu,
zakończeniu rozsyłki - oraz przy odebraniu SMS-a od abonenta. Dzięki temu aplikacja nie musi cyklicznie odpytywać bramki o stan każdej
wiadomości. Adres i sekret ustawia administrator bramki przy kluczu API; sekret służy do
weryfikacji, że żądanie pochodzi od bramki.

Każde żądanie zawiera nagłówki:

| Nagłówek | Wartość |
|---|---|
| `Content-Type` | `application/json` |
| `X-MIG-Event` | `message.sent`, `message.delivered`, `message.failed`, `package.completed` albo `message.received` |
| `X-MIG-Timestamp` | czas uniksowy w sekundach, użyty do obliczenia podpisu |
| `X-MIG-Signature` | `sha256=<hex>`, gdzie `<hex>` to HMAC-SHA256 z sekretu obliczony z ciągu `<X-MIG-Timestamp>.<body żądania>` |

### 6.1. Weryfikacja podpisu

Podpis oblicza się z **surowego body żądania**, bajt po bajcie, przed parsowaniem JSON -
jakakolwiek zmiana body (nawet białych znaków) unieważnia podpis. Porównanie podpisów powinno
odbywać się w stałym czasie (`hash_equals` w PHP, `timingSafeEqual` w Node.js), a znaczniki czasu
starsze niż kilka minut należy odrzucać, co uniemożliwia odtworzenie przechwyconego żądania.

Implementacja w PHP - zawartość pliku `examples/php/lib/webhook.php`, gotowa do skopiowania:

```php
<?php
declare(strict_types=1);

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
```

Użycie w odbiorniku (pełna wersja w `examples/php/webhook.php`):

```php
$raw = (string) file_get_contents('php://input');
try {
    $event = verifyWebhook($raw, getallheaders(), $config['WEBHOOK_SECRET']);
} catch (WebhookRejected $ex) {
    http_response_code(401);
    exit;
}
// przetwarzanie $event['id'], $event['status'] ...
http_response_code(204);
```

Implementacja w Node.js:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, headers, rawBody) {
  const expected = `sha256=${createHmac('sha256', secret)
    .update(`${headers['x-mig-timestamp']}.${rawBody}`).digest('hex')}`;
  const given = headers['x-mig-signature'] ?? '';
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

### 6.2. Zdarzenia

Body każdego zdarzenia zawiera pola `event`, `at` (czas zdarzenia, ISO 8601) i `id` obiektu,
a ponadto:

| Zdarzenie | Pola dodatkowe |
|---|---|
| `message.sent` | `status: "sent"`, `to`, `parts` - Multiinfo przyjęło wiadomość do wysyłki |
| `message.delivered` | `status: "delivered"`, `to`, `miStatus`, `miSubstatus`, `error: null` |
| `message.failed` | `status` (`failed`, `blocked`, `expired` albo `cancelled`), `to`, `error`; przy odmowie Multiinfo `providerCode`, przy raporcie doręczenia `miStatus` i `miSubstatus` |
| `package.completed` | `recipients`, `status` (`completed`, `failed`, `cancelled`); po pobraniu raportu `report: "ready"` i `summary`, przy nieudanym raporcie `report: "failed"`; przy odmowie `providerCode` i `error` |
| `message.received` | `serviceId`, `from`, `to`, `kind`, `text` albo `hex`, `receivedAt`, `relatedMessageId` - pola jak w 5a.2; `id` to identyfikator wiadomości przychodzącej `in_...` |

Powiadomienia o wysyłce będącej odpowiedzią w wątku (5a.3) zawierają dodatkowo pole `inReplyTo`.

Przykład `message.delivered`:

```json
{ "event": "message.delivered", "at": "2026-08-26T10:00:12.000Z", "id": "msg_3f9c2a7b1e4d8c6a5b2f",
  "status": "delivered", "to": "48601000001", "miStatus": 21, "miSubstatus": 0, "error": null }
```

Przykład `message.received`:

```json
{ "event": "message.received", "at": "2026-08-29T07:14:02.000Z", "id": "in_5c1d9e2b7a3f4d8e6b0a",
  "serviceId": "24138", "from": "48601000001", "to": "7968", "kind": "text",
  "text": "Dziekuje, wszystko jasne", "receivedAt": "2026-08-29T07:14:00.000Z",
  "relatedMessageId": "msg_3f9c2a7b1e4d8c6a5b2f" }
```

Powiadomienie `message.received` zawiera treść zawsze, także gdy konto nie przechowuje treści -
to jedyna chwila, w której aplikacja może ją dostać. Odbiór włącza się dla klucza w panelu (pole
„Odbiera wiadomości przychodzące”); kilka kluczy z dostępem do tej samej usługi może odbierać
jednocześnie, każdy dostaje własne powiadomienie.

### 6.3. Ponowienia i kolejność

Odpowiedź aplikacji z kodem `2xx` oznacza dostarczenie. Odpowiedź `4xx` kończy dostawę bez
ponowień - w ten sposób aplikacja sygnalizuje, że zdarzenie zostało świadomie odrzucone (np.
z powodu błędnego podpisu). Odpowiedź `5xx`, brak odpowiedzi w ciągu 10 sekund i błędy sieci
powodują ponowienie po 1 minucie, 5 minutach, 15 minutach, 1 godzinie i 6 godzinach. Po
wyczerpaniu ponowień zdarzenie jest oznaczane jako niedostarczone i widoczne na ekranie przeglądu
w panelu bramki, a administrator może je ponowić z panelu (szczegół wiadomości albo odebranej,
przycisk „Ponów”) - takie zdarzenie przychodzi z nowym podpisem i bieżącym `at`. Bramka nie podąża za przekierowaniami HTTP - podany adres musi odpowiadać
bezpośrednio.

Kolejność dostarczania nie jest gwarantowana: przy ponowieniach `message.delivered` może dotrzeć
przed `message.sent`. O kolejności zdarzeń rozstrzyga pole `at`.

Dla `message.received` obowiązuje ta sama zasada co dla statusów: wiadomość jest zapisana
w bramce przed pierwszą próbą dostawy, więc po awarii aplikacja dociąga zaległość
z `GET /v1/inbound?since=` (5a.1).

Adres webhooka musi wskazywać adres publiczny. Bramka sprawdza cel przy zapisie adresu w panelu
i przed każdą dostawą: adres literalny albo nazwę rozwiązującą się na pętlę zwrotną, sieć
prywatną (`10/8`, `172.16/12`, `192.168/16`), link-local albo sieć kontenerów odrzuca bez
ponowień, a w panelu nie pozwala go zapisać. Aplikacja działająca na tym samym serwerze co
bramka (np. przykład PHP z `examples/php`) wymaga jawnej zgody administratora: zmiennej
`MIG_WEBHOOK_ALLOW_PRIVATE=1` w środowisku bramki (`docs/uruchomienie.md`, rozdział 7.7).
Nazwa, której nie da się rozwiązać, jest przy zapisie błędem formularza, a przy dostawie
traktowana jak awaria sieci - z ponowieniami według harmonogramu wyżej.

## 7. Słownik statusów wiadomości

| `status` | Znaczenie | Zalecane postępowanie |
|---|---|---|
| `queued` | przyjęta; oczekuje w kolejce bramki albo w Multiinfo na rozpoczęcie wysyłki | brak |
| `sent` | przekazana do sieci; raport doręczenia jeszcze nie nadszedł albo nie był zamawiany | oczekiwać na `delivered` |
| `delivered` | raport doręczenia potwierdził odbiór wszystkich części | brak |
| `failed` | Multiinfo odrzuciło wiadomość albo doręczenie nie powiodło się | sprawdzić `providerCode` i `error`, usunąć przyczynę, wysłać ponownie |
| `expired` | upłynął termin ważności bez stanu ostatecznego (telefon wyłączony, poza zasięgiem) albo Multiinfo nie podało stanu ostatecznego przez siedem dni od przekazania | wysłać ponownie, jeżeli treść pozostaje aktualna |
| `cancelled` | anulowana wywołaniem `POST .../cancel` | brak |
| `blocked` | numer nadawcy albo odbiorcy na liście blokad operatora | nie ponawiać; kolejne próby będą blokowane |
| `throttled` | Multiinfo wstrzymało wysyłkę limitem operatora | brak; bramka odpytuje dalej, stan zmieni się samoczynnie |
| `unknown` | Multiinfo zwróciło status spoza dokumentacji | brak; bramka odpytuje dalej; jeżeli stan utrzymuje się godzinami, zgłosić administratorowi |

## 8. Limity

| Limit | Wartość | Skutek przekroczenia |
|---|---|---|
| Liczba części jednej wiadomości | 1-9, ustawiana przy kluczu | `400 too_many_parts`; `message` podaje, ile miejsc usunąć |
| Żądania na minutę | ustawiana przy kluczu | `429 rate_limited`; bramka nie wysyła nagłówka `Retry-After`, należy odczekać minutę |
| Ważność klucza | data przy kluczu | `401 expired_api_key`; przedłuża administrator |
| Ważność wiadomości (`validTo`) | do 72 godzin od przyjęcia | `400 valid_to_too_far` |
| Odbiorcy jednej rozsyłki | 5000 | `400 invalid_body` |
| Numery w tablicy `to` | 500 | `400 invalid_body` |
| Rozmiar body żądania | 512 KB | odpowiedź `413` bez pola `error.code` |

## 9. Zestawienie błędów

Każda odpowiedź błędu ma postać `{ "error": { "code": "...", "message": "...", "providerCode": ... } }`.
Pole `providerCode` występuje tylko przy błędach pochodzących z Multiinfo. Pole `message` jest
zredagowane po polsku z myślą o dzienniku aplikacji, nie o wyświetlaniu użytkownikowi końcowemu.

| HTTP | `error.code` | Przyczyna | Postępowanie |
|---|---|---|---|
| 400 | `invalid_body` | body nie przechodzi walidacji; `message` wymienia pola | poprawić wskazane pola |
| 400 | `invalid_phone` | numer nie daje się znormalizować: znaki inne niż cyfry, zła liczba cyfr, podwojony kod kraju (`4848…`); `message` podaje powód | podać numer w postaci `48601000001` |
| 400 | `invalid_orig` | nadpis pusty, dłuższy niż 11 znaków albo ze znakami sterującymi | użyć nadpisu ze słownika konta |
| 400 | `invalid_client_id` | `clientId` odbiorcy rozsyłki poza wzorcem | do 20 znaków: litery, cyfry, `.`, `_`, `-` |
| 400 | `text_required` | odbiorca rozsyłki bez treści własnej i domyślnej | dodać `defaultText` albo `text` |
| 400 | `too_many_parts` | treść przekracza limit części; `message` podaje, ile miejsc usunąć | skrócić treść |
| 400 | `service_required` | klucz bez usługi domyślnej, `serviceId` nie podano | podać `serviceId` |
| 400 | `valid_to_in_past`, `valid_to_too_far` | `validTo` w przeszłości albo dalej niż 72 godziny | poprawić `validTo` |
| 400 | `start_at_in_past` | `startAt` rozsyłki w przeszłości | poprawić `startAt` albo pominąć |
| 400 | `in_reply_to_unknown` | `inReplyTo` wskazuje wiadomość, której nie ma w tej usłudze | użyć identyfikatora z `message.received` tej samej usługi |
| 400 | `in_reply_to_single` | `inReplyTo` razem z listą odbiorców | jeden odbiorca |
| 400 | `in_reply_to_recipient` | odbiorca odpowiedzi to nie nadawca wskazanej wiadomości | w `to` podać `from` z `message.received` |
| 400 | `invalid_query` | `since` albo `until` nie są datami ISO 8601, albo parametr zapytania podano więcej niż raz | poprawić parametry zapytania |
| 401 | `missing_api_key`, `invalid_api_key`, `revoked_api_key`, `expired_api_key` | brak, nieprawidłowy, odwołany albo wygasły klucz | rozdział 2 |
| 403 | `service_not_allowed` | usługa spoza uprawnień klucza | użyć usługi przypisanej do klucza |
| 403 | `orig_not_allowed` | nadpis spoza uprawnień klucza; `message` wymienia dozwolone | użyć jednego z wymienionych |
| 404 | `message_not_found`, `package_not_found`, `inbound_not_found` | brak obiektu albo obiekt innego klucza | sprawdzić identyfikator |
| 409 | `idempotency_conflict` | ten sam `Idempotency-Key` z inną treścią wiadomości albo numerem | użyć nowego klucza idempotencji |
| 409 | `already_final`, `already_passed` | anulowanie niemożliwe (4.3) | brak |
| 409 | `package_not_completed`, `report_not_ready` | raport rozsyłki jeszcze niedostępny | powtórzyć po minucie |
| 429 | `rate_limited` | przekroczony limit żądań klucza na minutę | odczekać minutę |
| 500 | `internal`, `account_missing` | błąd wewnętrzny bramki | zgłosić administratorowi z czasem wystąpienia i identyfikatorem obiektu |
| 502 | `provider_error` | błąd Multiinfo przy wywołaniu synchronicznym; `providerCode` w body odpowiedzi | ponowić po chwili; przy powtarzaniu przekazać `providerCode` administratorowi |
| 503 | `account_certificate` | Multiinfo odrzuciło certyfikat bramki | przekazać administratorowi |

Odmowy Multiinfo przy wysyłce asynchronicznej nie są kodami HTTP: pojawiają się w polach
`status`, `providerCode` i `error` wiadomości (`GET /v1/messages/{id}`) oraz w powiadomieniu
`message.failed`.

## 10. Stan bramki: `GET /healthz`

Wywołanie bez klucza. Odpowiedź `{ "status": "ok" }` albo `{ "status": "degraded" }`; stan
`degraded` oznacza, że któreś konto Multiinfo jest wstrzymane, jego certyfikat wygasa w ciągu
siedmiu dni albo odbiór wiadomości przychodzących z którejś usługi zatrzymał się na błędzie
Multiinfo (np. `-24`, usługa nieaktywna) - wysyłka albo odbiór mogą nie działać, a administrator
widzi przyczynę w panelu (na karcie konta). Wywołanie nadaje
się do monitoringu zewnętrznego (np. sprawdzenie co minutę z alarmem po dwóch kolejnych
niepowodzeniach).

=== "curl"

    ```bash
    curl -s https://<TWOJA-DOMENA>/healthz
    ```

=== "HTTP"

    ```http
    GET /healthz HTTP/1.1
    Host: <TWOJA-DOMENA>
    ```

=== "PHP"

    ```php
    <?php
    $ch = curl_init('https://<TWOJA-DOMENA>/healthz');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
    ]);
    $odpowiedz = json_decode(curl_exec($ch), true);
    echo $odpowiedz['status'];
    ```

=== "Python"

    ```python
    import json, urllib.request

    req = urllib.request.Request(
        "https://<TWOJA-DOMENA>/healthz",
    )
    with urllib.request.urlopen(req) as res:
        odpowiedz = json.load(res)
    print(odpowiedz["status"])
    ```

=== "Node.js"

    ```js
    const res = await fetch("https://<TWOJA-DOMENA>/healthz");
    const odpowiedz = await res.json();
    console.log(odpowiedz.status);
    ```

=== "PowerShell"

    ```powershell
    $odpowiedz = Invoke-RestMethod -Uri "https://<TWOJA-DOMENA>/healthz"
    $odpowiedz.status
    ```

=== "C#"

    ```csharp
    using System.Text.Json;

    using var http = new HttpClient();

    var odpowiedz = JsonDocument.Parse(await http.GetStringAsync("https://<TWOJA-DOMENA>/healthz"));
    Console.WriteLine(odpowiedz.RootElement.GetProperty("status"));
    ```
