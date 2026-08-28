# Uruchomienie bramki krok po kroku

Instrukcja prowadzi od przygotowań po stronie Multiinfo, przez instalację bramki na serwerze
i pierwszą wysyłkę, do wystawienia API pod własną domeną. Zakłada, że czytelnik potrafi
zalogować się na serwer przez SSH i wkleić polecenie do terminala; wszystkie pozostałe pojęcia
(Docker, tunel SSH, odwrotne proxy, certyfikat HTTPS) są objaśnione w miejscu, w którym się
pojawiają.

Konwencje:

- Wartości do podstawienia zapisano w nawiasach ostrych: `<ADRES-SERWERA>`, `<TWOJA-DOMENA>`,
  `<TWOJ-KLUCZ>`. Pozostałą część polecenia należy wkleić bez zmian.
- Polecenia poprzedzone `sudo` wykonują się z uprawnieniami administratora; system może
  poprosić o hasło użytkownika
- Każdy krok podaje polecenie, oczekiwany wynik i sposób postępowania, gdy wynik jest inny

Czas wykonania: około godziny, nie licząc oczekiwania na podpisanie certyfikatu i uruchomienie
nadpisów przez Polkomtel (od kilku godzin do kilku dni).

## 1. Przygotowanie po stronie Multiinfo

Bramka korzysta z konta Multiinfo jak każda inna aplikacja kliencka: potrzebuje użytkownika
API z certyfikatem i identyfikatora usługi; opcjonalnie także nadpisów nadawcy. Wszystkie te
elementy są realizowane w panelu Multiinfo i z opiekunem technicznym Polkomtela, zanim bramka
zostanie zainstalowana. Bez podpisanego certyfikatu nie da się sprawdzić połączenia, więc obieg
certyfikatu warto rozpocząć jako pierwszy.

### 1.1. Użytkownik API

W panelu Multiinfo (administrator konta) należy utworzyć użytkownika API - osobnego od
użytkowników logujących się do panelu. Do bramki trafią jego login i hasło.

Login użytkownika API ma jedno dodatkowe znaczenie: certyfikat z punktu 1.2 musi mieć w polu
**CN (Common Name) dokładnie ten login**. Multiinfo porównuje oba pola przy każdym połączeniu
i przy niezgodności odrzuca wysyłkę kodem `-85`. Login warto więc ustalić przed wygenerowaniem
certyfikatu i nie zmieniać go później.

### 1.2. Certyfikat użytkownika API

Multiinfo uwierzytelnia aplikację certyfikatem klienckim, który wystawia Polkomtel. Obieg jest
następujący:

1. **Pobranie instrukcji.** W panelu bramki, na formularzu dodawania konta Multiinfo, znajduje
   się odnośnik do archiwum ZIP z instrukcjami Polkomtela (adres:
   `https://plk-assets.s3.pl-waw.scw.cloud/certyfikaty-multiinfo.zip`). Archiwum zawiera trzy
   równoważne instrukcje generowania certyfikatu - wystarczy jedna, dobrana do własnego
   środowiska:
   - `Multiinfo_-_Dokumentacja_Generowanie_certyfikatu_OpenSSL.txt` - z wiersza poleceń
     (Linux, macOS, Windows z zainstalowanym OpenSSL)
   - `Multiinfo_-_Dokumentacja_Generowanie_certyfikatu_Win10.pdf` - narzędziami systemu Windows 10
   - `Multiinfo_-_Dokumentacja_Generowanie_certyfikatu_XCA.pdf` - programem XCA z interfejsem
     graficznym
2. **Wygenerowanie certyfikatu.** Zgodnie z wybraną instrukcją generuje się klucz prywatny
   i certyfikat. W polu CN należy wpisać login użytkownika API z punktu 1.1, a w polu adresu
   e-mail - adres, na który Polkomtel ma odesłać podpisany certyfikat.
3. **Wysłanie do Polkomtela.** Wygenerowany certyfikat wysyła się pocztą elektroniczną na adres
   podany w instrukcji. Polkomtel podpisuje go swoim urzędem certyfikacji i odsyła na adres
   e-mail wpisany w certyfikacie.
