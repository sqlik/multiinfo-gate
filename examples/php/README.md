# Przykład integracji w PHP

Jedna strona do wysłania SMS-a i rozsyłki przez bramkę oraz odbiornik webhooków. To narzędzie testowe
i wzorzec kodu do skopiowania - nie produkt. **Nie wystawiaj go do internetu.**

Wymagania: PHP 8.3 lub nowszy z rozszerzeniami `curl`, `json`, `mbstring`. Bez Composera, bez bazy.

## Uruchomienie w pięciu krokach

1. Skopiuj konfigurację: `cp config.example.php config.php`
2. W `config.php` wpisz `GATE_URL` (adres API bramki), `API_KEY` (klucz z panelu) i `WEBHOOK_SECRET`
   (sekret pokazany razem z kluczem; jeśli klucz nie ma webhooka, zostaw pusty)
3. Uruchom wbudowany serwer PHP z katalogu `examples/php`: `php -S 127.0.0.1:9000`
4. Otwórz `http://127.0.0.1:9000/` i wyślij SMS na numer testowy
5. W panelu bramki, przy kluczu, wpisz adres webhooka (niżej) - zdarzenia pojawią się w sekcji „Odebrane webhooki”

## Adres webhooka

Bramka musi dosięgnąć `webhook.php` po sieci. Trzy przypadki:

| Gdzie stoi bramka | Adres do wpisania przy kluczu |
|---|---|
| ten sam komputer, bramka bez Dockera | `http://127.0.0.1:9000/webhook.php` |
| ten sam serwer, bramka w Dockerze | `http://<ADRES-HOSTA-Z-KONTENERA>:9000/webhook.php`, patrz niżej |
| osobne maszyny | publiczny adres serwera PHP, po HTTPS, np. `https://sklep.example/mig/webhook.php` |

Adres hosta widziany z kontenera to brama sieci Compose; bywa `172.17.0.1` albo `172.18.0.1` - sprawdź:

    docker network inspect $(docker network ls --filter name=docker_default -q) --format '{{(index .IPAM.Config 0).Gateway}}'

Serwer PHP musi wtedy nasłuchiwać na tym adresie, nie tylko na pętli zwrotnej: `php -S 0.0.0.0:9000`
(tylko na czas testów; zapora serwera nie może wpuszczać portu 9000 z zewnątrz).

Dwa pierwsze przypadki to adresy w sieci wewnętrznej. Bramka domyślnie ich nie woła i nie
pozwala zapisać w panelu - trzeba w jej środowisku ustawić `MIG_WEBHOOK_ALLOW_PRIVATE=1`
(`docker/.env`, opis w `docs/uruchomienie.md`, rozdział 7.7), a potem uruchomić bramkę ponownie.

## Wiadomości od abonentów

Gdy przy kluczu w panelu bramki zaznaczono „Odbiera wiadomości przychodzące”, każdy SMS od abonenta
przychodzi zdarzeniem `message.received` na `webhook.php` i trafia do `data/odebrane.jsonl`. Sekcja
„Odebrane SMS-y” na stronie pokazuje te wpisy z formularzem odpowiedzi w wierszu: odpowiedź idzie
przez `sendMessage()` z parametrem `$inReplyTo`, więc bramka przekazuje Multiinfo identyfikator
wiadomości, na którą odpisujesz. Przycisk „Dociągnij z bramki” woła `listInbound()` i dopisuje
do dziennika wiadomości, których jeszcze w nim nie ma - tak aplikacja odzyskuje zaległość, gdy
odbiornik webhooków był niedostępny.

## Pliki

| Plik | Rola |
|---|---|
| `lib/gate.php` | klasa `MultiinfoGate` - wywołania API (także `listInbound()`, `getInbound()`), błędy jako `GateException` |
| `lib/webhook.php` | `verifyWebhook()` - podpis HMAC, tolerancja czasu 300 s; `inboundEntry()` - wiersz odebranej |
| `lib/store.php` | zapis i odczyt plików jsonl w `data/` |
| `index.php` | formularze i listy |
| `webhook.php` | odbiornik zdarzeń |
| `tests/webhook.test.php`, `test.sh` | testy: `sh test.sh` |

## Bezpieczeństwo

- Token CSRF w sesji na każdym formularzu; każdy wypis przez `e()` (`htmlspecialchars`)
- `data/` zawiera `.htaccess` z `Require all denied` (Apache); dla nginx dodaj
  `location ~ ^/data/ { deny all; }` w bloku serwera - albo ustaw `DATA_DIR` poza katalogiem WWW;
  wbudowany serwer `php -S` nie czyta `.htaccess` i wyda pliki z `data/` każdemu, dlatego ma słuchać tylko na `127.0.0.1`
- `config.php` i `data/` są w `.gitignore` repozytorium - klucz nie trafi do historii