4. **Utworzenie pliku `.p12` / `.pfx`.** Po otrzymaniu podpisanego certyfikatu należy - według
   dalszej części tej samej instrukcji - połączyć go z kluczem prywatnym w jeden plik chroniony
   hasłem. Instrukcje Polkomtela kończą się plikiem z rozszerzeniem `.p12`; jest to ten sam format
   co `.pfx` (PKCS#12) - różni się wyłącznie rozszerzeniem, żadna konwersja nie jest potrzebna.
   Bramka przyjmuje plik z obydwoma rozszerzeniami. Ten plik i hasło do niego wgrywa się do bramki
   (rozdział 4.2). Bramka odczytuje z pliku podmiot (CN), wystawcę, odcisk SHA-1 i daty ważności,
   a klucz prywatny zapisuje zaszyfrowany.

   Jeżeli z jakiegoś powodu potrzebny jest plik o rozszerzeniu `.pfx` (np. wymaga tego inne
   narzędzie), wystarczy zmienić nazwę - na Linuksie i macOS:

   ```bash
   cp certyfikat.p12 certyfikat.pfx
   ```

   a w systemie Windows przez zmianę nazwy pliku w Eksploratorze. Plik po zmianie nazwy otwiera
   się tym samym hasłem.
5. **Wpisanie danych certyfikatu w panelu Multiinfo.** Po wgraniu pliku do bramki należy
   zalogować się do panelu Multiinfo, otworzyć edycję użytkownika API i w zakładce
   **Uwierzytelnianie** wpisać trzy wartości odczytane przez bramkę: podmiot (CN), wystawcę
   i odcisk SHA-1. Data ważności uzupełnia się w panelu Multiinfo sama po pierwszym udanym
   połączeniu.

Do czasu wykonania punktu 5 każde połączenie bramki z Multiinfo kończy się jednym z kodów
`-80` do `-86` (certyfikat nierozpoznany). Bramka reaguje na to wstrzymaniem konta - opisano to
w rozdziale 7.

Certyfikat ma ograniczony okres ważności. Panel bramki ostrzega 30 dni przed jego upływem;
wymiana przebiega tym samym obiegiem (rozdział 7).

### 1.3. Identyfikator usługi

Każda wysyłka jest przypisana do usługi (`serviceId`) - liczby nadanej przez Polkomtel. Identyfikator
usługi można odczytać w panelu Multiinfo albo uzyskać od opiekuna technicznego Polkomtela. Jedno
konto może mieć kilka usług; bramka pozwala wpisać wszystkie i ogranicza każdy klucz API do
wybranych. Wysyłka z nieznanym identyfikatorem kończy się kodem `-24`.

### 1.4. Nadpisy nadawcy

Nadpis nadawcy to tekst wyświetlany na telefonie odbiorcy w miejscu numeru (np. `Firma Info`).
Nadpis jest opcjonalny: wiadomość wysłana bez nadpisu ma jako nadawcę numer przydzielony do konta
w Multiinfo. Bramka obsługuje oba przypadki - pole `orig` w żądaniu można pominąć, a konto i klucz
mogą nie mieć nadpisu domyślnego; bramka nie przekazuje wtedy parametru `orig` do Multiinfo.
O nadawcy widocznym na telefonie decyduje ostatecznie konfiguracja użytkownika API po stronie
Multiinfo (zakładka Nadpisy: „Domyślny nadpis” i „Wymuś wybrany nadpis”), która ma pierwszeństwo
przed parametrem `orig`. Nadawcę zapisanego przez operatora dla konkretnej wiadomości zwraca
`infosms.aspx` (wiersz „nadawca wiadomości”).

Nadpis nie jest ustawiany przez bramkę ani przez Polkomtel z własnej inicjatywy: **wniosek składa
klient**, z konta administratora w panelu Multiinfo, w zakładce przeznaczonej do wniosków
o nadpisy. Wniosków można składać wiele. Polkomtel po otrzymaniu wniosku uruchamia nadpis na
koncie klienta albo odmawia; do czasu uruchomienia wysyłka z takim nadpisem kończy się kodem
`-14`.

Uruchomiony nadpis musi być ponadto przypisany do użytkownika API, z którego korzysta bramka
(w panelu Multiinfo: edycja użytkownika API, zakładka Nadpisy - lista nadpisów użytkownika albo
opcja „Pozwalaj użytkownikowi na korzystanie ze wszystkich nadpisów”). Nadpis uruchomiony
u klienta, lecz nieprzypisany do użytkownika, Multiinfo odrzuca kodem `-14` z komunikatem
„Nie masz prawa ustawić takiego nadawcy”.

Multiinfo nie udostępnia listy uruchomionych nadpisów przez API. Bramka prowadzi więc własny
słownik nadpisów przy każdym koncie (rozdział 4.4), do którego wpisuje się wyłącznie nadpisy
już uruchomione przez Polkomtel. Żądanie z nadpisem spoza słownika bramka odrzuca sama, zanim
dotrze do Multiinfo.

### 1.5. Adres API: `api1` czy `api2`

Konta Multiinfo są obsługiwane pod jednym z dwóch adresów: `https://api1.multiinfo.plus.pl/Api61/`
albo `https://api2.multiinfo.plus.pl/Api61/`. Który dotyczy konkretnego konta, mówi umowa albo
opiekun techniczny. Adres wpisuje się w bramce jako adres bazowy konta (rozdział 4.2).

### 1.6. Co powinno być gotowe przed rozdziałem 2

- login i hasło użytkownika API
- plik `.p12` (albo `.pfx`) z podpisanym certyfikatem i kluczem prywatnym oraz hasło do pliku
- identyfikator usługi (jeden albo kilka)
- lista nadpisów uruchomionych przez Polkomtel, jeżeli mają być używane (bez nadpisu nadawcą jest
  numer przydzielony do konta w Multiinfo)
- adres API (`api1` albo `api2`)

Dane z zakładki Uwierzytelnianie (punkt 1.2, krok 5) uzupełnia się dopiero po wgraniu pliku
`.pfx` do bramki, bo to bramka odczytuje i pokazuje potrzebne wartości.

## 2. Serwer

### 2.1. Wymagania

- Ubuntu Server 24.04 LTS. Wystarczy najmniejsza maszyna wirtualna u dowolnego dostawcy
  (1 procesor, 1 GB pamięci, 10 GB dysku); bramka zużywa około 150 MB pamięci
- Publiczny adres IP i dostęp przez SSH na porcie 22
- Użytkownik systemowy z prawem do `sudo` (u dostawców chmurowych taki użytkownik jest tworzony
  razem z maszyną)
- Dostęp z serwera do internetu (pobranie obrazów Dockera i połączenia z Multiinfo)

Logowanie na serwer z własnego komputera:

```bash
ssh <TWOJ-UZYTKOWNIK>@<ADRES-SERWERA>
```

Wszystkie polecenia z rozdziałów 2, 3 i 7 wykonuje się w tej sesji, na serwerze.

### 2.2. Instalacja Dockera

Docker uruchamia bramkę w kontenerze - odizolowanym środowisku z własną kopią Node.js
i wszystkich bibliotek, niezależnym od pakietów zainstalowanych w systemie. Docker Compose to
narzędzie, które na podstawie pliku konfiguracyjnego (`docker-compose.yml`, dostarczonego
z bramką) buduje i uruchamia kontener z właściwymi portami, katalogiem na dane i zmiennymi
środowiskowymi.

Polecenie:

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
```

Oczekiwany wynik: instalacja kończy się bez komunikatu o błędzie, a `sudo docker --version`
wypisuje `Docker version 2x.x.x` (dokładny numer zależy od wersji pakietu w Ubuntu).

Domyślnie polecenia `docker` może wydawać tylko administrator. Żeby nie poprzedzać każdego
polecenia słowem `sudo`, należy dodać własnego użytkownika do grupy `docker`:

```bash
sudo usermod -aG docker $USER
```

Przynależność do grupy jest odczytywana przy logowaniu, więc zmiana zaczyna działać dopiero
w nowej sesji. Należy zakończyć bieżącą sesję i zalogować się ponownie:

```bash
exit
```

a następnie, z własnego komputera, ponownie:

```bash
ssh <TWOJ-UZYTKOWNIK>@<ADRES-SERWERA>
```

Sprawdzenie po ponownym zalogowaniu:

```bash
docker --version
docker compose version
```

Oczekiwany wynik: `Docker version 2x.x.x` oraz `Docker Compose version v2.x.x`, oba bez `sudo`.

Gdy wynik jest inny:

- `permission denied while trying to connect to the Docker daemon socket` - sesja nie została
  zakończona i rozpoczęta na nowo po `usermod`; należy wykonać `exit` i zalogować się ponownie
- `docker: command not found` - instalacja pakietów nie zakończyła się; należy powtórzyć
  `sudo apt install -y docker.io docker-compose-v2 git` i przeczytać komunikat błędu (najczęściej
  brak połączenia z internetem albo zablokowany `apt` przez inny proces aktualizacji, który
  trzeba odczekać)

## 3. Instalacja bramki

### 3.1. Pobranie kodu

```bash
git clone <ADRES-REPO> multiinfo-gate
cd multiinfo-gate/docker
```

`<ADRES-REPO>` to adres repozytorium bramki (z GitHuba albo z kopii wewnętrznej). Po wykonaniu
polecenia kod znajduje się w katalogu `~/multiinfo-gate`, a bieżącym katalogiem jest
`~/multiinfo-gate/docker`, skąd wydaje się wszystkie polecenia `docker compose`.

### 3.2. Klucz główny i plik `.env`

Bramka szyfruje wszystkie sekrety w swojej bazie danych - hasła do Multiinfo, klucze prywatne
certyfikatów, sekrety drugiego składnika, skróty kluczy API - jednym kluczem głównym, którego
w bazie nie ma. Konsekwencje:

- utrata klucza głównego oznacza, że bazy nie da się odczytać; wszystkie konta, certyfikaty
  i klucze API trzeba wpisać od nowa
- zmiana klucza głównego przy istniejącej bazie sprawia, że bramka odmawia startu
- kopia bazy razem z kluczem głównym jest równoważna kopii bez szyfrowania; klucz przechowuje
  się osobno od kopii (np. w menedżerze haseł), nigdy w repozytorium ani w tym samym katalogu

Klucz przekazuje się bramce w pliku `.env` w katalogu `docker/`. Jest to zwykły plik tekstowy
z wpisami `NAZWA=wartość`, po jednym w wierszu, który Docker Compose czyta przy każdym
uruchomieniu. Plik jest wpisany do `.gitignore`, więc nie trafi do repozytorium przy
aktualizacjach.

Polecenia (w katalogu `~/multiinfo-gate/docker`):

```bash
echo "MIG_MASTER_KEY=$(openssl rand -base64 32)" > .env
chmod 600 .env
cat .env
```

Pierwsze polecenie generuje 32 losowe bajty, zapisuje je w base64 i tworzy plik `.env`. Drugie
ogranicza dostęp do pliku do jego właściciela. Trzecie wypisuje zawartość - to moment na
skopiowanie klucza do menedżera haseł.

Oczekiwany wynik `cat .env`: jeden wiersz w postaci `MIG_MASTER_KEY=` i 44 znaki kończące się
znakiem `=`.

### 3.3. Uruchomienie

```bash
docker compose up -d --build
```

Polecenie buduje obraz kontenera (przy pierwszym uruchomieniu pobiera obraz Node.js i instaluje
zależności - od dwóch do czterech minut) i uruchamia bramkę w tle. Sprawdzenie:

```bash
curl http://127.0.0.1:8080/healthz
```

Oczekiwany wynik: `{"status":"ok"}`.

Gdy wynik jest inny, dziennik bramki pokazuje przyczynę:

```bash
docker compose logs --tail 50
```

Najczęstsze przyczyny:

- `zmienna MIG_MASTER_KEY nie jest ustawiona` albo komunikat o złej długości klucza - błąd
  w pliku `.env` (brak wiersza, dodatkowe spacje, obcięta wartość); po poprawieniu ponownie
  `docker compose up -d`
- `address already in use` - port 8080 albo 8081 jest zajęty przez inny program na serwerze;
  należy zmienić `MIG_API_PORT` albo `MIG_ADMIN_PORT` w `docker-compose.yml` (tabela zmiennych
  w rozdziale 7.7) i pamiętać o nowym numerze w dalszych krokach
- `curl: (7) Failed to connect` - kontener jeszcze się uruchamia; po kilku sekundach powtórzyć

### 3.4. Pierwsze konto panelu

Konto administratora bramki zakłada się poleceniem wykonanym wewnątrz kontenera:

```bash
docker compose exec multiinfo-gate npm run admin:dodaj -- janek
```

`janek` to login, którym będzie się logować do panelu - należy podać własny. Login ma od 3 do
32 znaków: małe litery, cyfry, kropka, myślnik, podkreślenie. Polecenie wyświetla monit
`Hasło do panelu:` i czeka na wpisanie hasła (co najmniej dwanaście znaków). Hasło nie jest
wyświetlane podczas wpisywania i nie trafia do historii poleceń.

Oczekiwany wynik: komunikat o utworzeniu konta z informacją, że pierwsze logowanie wymaga
włączenia drugiego składnika.

Drugi składnik to jednorazowy sześciocyfrowy kod generowany przez aplikację na telefonie
(Google Authenticator, Microsoft Authenticator, Aegis, 1Password i każda inna zgodna ze
standardem TOTP), wymagany przy logowaniu obok hasła. Panel wymusza jego włączenie przy pierwszym
wejściu i pokazuje wtedy dziesięć jednorazowych kodów zapasowych - wyłącznie ten jeden raz.
Kody zapasowe zastępują aplikację, gdy telefon jest niedostępny; przechowuje się je w menedżerze
haseł albo w wydruku poza serwerem.

Panel ogranicza zgadywanie. Pięć błędnych kodów z rzędu unieważnia trwające logowanie: panel
wraca do ekranu hasła i wymaga podania go ponownie. Dziesięć nieudanych prób (hasła albo kodu)
z jednego adresu w ciągu kwadransa blokuje ten adres na kwadrans od ostatniej próby; panel
odpowiada wtedy komunikatem o zbyt wielu próbach (kod 429) także na poprawne hasło. Obie sytuacje
trafiają do dziennika zdarzeń jako `drugi_skladnik_zablokowany` i `logowanie_zablokowane`.

## 4. Panel

### 4.1. Dostęp przez tunel SSH

Panel nasłuchuje wyłącznie na adresie lokalnym serwera (`127.0.0.1:8081`) i nie jest osiągalny
z internetu - tak ma pozostać. Dostęp uzyskuje się przez tunel SSH: połączenie SSH, które oprócz
zwykłej sesji przekazuje ruch z wybranego portu na własnym komputerze do wybranego portu na
serwerze. Po zestawieniu tunelu adres `http://127.0.0.1:8081` otwarty w przeglądarce na własnym
komputerze prowadzi do panelu na serwerze, a cały ruch jest szyfrowany przez SSH.

Polecenie wykonuje się **na własnym komputerze**, w osobnym oknie terminala, które ma pozostać
otwarte na czas pracy z panelem:

```bash
ssh -N -L 8081:127.0.0.1:8081 <TWOJ-UZYTKOWNIK>@<ADRES-SERWERA>
```

Opcja `-N` oznacza, że sesja służy tylko do tunelu (bez uruchamiania powłoki), `-L` opisuje
tunel: port 8081 lokalnie → adres `127.0.0.1`, port 8081 na serwerze. Polecenie po zestawieniu
tunelu nie wypisuje nic - to stan prawidłowy. Tunel kończy się skrótem Ctrl+C w tym oknie.

Następnie w przeglądarce należy otworzyć `http://127.0.0.1:8081`, zalogować się loginem i hasłem
z rozdziału 3.4, zeskanować wyświetlony kod QR aplikacją uwierzytelniającą, wpisać kod z aplikacji
i zapisać kody zapasowe.

![Ekran logowania do panelu: pola login i hasło, przycisk Dalej](obrazki/logowanie.png)

Gdy nie działa:

- przeglądarka zgłasza odmowę połączenia - okno z tunelem zostało zamknięte albo tunel nie
  zestawił się; należy uruchomić polecenie ponownie i przeczytać jego komunikat
- `bind [127.0.0.1]:8081: Address already in use` - port 8081 na własnym komputerze zajmuje
  inny program; należy użyć innego portu lokalnego, np. `-L 18081:127.0.0.1:8081` i adresu
  `http://127.0.0.1:18081`

### 4.2. Konto Multiinfo

W panelu: **Konta Multiinfo → Dodaj konto**. Pola formularza:

| Pole | Wartość |
|---|---|
| Nazwa w panelu | dowolna nazwa własna, np. `Firma` |
| Adres bazowy | `https://api2.multiinfo.plus.pl/Api61/` albo z `api1`, zgodnie z punktem 1.5 |
| Login | login użytkownika API (punkt 1.1); musi być zgodny z polem CN certyfikatu |
| Hasło konta Multiinfo | hasło użytkownika API |
| ID usług, jedno w wierszu | identyfikatory usług z punktu 1.3 |
| Domyślny kraj numerów | kod kraju dopisywany do numerów bez prefiksu, dla Polski `48` |
| Przechowywanie treści wiadomości | wyłączone: bramka przechowuje tylko identyfikatory, numery i statusy; włączone: także treść, widoczną w panelu i w API |
| Plik .pfx albo .p12 | plik z punktu 1.2, z dowolnym z tych dwóch rozszerzeń |
| Hasło do pliku .pfx | hasło nadane przy tworzeniu pliku |

![Formularz nowego konta Multiinfo wypełniony danymi przykładowymi, z wybranym plikiem .pfx](obrazki/konto.png)

Po zapisaniu bramka otwiera kartę konta z sekcją **Odczytane dane certyfikatu**: podmiot (CN),
wystawca, odcisk SHA-1 i daty ważności. Te trzy pierwsze wartości należy teraz wpisać w panelu
Multiinfo, w edycji użytkownika API, w zakładce Uwierzytelnianie (punkt 1.2, krok 5). Jeżeli CN
różni się od loginu konta, karta pokazuje ostrzeżenie - w takim przypadku certyfikat został
wygenerowany z innym CN i trzeba go wystawić ponownie.

### 4.3. Sprawdzenie połączenia

Przycisk **Sprawdź połączenie** na karcie konta wysyła do Multiinfo zapytanie testowe
o nieistniejącą wiadomość. Wynik prawidłowy to kod **`-31`**: Multiinfo przyjęło certyfikat
i hasło, a odrzuciło jedynie treść zapytania. Inne kody:

| Kod | Znaczenie | Postępowanie |
|---|---|---|
| `-1` | złe hasło użytkownika API | poprawić hasło na karcie konta |
| `-80` | certyfikat nie został przedstawiony | plik `.pfx` nie został wgrany albo jest uszkodzony; wgrać ponownie |
| `-81` do `-84`, `-86` | certyfikat nierozpoznany przez Multiinfo | dane z zakładki Uwierzytelnianie w panelu Multiinfo nie zostały jeszcze wpisane albo różnią się od odczytanych przez bramkę |
| `-85` | CN certyfikatu nie zgadza się z loginem | wystawić certyfikat z CN równym loginowi |

Sprawdzenie wysyła jeszcze drugie zapytanie, na stronę diagnostyczną Multiinfo `test.aspx`,
która odpowiada tym, co serwer Polkomtela odczytał z przedstawionego certyfikatu: podmiotem,
wystawcą i datą ważności. Karta pokazuje te dane pod wynikiem sprawdzenia jako **Certyfikat
widziany przez Multiinfo** i porównuje CN z loginem konta. Różnica między tym, co bramka
odczytała z pliku `.pfx` (punkt 4.2), a tym, co widzi Multiinfo, wskazuje przyczynę kodów
`-80` do `-86` bez zgadywania: gdy strona odpowiada „Brak certyfikatu”, certyfikat nie dotarł
do serwera; gdy pokazuje inne CN niż login, plik pochodzi z innego wniosku. Strona nie sprawdza
loginu ani hasła, więc nie zastępuje wyniku `-31` - jest do niego uzupełnieniem.

Karta konta zachowuje ślad ostatniego sprawdzenia (oba żądania i odpowiedzi, z hasłem
zamaskowanym).

![Karta konta po sprawdzeniu połączenia: odczytane dane certyfikatu i ślad zapytania z kodem -31](obrazki/polaczenie.png)

### 4.4. Słownik nadpisów

Na liście kont, przy każdym koncie, znajduje się formularz **Słownik nadpisów, jeden w wierszu**
oraz pole wartości domyślnej. Do słownika wpisuje się wyłącznie nadpisy uruchomione przez
Polkomtel (punkt 1.4). Bramka odrzuca żądanie z nadpisem spoza słownika kodem `403`, zanim
trafi ono do Multiinfo; nadpis wpisany do słownika, ale nieuruchomiony przez Polkomtel, przejdzie
przez bramkę i zostanie odrzucony przez Multiinfo kodem `-14` - wiadomość dostanie wtedy stan
`failed` z tym kodem.

![Lista kont ze słownikiem nadpisów konta Firma i wartością domyślną Firma Info](obrazki/nadpisy.png)

### 4.5. Klucz API

Klucz API identyfikuje aplikację kliencką. Jeden klucz odpowiada jednej aplikacji (albo jednemu
kontrahentowi); dzięki temu limit żądań, odwołanie i dziennik dotyczą jednej aplikacji, a nie
wszystkich.

W panelu: **Klucze API → Wygeneruj klucz**. Formularz pozwala wybrać konto Multiinfo, nadać
nazwę, ograniczyć klucz do wybranych usług i nadpisów, ustawić limit części jednej wiadomości
(1-9), limit żądań na minutę, datę ważności oraz adres webhooka - jeśli aplikacja ma otrzymywać
powiadomienia o doręczeniu (opis w `docs/api.md`, rozdział 6).

Po zapisaniu panel wyświetla jeden raz dwie wartości: **klucz** (`mig_live_...`) oraz - gdy
podano adres webhooka - **sekret webhooka**. W bazie bramki pozostaje tylko skrót klucza; panel
nie pokaże tych wartości ponownie. Należy je zapisać w menedżerze haseł i przekazać osobie
odpowiedzialnej za aplikację kliencką. Utracony klucz zastępuje się nowym (wygenerowanie
nowego, przekazanie aplikacji, odwołanie starego); utracony sekret webhooka wydaje ponownie
edycja klucza ze zmianą adresu webhooka.

![Ekran kluczy API tuż po wygenerowaniu klucza: klucz i sekret webhooka pokazane jeden raz](obrazki/klucz.png)

### 4.6. Użytkownicy panelu

Kolejne osoby otrzymują konta z ekranu **Użytkownicy → Dodaj użytkownika**. Formularz przyjmuje
login i hasło startowe; hasło przekazuje się tej osobie bezpośrednio, ponieważ panel nie
wyświetla go ponownie. Przy pierwszym logowaniu panel wymusza włączenie drugiego składnika, tak
jak dla pierwszego konta.

![Lista użytkowników panelu po dodaniu drugiego konta, z akcjami Reset 2FA i Usuń](obrazki/uzytkownicy.png)

Na liście użytkowników dostępne są akcje:

- **Reset 2FA** - usuwa drugi składnik i kody zapasowe danego użytkownika; przy następnym
  logowaniu panel zażąda włączenia drugiego składnika od nowa. Stosowane po utracie telefonu
- **Usuń** - usuwa konto i natychmiast zamyka jego otwarte sesje. Ostatniego konta nie można
  usunąć
- **Zmień hasło** (odnośnik w prawym górnym rogu) - zmiana hasła własnego konta; po zapisaniu
  pozostałe sesje tego konta zostają zamknięte, bieżąca pozostaje

Panel nie ma ról: każdy użytkownik ma pełne uprawnienia. Pierwsze konto zakłada się zawsze
poleceniem z rozdziału 3.4, kolejne - z tego ekranu.

## 5. Pierwsza wysyłka

### 5.1. Tunel do API

Do czasu wystawienia API pod domeną (rozdział 6) port 8080 jest dostępny tylko z serwera.
Do testu z własnego komputera służy tunel jak w rozdziale 4.1, dla portu 8080 (można też dodać
drugą opcję `-L` do istniejącego tunelu):

```bash
ssh -N -L 8080:127.0.0.1:8080 <TWOJ-UZYTKOWNIK>@<ADRES-SERWERA>
```

### 5.2. Wysłanie wiadomości

Polecenie (na własnym komputerze; `<TWOJ-KLUCZ>` to klucz z rozdziału 4.5, numer należy
zastąpić własnym numerem testowym):

```bash
curl -s http://127.0.0.1:8080/v1/messages \
  -H "Authorization: Bearer <TWOJ-KLUCZ>" \
  -H "Content-Type: application/json" \
  -d '{"to":"48601000001","text":"Test bramki"}'
```

Oczekiwany wynik:

```json
{"id":"msg_3f9c2a7b1e4d8c6a5b2f","status":"queued","encoding":"gsm","parts":1,"characters":12,"slots":12,"slotsRemaining":148}
```

Status `queued` oznacza przyjęcie do kolejki; wysyłka następuje w tle, w ciągu sekundy.

### 5.3. Odczyt stanu

```bash
curl -s http://127.0.0.1:8080/v1/messages/<ID> -H "Authorization: Bearer <TWOJ-KLUCZ>"
```

gdzie `<ID>` to wartość `id` z poprzedniej odpowiedzi. Oczekiwany wynik: po kilku sekundach
`"status":"sent"`, po kilkunastu `"status":"delivered"` i wiadomość na telefonie. Ten sam stan
pokazuje panel na ekranie **Wiadomości**.

![Lista wiadomości w panelu z filtrami stanu, kodowaniem, liczbą części i stanem doręczenia](obrazki/wiadomosci.png)

Szczegół wiadomości (odnośnik w kolumnie identyfikatora) pokazuje podgląd segmentów, przebieg
z czasami kolejnych zdarzeń oraz ślad protokołu: pełne żądanie do Multiinfo z zamaskowanym hasłem
i odpowiedź linia po linii.

![Szczegół doręczonej wiadomości: podgląd segmentów, dane, przebieg i ślad protokołu](obrazki/wiadomosc.png)

Gdy stan to `failed`, odpowiedź zawiera pola `providerCode` i `error` z powodem:

| `providerCode` | Znaczenie | Postępowanie |
|---|---|---|
| `-14` | nadpis nieuruchomiony przez Polkomtel | użyć nadpisu uruchomionego (punkt 1.4) albo pominąć pole `orig` |
| `-24` | nieznany identyfikator usługi | poprawić identyfikator na karcie konta |
| `-80` do `-86` | certyfikat odrzucony | konto zostało wstrzymane; postępowanie w rozdziale 7.5 |

Odpowiedź `401` na samo żądanie oznacza błędny albo odwołany klucz; `403 orig_not_allowed` -
nadpis spoza słownika konta albo uprawnień klucza.

### 5.4. Wysyłka z przykładowej aplikacji

Repozytorium zawiera w katalogu `examples/php/` przykładową aplikację w PHP: stronę z formularzem
pojedynczej wiadomości i rozsyłki, listą wysyłek oraz odbiornikiem webhooków. Służy jako narzędzie
testowe i jako wzorzec kodu do przeniesienia do własnej aplikacji. Instrukcja uruchomienia
znajduje się w `examples/php/README.md`.

## 6. Wystawienie API pod własną domeną

Ten rozdział dotyczy sytuacji, w której aplikacja kliencka działa poza serwerem bramki - np.
w agencji obsługującej wysyłki albo w systemie hostowanym u innego dostawcy. Aplikacja otrzymuje
klucz API i łączy się z bramką przez internet. Panel pozostaje dostępny wyłącznie przez tunel
SSH; na zewnątrz wystawia się tylko API.

### 6.1. Pojęcia

**Odwrotne proxy** to serwer WWW ustawiony przed bramką. Przyjmuje połączenia z internetu na
portach 80 (HTTP) i 443 (HTTPS), obsługuje szyfrowanie i przekazuje żądania do bramki na port
8080, który pozostaje niedostępny z zewnątrz. Bramka nie musi znać domeny ani obsługiwać
certyfikatów HTTPS.

**HTTPS** szyfruje ruch między aplikacją a serwerem; bez niego klucz API byłby przesyłany
otwartym tekstem. Do HTTPS potrzebny jest certyfikat wystawiony dla domeny. **Let's Encrypt**
to urząd certyfikacji wydający takie certyfikaty bezpłatnie i automatycznie, pod warunkiem że
domena wskazuje na serwer, a port 80 jest otwarty - w ten sposób Let's Encrypt sprawdza, że
serwer należy do wnioskującego. Oba opisane niżej warianty odnawiają certyfikat samoczynnie.

### 6.2. Domena

U dostawcy domeny (w panelu, w którym domena została zarejestrowana) należy dodać rekord typu
`A` dla wybranej nazwy (np. `sms.twojafirma.pl`) wskazujący na publiczny adres IP serwera.
Zmiana jest widoczna po czasie od kilku minut do godziny. Sprawdzenie, z dowolnego komputera:

```bash
dig +short <TWOJA-DOMENA>
```

Oczekiwany wynik: adres IP serwera. Brak wyniku oznacza, że rekord jeszcze się nie rozpropagował
albo został wpisany pod inną nazwą.

### 6.3. Zapora

Do serwera muszą docierać połączenia na porty 80 i 443. U dostawców chmurowych porty otwiera
się w regułach sieciowych maszyny wirtualnej (w Azure: „Network security group”, reguła
przychodząca dla portów 80 i 443, protokół TCP, dowolne źródło; u innych dostawców pod nazwami
„firewall” albo „security group”). Jeżeli na serwerze działa dodatkowo zapora `ufw`:

```bash
sudo ufw allow 80,443/tcp
```

Portów 8080 i 8081 nie należy otwierać - mają pozostać dostępne wyłącznie z samego serwera.

### 6.4. Wybór wariantu

Poniżej trzy równoważne sposoby. Wariant A jest właściwy, gdy na serwerze nie działa inny serwer
WWW; wariant B - gdy nginx już jest zainstalowany albo administrator go zna; wariant C - gdy
serwer obsługuje już inne kontenery przez Traefik. Należy wykonać jeden z nich.

### 6.5. Wariant A: Caddy w kontenerze

Caddy to serwer WWW, który samodzielnie uzyskuje i odnawia certyfikat Let's Encrypt. Repozytorium
zawiera plik `docker/docker-compose.caddy.yml`, uruchamiający Caddy jako drugi kontener obok
bramki, oraz `docker/Caddyfile` z jego konfiguracją. Jedyną wartością do podania jest domena.

W pliku `docker/.env` (rozdział 3.2) należy dopisać dwa wiersze:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.caddy.yml
MIG_DOMENA=<TWOJA-DOMENA>
```

Wiersz `COMPOSE_FILE` sprawia, że każde polecenie `docker compose` uwzględnia od tej pory także
plik Caddy - bez podawania go za każdym razem opcją `-f`. Następnie, w katalogu
`~/multiinfo-gate/docker`:

```bash
docker compose up -d
```

Caddy uzyskuje certyfikat w ciągu około minuty. Sprawdzenie z dowolnego komputera:

```bash
curl https://<TWOJA-DOMENA>/healthz
```

Oczekiwany wynik: `{"status":"ok"}`.

Gdy nie działa, dziennik Caddy wskazuje przyczynę:

```bash
docker compose logs caddy --tail 30
```

Typowe przyczyny: domena nie wskazuje jeszcze na serwer (sprawdzić `dig` z rozdziału 6.2),
port 80 zamknięty w zaporze (Let's Encrypt nie może potwierdzić domeny), literówka
w `MIG_DOMENA`.

### 6.6. Wariant B: nginx na serwerze

W tym wariancie nginx zainstalowany bezpośrednio w systemie przekazuje ruch do bramki, a certyfikat
uzyskuje i odnawia program certbot. Repozytorium zawiera gotowy plik konfiguracji nginx.

Polecenia (na serwerze; w dwóch ostatnich `twoja.domena.pl` należy zastąpić własną domeną):

```bash
sudo apt install -y nginx python3-certbot-nginx
sudo cp ~/multiinfo-gate/docker/nginx/multiinfo-gate.conf /etc/nginx/sites-available/multiinfo-gate
sudo sed -i 's/<TWOJA-DOMENA>/twoja.domena.pl/' /etc/nginx/sites-available/multiinfo-gate
sudo ln -s /etc/nginx/sites-available/multiinfo-gate /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d twoja.domena.pl
```

Kolejno: instalacja nginx i certbota; skopiowanie pliku konfiguracji; wpisanie domeny w miejsce
`<TWOJA-DOMENA>`; włączenie konfiguracji; sprawdzenie składni (`nginx -t`) i przeładowanie;
uzyskanie certyfikatu. Certbot pyta o adres e-mail (na powiadomienia o wygasaniu certyfikatu)
i o zgodę na warunki usługi, po czym sam dopisuje obsługę HTTPS do pliku konfiguracji
i rejestruje zadanie odnawiania.

Oczekiwany wynik: `nginx -t` wypisuje `syntax is ok` oraz `test is successful`; certbot kończy
komunikatem `Successfully deployed certificate` (lub równoważnym). Sprawdzenie jak w wariancie A:
`curl https://<TWOJA-DOMENA>/healthz` → `{"status":"ok"}`.

Gdy nie działa: `nginx -t` wskazuje wiersz z błędem składni; odpowiedź `502 Bad Gateway`
oznacza, że bramka nie działa (`docker compose ps` w katalogu `docker/`); komunikat certbota
`Challenge failed` - domena nie wskazuje na serwer albo port 80 jest zamknięty.

### 6.7. Wariant C: Traefik już działający na serwerze

Traefik to odwrotne proxy dla kontenerów: obserwuje Dockera i buduje trasy z etykiet
(`labels`) na kontenerach, sam uzyskując certyfikaty Let's Encrypt. Ten wariant zakłada, że
Traefik jest już uruchomiony na serwerze i obsługuje inne usługi - repozytorium nie zawiera
jego instalacji, tylko plik `docker/docker-compose.traefik.yml`, który podłącza bramkę do
sieci Traefika i opisuje ją etykietami.

Z konfiguracji Traefika potrzebne są trzy nazwy, które administrator zna z jego uruchomienia:

| Wartość | Gdzie w konfiguracji Traefika | Domyślnie w bramce |
|---|---|---|
| sieć Dockera, w której Traefik szuka kontenerów | `--providers.docker.network` albo sekcja `networks` jego pliku Compose | `traefik` |
| punkt wejścia HTTPS | `--entrypoints.<nazwa>.address=:443` | `websecure` |
| resolver certyfikatów | `--certificatesresolvers.<nazwa>.acme...` | `letsencrypt` |

Gdy nazwy zgadzają się z domyślnymi, w `docker/.env` wystarczą dwa wiersze:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.traefik.yml
MIG_DOMENA=<TWOJA-DOMENA>
```

Gdy się różnią, dochodzą `MIG_TRAEFIK_SIEC`, `MIG_TRAEFIK_WEJSCIE` i `MIG_TRAEFIK_RESOLVER`
z właściwymi nazwami (tabela w rozdziale 7.7). Następnie, w katalogu `~/multiinfo-gate/docker`:

```bash
docker compose up -d
```

Traefik wykrywa kontener w ciągu kilku sekund i uzyskuje certyfikat w ciągu około minuty.
Sprawdzenie jak w wariancie A: `curl https://<TWOJA-DOMENA>/healthz` → `{"status":"ok"}`.

Gdy nie działa: `network <nazwa> declared as external, but could not be found` przy
`docker compose up` oznacza złą nazwę sieci w `MIG_TRAEFIK_SIEC` (listę sieci daje
`docker network ls`); `404 page not found` z Traefika - trasa nie powstała, najczęściej przez
zły punkt wejścia albo domenę, którą Traefik obsługuje już dla innego kontenera; ostrzeżenie
o certyfikacie w przeglądarce (certyfikat `TRAEFIK DEFAULT CERT`) - zła nazwa resolvera albo
port 80 zamknięty; dziennik Traefika (`docker logs <kontener-traefika> --tail 30`) podaje
przyczynę w każdym z tych przypadków. Porty `127.0.0.1:8080` i `:8081` z `docker-compose.yml`
pozostają na pętli zwrotnej hosta - Traefik dochodzi do bramki przez wspólną sieć, nie przez nie.

### 6.8. Przekazanie dostępu aplikacji zewnętrznej

Aplikacja (albo obsługująca ją agencja) potrzebuje:

- adresu API: `https://<TWOJA-DOMENA>`
- własnego klucza API (rozdział 4.5) - osobnego dla każdej aplikacji
- dokumentacji `docs/api.md` i, w razie potrzeby, przykładu `examples/php/`

Czego nie należy udostępniać: dostępu do panelu (port 8081), portu 8080, konta w panelu bramki.

Limit żądań na minutę ustawiony przy kluczu zabezpiecza przed błędem w cudzej aplikacji
(np. wysyłką w pętli); odwołanie klucza w panelu odcina aplikację natychmiast, bez restartu
bramki. Bramka nie odczytuje nagłówka `X-Forwarded-For` - limity liczy na klucz, nie na adres
nadawcy, więc proxy nie wpływa na ich działanie.

## 7. Utrzymanie

### 7.1. Kopie bazy

Bramka wykonuje kopię bazy raz na dobę, po godzinie 02:00 UTC, do katalogu `backups/` na
wolumenie z danymi, i usuwa kopie starsze niż `MIG_BACKUP_RETENTION_DAYS` dni (domyślnie 14).
Kopia jest zaszyfrowana kluczem głównym i bez niego bezużyteczna.

```bash
docker compose exec multiinfo-gate ls -la /data/backups
docker volume inspect docker_gate-data --format '{{.Mountpoint}}'
```

Pierwsze polecenie wypisuje listę kopii (pliki `multiinfo-gate-RRRR-MM-DD.sqlite`); drugie -
katalog na serwerze, w którym leży wolumin z bazą i kopiami (zwykle
`/var/lib/docker/volumes/docker_gate-data/_data`).

Kopie poza serwer należy wykonywać z katalogu `backups/`, nie z działającego pliku bazy: skopiowanie
`multiinfo-gate.sqlite` w trakcie pracy bramki może dać niespójny plik. Klucz główny przechowuje
się oddzielnie od kopii.

### 7.2. Przywrócenie kopii

```bash
docker compose stop
sudo cp <SCIEZKA-WOLUMENU>/backups/multiinfo-gate-RRRR-MM-DD.sqlite <SCIEZKA-WOLUMENU>/multiinfo-gate.sqlite
sudo rm -f <SCIEZKA-WOLUMENU>/multiinfo-gate.sqlite-wal <SCIEZKA-WOLUMENU>/multiinfo-gate.sqlite-shm
docker compose start
```

`<SCIEZKA-WOLUMENU>` to wynik `docker volume inspect` z punktu 7.1. Pliki `-wal` i `-shm` to
dziennik transakcji SQLite należący do poprzedniej bazy; po podmianie pliku muszą zniknąć.

### 7.3. Dziennik

```bash
docker compose logs -f
```

Polecenie wyświetla dziennik na bieżąco (Ctrl+C kończy podgląd). Każdy wpis to jeden wiersz
JSON z polami `at` (czas UTC), `level`, `msg` (nazwa zdarzenia) i identyfikatorami; dziennik nie
zawiera treści wiadomości, haseł ani pełnych kluczy. Zdarzenia warte uwagi:

| Zdarzenie | Znaczenie |
|---|---|
| `wysylka.przyjeta`, `wysylka.odrzucona` | Multiinfo przyjęło albo odrzuciło wiadomość |
| `wysylka.blad_przejsciowy` | błąd sieci albo Multiinfo; bramka ponowi |
| `konto.wstrzymane` | Multiinfo odrzuciło certyfikat; patrz 7.5 |
| `status.ostateczny` | wiadomość doręczona albo niedoręczona |
| `webhook.dostarczony`, `webhook.nieudany` | wynik dostawy zdarzenia do aplikacji |
| `webhook.odmowa_sieci_wewnetrznej` | adres webhooka wskazuje sieć wewnętrzną, a `MIG_WEBHOOK_ALLOW_PRIVATE` nie jest ustawione; dostawa porzucona |
| `status.porzucony` | Multiinfo nie podało stanu ostatecznego przez siedem dni od przekazania; wiadomość zakończona jako `expired` |
| `rozsylka.zakonczona`, `rozsylka.nieudana` | zakończenie rozsyłki |
| `kopia.zapisana`, `kopia.blad` | wynik nocnej kopii; brak `kopia.zapisana` przez dwie doby oznacza, że proces nie działa albo nie ma prawa zapisu do wolumenu |
| `worker.wyjatek`, `api.wyjatek` | błąd wewnętrzny; treść wpisu jest materiałem do zgłoszenia. Zadanie workera wraca z rosnącym odstępem (od minuty do pół godziny) |
| `worker.zadanie_porzucone` | ósmy z rzędu błąd wewnętrzny tego samego zadania; wysyłka kończy wiadomość stanem `failed`, odpytywanie zostawia w przebiegu wpis o przerwaniu |

### 7.4. Aktualizacja

Przed aktualizacją wykonuje się kopię bazy; migracje schematu bazy uruchamiają się same przy
starcie nowej wersji.

```bash
cd ~/multiinfo-gate/docker
docker compose exec multiinfo-gate cp /data/multiinfo-gate.sqlite /data/backups/przed-aktualizacja.sqlite
git -C ~/multiinfo-gate pull
docker compose up -d --build
```

Oczekiwany wynik: `curl http://127.0.0.1:8080/healthz` → `{"status":"ok"}`. W razie błędu
przywraca się kopię `przed-aktualizacja.sqlite` według punktu 7.2 i wraca do poprzedniej wersji
kodu (`git -C ~/multiinfo-gate checkout <poprzedni commit>` i ponowne `docker compose up -d --build`).

### 7.5. Certyfikat Multiinfo

Panel ostrzega na ekranie przeglądu 30 dni przed upływem ważności certyfikatu konta. Wymiana
przebiega obiegiem z punktu 1.2: nowy certyfikat według instrukcji Polkomtela (z tym samym CN),
podpis, plik `.p12`/`.pfx`, wgranie na karcie konta w sekcji **Wymiana certyfikatu**, wpisanie nowych
danych w zakładce Uwierzytelnianie w panelu Multiinfo, sprawdzenie połączenia.

Gdy Multiinfo odrzuci certyfikat (kody `-80` do `-86`), bramka **wstrzymuje konto**: wiadomości
pozostają w kolejce, nie są ponawiane w pętli, a ekran przeglądu i karta konta pokazują powód.
Wstrzymanie znosi wgranie nowego pliku `.pfx` albo - po uzupełnieniu danych po stronie
Multiinfo - udane sprawdzenie połączenia z karty konta. Kolejka rusza w ciągu minuty.

### 7.6. Klucze API

Klucz, który wyciekł albo przestał być potrzebny, odwołuje się na ekranie **Klucze API**
przyciskiem **Odwołaj**; działa to natychmiast. Wymiana klucza: wygenerowanie nowego, przekazanie
aplikacji, odwołanie starego. Odwołane klucze pozostają widoczne w zakładce **Odwołane** ze
względu na dziennik i historię wiadomości.

### 7.7. Zmienne środowiskowe

Ustawiane w `docker/.env` (klucz główny, domena) albo w sekcji `environment` pliku
`docker/docker-compose.yml` (pozostałe):

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `MIG_MASTER_KEY` | - | Klucz główny, 32 bajty w base64, wymagany |
| `MIG_API_PORT` | `8080` | Port publicznego API |
| `MIG_ADMIN_PORT` | `8081` | Port panelu |
| `MIG_API_HOST` | `0.0.0.0` | Adres nasłuchu API |
| `MIG_ADMIN_HOST` | `127.0.0.1` | Adres nasłuchu panelu, poza kontenerem zostaw domyślny |
| `MIG_DATA_DIR` | `/data` | Katalog bazy, raportów i kopii |
| `MIG_LOG_LEVEL` | `info` | Jeden z `silent`, `error`, `warn`, `info`, `debug` |
| `MIG_BACKUP_RETENTION_DAYS` | `14` | Ile dni trzymać kopie bazy |
| `MIG_WEBHOOK_ALLOW_PRIVATE` | `0` | `1` pozwala na adresy webhooków w sieci wewnętrznej (pętla zwrotna, `10/8`, `172.16/12`, `192.168/16`, sieć kontenerów); domyślnie bramka woła wyłącznie adresy publiczne i takie tylko przyjmuje w panelu. Potrzebne, gdy aplikacja odbierająca webhooki stoi na tym samym serwerze, np. przykład PHP z rozdziału 5 |
| `MIG_DOMENA` | - | Domena bramki dla wariantu Caddy i Traefik |
| `COMPOSE_FILE` | - | `docker-compose.yml:docker-compose.caddy.yml` włącza Caddy, `docker-compose.yml:docker-compose.traefik.yml` - Traefik |
| `MIG_TRAEFIK_SIEC` | `traefik` | Wariant Traefik: sieć Dockera, w której Traefik szuka kontenerów |
| `MIG_TRAEFIK_WEJSCIE` | `websecure` | Wariant Traefik: punkt wejścia HTTPS |
| `MIG_TRAEFIK_RESOLVER` | `letsencrypt` | Wariant Traefik: nazwa resolvera certyfikatów |

## 8. Lista kontrolna po wdrożeniu

Do sprawdzenia na docelowym serwerze, na koncie produkcyjnym i numerze testowym:

- [ ] `https://<TWOJA-DOMENA>/healthz` odpowiada `{"status":"ok"}`, a `http://<ADRES-SERWERA>:8080` i `:8081` z zewnątrz nie odpowiadają
- [ ] Sprawdzenie połączenia na karcie konta daje `-31`
- [ ] Wiadomość testowa bez polskich znaków dociera, w panelu ma stan `delivered`
- [ ] Wiadomość z polskimi znakami dociera z poprawnymi znakami
- [ ] Wiadomość z nadpisem dociera z tym nadpisem jako nadawcą
- [ ] Rozsyłka na dwa numery testowe dociera, raport CSV pobiera się z panelu
- [ ] Webhook `message.delivered` dociera do przykładowej aplikacji z poprawnym podpisem
- [ ] Odwołany klucz dostaje `401`
- [ ] Konto panelu ma drugi składnik, kody zapasowe są przechowywane poza serwerem
- [ ] Drugi użytkownik panelu zalogował się hasłem startowym i włączył drugi składnik
- [ ] Po nocy w `backups/` leży plik z datą
