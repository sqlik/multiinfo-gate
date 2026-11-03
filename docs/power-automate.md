# Power Automate

Od wersji 1.9 bramka ma konektor do Microsoft Power Automate. Przepływ wysyła nim SMS-y tak
samo jak każdą inną akcją: autor przepływu wybiera akcję, wypełnia pola i zapisuje przepływ.
Konektor to plik pobierany z panelu bramki. W Power Automate importuje się go jako łącznik
niestandardowy.

Każda wysyłka z konektora przechodzi przez integrację Power Automate w panelu bramki. Integracja
wyznacza nadawcę SMS-a, usługę Multiinfo i limit długości wiadomości. Chroni konto przed
zapętlonym przepływem i zapisuje każde wywołanie w dzienniku. Administrator bramki widzi więc
wysyłki z Power Automate w tym samym miejscu co wysyłki z pozostałych integracji.

Artykuł prowadzi od wymagań, przez integrację w panelu, pobranie pliku, import i połączenie, do
pierwszych przepływów. Kroki w Power Automate opisano według polskiej wersji serwisu z listopada
2026 roku. Microsoft zmienia nazwy pozycji menu bez zapowiedzi, więc pojedyncza etykieta na
ekranie może się różnić od opisu.

Konektor w tej wersji wysyła SMS-y i sprawdza ich stan. Odbioru SMS-ów w przepływie jeszcze nie
obsługuje.

## 1. Co daje konektor

Konektor ma sześć akcji:

| Akcja | Do czego służy |
|---|---|
| Wyślij SMS | jeden SMS na jeden numer, na przykład potwierdzenie zlecenia dla klienta |
| Wyślij rozsyłkę | SMS-y do listy do 5000 odbiorców jednym wywołaniem; listę buduje przepływ, na przykład z tabeli Excela, a każdy odbiorca może mieć własną treść |
| Wyślij SMS do grupy | ta sama treść do każdego numeru z listy odbiorców prowadzonej w integracji, na przykład do ekipy serwisowej |
| Sprawdź stan wiadomości | stan jednej wiadomości: w kolejce, wysłana, doręczona albo niedoręczona |
| Sprawdź stan rozsyłki | stan rozsyłki i jej raportu |
| Pobierz raport rozsyłki | stan doręczenia każdej wiadomości rozsyłki razem z identyfikatorem odbiorcy |

Wybór akcji zależy od tego, skąd pochodzą odbiorcy:

- **Jeden adresat zdarzenia.** Akcja „Wyślij SMS”. Przykład: klient, który zgłosił zlecenie
  w formularzu, dostaje potwierdzenie
- **Lista z danych przepływu.** Akcja „Wyślij rozsyłkę”. Przykład: dyspozytor ma w Excelu wizyty
  na jutro, a każdy klient dostaje SMS z godziną wizyty. Jedno wywołanie zastępuje pętlę
  „Zastosuj do każdego”. Pętla wysyła SMS-y po jednym, trwa długo i szybko wyczerpuje limit
  ochrony przed burzą (rozdział 10)
- **Stały zespół.** Akcja „Wyślij SMS do grupy”. Przykład: zgłoszenie awarii trafia do całej
  ekipy serwisowej. Listę numerów prowadzi administrator bramki w panelu, więc zmiana składu
  ekipy nie wymaga zmiany przepływu

Każda akcja wysyłająca zaczyna się od pola **Integracja**. Wybiera się w nim integrację Power
Automate z panelu bramki. Pole **Zlecający** przyjmuje informację, kto zlecił wysyłkę, na
przykład adres e-mail autora wpisu na liście. Bramka zapisuje ją w dzienniku integracji i przy
wiadomości. Zlecający nie trafia do treści SMS-a.

## 2. Wymagania

### 2.1. Licencja Power Automate

Łącznik niestandardowy jest funkcją płatną. Według Microsoftu przepływ z łącznikiem
niestandardowym wymaga licencji Power Automate Premium albo Process. Licencje dołączone do
Microsoft 365 obejmują wyłącznie łączniki standardowe. Opis licencji jest na stronie
[Typy licencji Power Automate](https://learn.microsoft.com/pl-pl/power-platform/admin/power-automate-licensing/types).

Do prób wystarcza środowisko próbne albo licencja próbna Premium. Plan deweloperski nie jest
dobrym wyborem, ponieważ Microsoft go wygasza. Od 15 listopada 2026 roku zapis do planu nie
tworzy już środowiska. Od 15 grudnia 2026 roku istniejące środowiska deweloperskie bez
zarządzania są wstrzymywane. Szczegóły podaje strona
[Ważne zmiany w Power Platform](https://learn.microsoft.com/pl-pl/power-platform/important-changes-coming).

Bez licencji Premium SMS z przepływu można wysłać mailem przez Mail2SMS. Tę drogę opisuje
rozdział 13.

### 2.2. Bramka dostępna z internetu

Power Automate łączy się z bramką z centrów danych Microsoftu, a nie z sieci firmy. Bramka musi
więc być dostępna z internetu pod adresem spełniającym trzy warunki:

- domena, na przykład `sms.firma.pl`, a nie adres IP
- HTTPS z certyfikatem od publicznego urzędu certyfikacji, na przykład Let's Encrypt
- port 443, czyli adres bez numeru portu

Każdy wariant wystawienia API z rozdziału 6 [Uruchomienia](uruchomienie.md) spełnia te warunki:
Caddy, nginx i Traefik. Kontener LXC na Proxmoxie w sieci firmowej wymaga pośrednika HTTPS
z publiczną domeną. Opisuje to punkt 9.6 Uruchomienia. Panel bramki pozostaje niedostępny
z zewnątrz, ponieważ konektor korzysta wyłącznie z portu API.

Zapora, która przepuszcza ruch tylko z wybranych adresów, musi przepuszczać adresy łączników
Microsoftu. Microsoft publikuje je jako grupę adresów `AzureConnectors` na stronie
[Konfiguracja adresów IP](https://learn.microsoft.com/pl-pl/power-automate/ip-address-configuration).

Brama danych lokalnych Microsoftu nie zastępuje dostępu z internetu. Nie obsługuje ona logowania
kluczem API, a konektor bramki loguje się właśnie kluczem.

### 2.3. Sprawdzenie dostępności

Sprawdź dostępność z urządzenia spoza sieci firmy, na przykład z telefonu z wyłączonym Wi-Fi.
Otwórz w przeglądarce adres:

```
https://<TWOJA-DOMENA>/healthz
```

Oczekiwany wynik: tekst `{"status":"ok"}` bez ostrzeżenia o certyfikacie. Wynik
`{"status":"degraded"}` także oznacza, że bramka jest dostępna. Przyczynę tego stanu pokazuje
panel bramki ([API](api.md), rozdział 10).

Gdy wynik jest inny:

- **Strona się nie otwiera.** Sprawdź rekord DNS domeny, zaporę i serwer pośredniczący według
  rozdziału 6 Uruchomienia
- **Przeglądarka ostrzega o certyfikacie.** Certyfikat nie pochodzi od publicznego urzędu albo
  jest wystawiony na inną domenę. Power Automate odrzuci takie połączenie
- **Adres odpowiada tylko w sieci firmy.** Bramka nie jest wystawiona do internetu

## 3. Integracja w panelu bramki

### 3.1. Klucz API dla Power Automate

Integracja działa w imieniu klucza API. Zaleca się osobny klucz o nazwie „Power Automate”. Klucz
wklejony w Power Automate zostaje zapisany w połączeniu. Osobny klucz można odwołać bez wpływu
na inne aplikacje. Jego usługi, nadpisy i limit żądań można też zawęzić do potrzeb przepływów.

Klucz generuje się na ekranie **Klucze API → Wygeneruj klucz**. Opisuje to rozdział 4.5
[Uruchomienia](uruchomienie.md). Panel pokazuje klucz tylko raz, więc zapisz go od razu
w bezpiecznym miejscu. Klucz wkleja się później w oknie połączenia w Power Automate
(rozdział 6.1).

### 3.2. Dodanie integracji

1. W panelu bramki otwórz **Integracje → Dodaj integrację**.
2. Wybierz kierunek **Aplikacja wysyła SMS**.
3. Kliknij kafelek **Power Automate**. Otworzy się formularz w trybie prostym.
4. Wypełnij sekcję **Podstawy**:
    - **Nazwa**: pod tą nazwą integracja pojawi się w Power Automate w polu „Integracja”. Nazwa
      powinna mówić, do kogo albo w jakiej sprawie wychodzą SMS-y, na przykład „Ekipa serwisowa”
      albo „Biuro handlowe”
    - **Klucz API**: klucz z rozdziału 3.1
    - **ID usługi** i **Nadpis nadawcy**: pozycja z listy uprawnień klucza. Pierwsza pozycja
      oznacza ustawienie domyślne klucza
    - **Włączona**: wyłączona integracja nie wysyła niczego i znika z listy w Power Automate
5. W sekcji **Odbiorcy grupy** wpisz numery dla akcji „Wyślij SMS do grupy”. Wpisuje się jeden
   numer w wierszu, a po numerze opcjonalnie nazwę, na przykład `601 000 011 Marek Kowalski`.
   Pole nie jest wymagane. Pozostałe akcje nie korzystają z tej listy.
6. W sekcji **Treść** ustaw **Limit części** oraz zachowanie przy dłuższej treści: „skróć
   i wyślij” albo „nie wysyłaj, zapisz błąd i powiadom”. Skutki obu ustawień opisuje
   rozdział 10.1.
7. Kliknij **Utwórz integrację**.

Oczekiwany wynik: szczegóły integracji z konfiguracją opisaną słowami i panelem **Konektor Power
Automate**. Na liście integracji nowa pozycja ma kierunek „do SMS” i podpis „Power Automate”.

Przełącznik **Zaawansowany** nad formularzem dokłada sekcję **Ochrona i dziennik**. Są w niej
limit burzy, liczba wpisów w dzienniku i przechowywanie ładunków. Opisuje je rozdział 5b
[Integracji z aplikacjami](integracje.md).

Każda integracja Power Automate ma własną listę odbiorców, limit części i dziennik. Dla różnych
zespołów albo spraw zakłada się osobne integracje, także na tym samym kluczu. Jeden plik
konektora obsługuje je wszystkie.

## 4. Plik konektora

Plik pobiera się w panelu **Konektor Power Automate**. Panel jest pod formularzem integracji
i w jej szczegółach.

1. Sprawdź pole **Publiczny adres bramki dla Power Automate**. Panel wypełnia je sam, gdy adres
   bramki zaczyna się od `https://` i zawiera domenę. W przeciwnym razie wpisz adres
   z rozdziału 2.2, na przykład `https://sms.firma.pl`.
2. Kliknij **Pobierz konektor**.

Oczekiwany wynik: przeglądarka zapisuje plik `multiinfo-gate-power-automate.json`.

Gdy zamiast pliku pojawia się komunikat, adres nie spełnia warunków z rozdziału 2.2. Komunikat
pojawia się przy adresie z `http://`, z adresem IP zamiast domeny, ze ścieżką albo z portem
innym niż 443. Popraw adres i pobierz plik ponownie.

Adres z pola służy wyłącznie do zbudowania pliku. Bramka go nie zapisuje. Plik nie zawiera
klucza API ani innych sekretów, ponieważ klucz podaje się dopiero przy połączeniu. Jeden plik
obsługuje wszystkie integracje Power Automate tej bramki.

## 5. Import w Power Automate

1. Zaloguj się w [make.powerautomate.com](https://make.powerautomate.com). W prawym górnym rogu,
   w polu **Środowiska**, wybierz środowisko, w którym mają działać przepływy.
2. W menu po lewej kliknij **Więcej → Odkryj wszystkie**. W grupie **Dane** wybierz **Łączniki
   niestandardowe**. Ikona pinezki przy tej pozycji przypina ją do menu po lewej.
3. Kliknij **Nowy łącznik niestandardowy → Importuj plik OpenAPI**.
4. W oknie **Importuj plik OpenAPI** wpisz w polu **Nazwa łącznika** `Multiinfo Gate`. Przyciskiem
   **Importuj** wskaż pobrany plik. Kliknij **Kontynuuj**.
5. Otworzy się kreator z krokami **1. Ogólne**, **2. Zabezpieczenia**, **3. Definicja**,
   **4. Kod** i **5. Przetestuj**. Plik wypełnia wszystkie pola, więc niczego w nich nie
   zmieniaj. Pole wyboru **Połącz za pomocą lokalnej bramy danych** zostaw niezaznaczone.
6. Kliknij **Utwórz łącznik**.

Oczekiwany wynik: komunikat „Pomyślnie utworzono łącznik niestandardowy.” W kroku
**3. Definicja** widać siedem akcji bez ostrzeżeń. Akcja „Lista integracji” jest wewnętrzna:
z niej konektor buduje listę w polu „Integracja”. W przepływie widać pozostałe sześć akcji.

W kroku **1. Ogólne** można przekazać własną ikonę łącznika w formacie PNG albo JPG, mniejszą
niż 1 MB. Ikona nie wpływa na działanie konektora.

Gdy kreator odrzuca plik, sprawdź, czy importujesz plik pobrany z panelu bramki. Plik
`openapi.json` z dokumentacji API nie nadaje się do importu, ponieważ jest w wersji OpenAPI 3.0.
Power Automate przyjmuje wyłącznie wersję 2.0. Opisuje to strona
[Tworzenie łącznika niestandardowego z definicji OpenAPI](https://learn.microsoft.com/pl-pl/connectors/custom-connectors/define-openapi-definition).

## 6. Pierwszy przepływ: SMS do jednego numeru

Przykład: dział obsługi klienta przyjmuje zlecenie serwisowe, a klient dostaje SMS-em
potwierdzenie. Przepływ w tym rozdziale uruchamia się ręcznie. Ta sama akcja działa
w przepływie uruchamianym zdarzeniem, na przykład nowym wpisem na liście SharePoint albo
odpowiedzią w Microsoft Forms. Numer i treść pochodzą wtedy z pól wyzwalacza.

### 6.1. Akcja i połączenie

1. W menu po lewej kliknij **Utwórz → Błyskawiczny przepływ w chmurze**. Wpisz nazwę przepływu,
   wybierz wyzwalacz **Wyzwól przepływ ręcznie** i kliknij **Utwórz**.
2. Pod wyzwalaczem kliknij **+** i dodaj akcję. W polu wyszukiwania wpisz `Multiinfo Gate`.
3. Kliknij filtr **Niestandardowe** nad wynikami. Bez tego filtra łącznik niestandardowy
   nie pojawia się na początku listy wyników.
4. Wybierz akcję **Wyślij SMS**.
5. Przy pierwszej akcji Multiinfo Gate otworzy się okno **Utwórz połączenie**. W polu **Nazwa
   połączenia** wpisz nazwę, która wskaże klucz, na przykład `Multiinfo Gate - Power Automate`.
   W polu **Klucz interfejsu API** wklej klucz z rozdziału 3.1. Utwórz połączenie przyciskiem pod
   polami.

Klucz można wkleić sam albo z przedrostkiem `Bearer` i spacją. Oba zapisy działają. Kolejne
akcje Multiinfo Gate w przepływie korzystają z tego samego połączenia. Pod polami akcji widać
wtedy zdanie „Połączono z połączeniem” z nazwą połączenia i odnośnik **Zmień odwołanie do
połączenia**.

### 6.2. Pola akcji „Wyślij SMS”

| Pole | Co wpisać |
|---|---|
| Integracja | integracja Power Automate z listy; lista zawiera włączone integracje klucza z połączenia |
| Numer odbiorcy | jeden numer, na przykład `48601000001`; numer bez kodu kraju otrzymuje kod domyślny konta, a spacje i myślniki są pomijane |
| Treść | treść SMS-a: tekst wpisany na stałe, pola z wcześniejszych kroków przepływu albo jedno i drugie |
| Zlecający | pole opcjonalne: kto zlecił wysyłkę, na przykład `Dział obsługi klienta` albo adres e-mail z formularza |

Pusty numer odbiorcy kończy akcję błędem. Akcja nigdy nie wysyła wtedy SMS-a do listy odbiorców
integracji.

Przycisk **Pokaż wszystkie** przy **Parametrach zaawansowanych** odsłania pozostałe pola:

| Pole | Znaczenie |
|---|---|
| Kodowanie | „Automatyczne” wybiera GSM-7, a przy polskich znakach Unicode; „GSM, bez polskich znaków” zamienia polskie znaki na łacińskie; „Unicode” zawsze koduje treść w UCS-2 |
| Raport doręczenia | wartość „Nie” oznacza rezygnację z raportu doręczenia; stan wiadomości kończy się wtedy na `sent` |
| Ważna do | czas, po którym niedoręczona wiadomość otrzymuje stan `expired`; najwyżej 72 godziny od przyjęcia |
| Znacznik rozliczeń | dowolny tekst na potrzeby rozliczeń, zwracany w stanie wiadomości |
| Klucz idempotencji | ten sam klucz w powtórzonym wywołaniu nie wysyła drugiego SMS-a ([API](api.md), rozdział 3.1) |

Usługi Multiinfo ani nadawcy nie wybiera się w akcji. Wyznacza je integracja.

### 6.3. Test

1. Kliknij **Zapisz** nad projektantem.
2. Kliknij **Przetestuj** i uruchom przepływ ręcznie.

Oczekiwany wynik:

- akcja „Wyślij SMS” kończy się od razu zielonym znacznikiem. Bramka przyjmuje wiadomość do
  kolejki i natychmiast odpowiada, a doręczenie następuje później
- dane wyjściowe akcji zawierają **Identyfikator wiadomości** i **Stan wiadomości** `queued`
- SMS dociera na numer odbiorcy
- w panelu bramki, w szczegółach integracji, dziennik ma wpis „wysłano” z powodem „Wyślij SMS”.
  Kolumna „Nadawca” pokazuje `API · Dział obsługi klienta`. Bez zlecającego pokazuje adres IP,
  z którego przyszło wywołanie
- wiadomość jest na ekranie **Wiadomości**. Jej szczegóły mają wiersze „Integracja”
  i „Zlecający”

Gdy akcja kończy się błędem, nad przebiegiem pojawia się czerwony pasek z komunikatem bramki po
polsku. Znaczenie komunikatów opisuje rozdział 12.

### 6.4. Zmiana klucza w połączeniu

Nowy klucz, na przykład po odwołaniu starego, wpisuje się w istniejącym połączeniu. Przepływy
nie wymagają wtedy zmian.

1. W menu po lewej kliknij **Więcej → Odkryj wszystkie**, a w grupie **Dane** wybierz
   **Połączenia**.
2. Przy połączeniu Multiinfo Gate kliknij **⋮ → Edytuj**.
3. W polu **Klucz interfejsu API** wklej nowy klucz i kliknij **Aktualizuj**.

Lista w polu „Integracja” zależy od klucza połączenia. Klucz bez włączonych integracji Power
Automate daje pustą listę.

## 7. Stan wiadomości

Akcja „Wyślij SMS” kończy się w chwili przyjęcia wiadomości przez bramkę. Stan doręczenia
sprawdza osobna akcja.

1. Pod akcją „Wyślij SMS” dodaj akcję **Opóźnienie** z czasem oczekiwania, na przykład 5 minut.
2. Dodaj akcję **Sprawdź stan wiadomości**. W polu **Identyfikator wiadomości** wstaw
   z zawartości dynamicznej pole **Identyfikator wiadomości** akcji „Wyślij SMS”.
3. Kolejne kroki mogą zależeć od pola **Stan wiadomości**. Przykład: akcja **Warunek**, która przy
   stanie `failed` wysyła mail do dyspozytora.

Oczekiwany wynik: dane wyjściowe akcji z polami wiadomości, w tym **Stan wiadomości** i **Błąd**.

| Stan | Znaczenie |
|---|---|
| `queued` | wiadomość w kolejce bramki |
| `sent` | wiadomość przekazana do sieci; bez raportu doręczenia to stan końcowy |
| `delivered` | doręczona |
| `failed` | niedoręczona; przyczynę podaje pole **Błąd** |
| `expired` | upłynął czas z pola „Ważna do” bez doręczenia |
| `cancelled`, `blocked`, `throttled`, `unknown` | rzadsze stany opisane w rozdziale 7 [API](api.md) |

Stany `delivered`, `failed`, `expired`, `cancelled` i `blocked` są ostateczne. Stan `queued`
albo `sent` oznacza, że doręczenie jeszcze trwa. Akcję można wtedy powtórzyć po kolejnym
opóźnieniu.

## 8. Rozsyłka z Excela

Przykład: dyspozytor ma w Excelu listę wizyt na jutro. Każdy klient dostaje SMS z godziną
wizyty technika, a raport rozsyłki wraca z numerami zleceń.

### 8.1. Tabela w Excelu

Plik leży w OneDrive for Business. Dane są sformatowane jako tabela o nazwie `Odbiorcy` z trzema
kolumnami:

| Numer | Treść | Identyfikator |
|---|---|---|
| 48601000011 | Wizyta technika jutro w godzinach 8:00-10:00. Zlecenie 4411 | ZL-4411 |
| 48601000012 | Wizyta technika jutro w godzinach 10:00-12:00. Zlecenie 4412 | ZL-4412 |
| 48601000013 | Wizyta technika jutro w godzinach 12:00-14:00. Zlecenie 4413 | ZL-4413 |

Kolumna z identyfikatorem jest opcjonalna. Identyfikator ma od 1 do 20 znaków: litery bez
polskich znaków, cyfry, kropkę, podkreślenie albo łącznik. Wraca w raporcie rozsyłki przy
każdym odbiorcy. Pusta treść odbiorcy oznacza treść wspólną rozsyłki.

### 8.2. Przepływ

1. Dodaj akcję **Wyświetl listę wierszy w tabeli** łącznika Excel Online (Business). Wybierz
   **Lokalizacja** `OneDrive for Business`, **Biblioteka dokumentów** `Dokumenty`, plik w polu
   **Plik** i tabelę `Odbiorcy` w polu **Tabela**.
2. Dodaj akcję **Wybierz**. W polu **Z** wstaw z zawartości dynamicznej `value` akcji Excela.
   W polu **Mapa** wpisz w lewej kolumnie trzy klucze: `to`, `text` i `clientId`. W prawej
   kolumnie przypisz im kolumny tabeli: **Numer**, **Treść** i **Identyfikator**. Klucze wpisuje
   się dokładnie w tej postaci, z wielką literą tylko w `clientId`.
3. Dodaj akcję **Wyślij rozsyłkę** i wybierz **Integrację**. Przycisk w prawym górnym rogu pola
   **Odbiorcy** przełącza pole z wpisywania odbiorców po kolei na całą listę. Przełącz je i wstaw
   z zawartości dynamicznej **Dane wyjściowe** akcji „Wybierz”.
4. W polu **Treść wspólna** wpisz treść dla odbiorców bez własnej treści. Pole jest wymagane
   wtedy, gdy któryś odbiorca nie ma treści.
5. W polu **Zlecający** wpisz, kto zleca rozsyłkę, na przykład `Kierownik floty`.

Oczekiwany wynik po uruchomieniu: akcja „Wyślij rozsyłkę” kończy się od razu i zwraca
**Identyfikator rozsyłki**. Dziennik integracji ma wpis „wysłano” z powodem „Wyślij rozsyłkę,
3 odbiorców”. Rozsyłkę widać w panelu bramki na ekranie **Rozsyłki**.

Akcja **Wyświetl listę wierszy w tabeli** zwraca domyślnie najwyżej 256 wierszy. Większą tabelę
odczytuje się po włączeniu **Podziału na strony** na zakładce **Ustawienia** tej akcji, w sekcji
**Sieć**. Opisuje to strona łącznika
[Excel Online (Business)](https://learn.microsoft.com/pl-pl/connectors/excelonlinebusiness/).
Jedna rozsyłka obejmuje najwyżej 5000 odbiorców.

### 8.3. Stan i raport

1. Dodaj akcję **Opóźnienie**, na przykład 10 minut.
2. Dodaj akcję **Sprawdź stan rozsyłki**. W polu **Identyfikator rozsyłki** wstaw
   **Identyfikator rozsyłki** akcji „Wyślij rozsyłkę”. Dane wyjściowe zawierają **Stan rozsyłki**
   i **Stan raportu**.
3. Dodaj akcję **Pobierz raport rozsyłki** z tym samym identyfikatorem. Raport ma wiersz dla
   każdego odbiorcy, z numerem, identyfikatorem odbiorcy i stanem wiadomości.

Bramka zamawia raport w Multiinfo po zakończeniu rozsyłki. Wcześniej akcja „Pobierz raport
rozsyłki” kończy się błędem `409` z kodem `package_not_completed` albo `report_not_ready`. Czas
do gotowego raportu zależy od liczby odbiorców i od Multiinfo. Gdy raport nie jest gotowy,
uruchom akcję ponownie po dłuższym opóźnieniu.

## 9. SMS do grupy

Przykład: zgłoszenie awarii trafia jednym SMS-em do wszystkich techników ekipy serwisowej.

1. W panelu bramki, w integracji Power Automate, uzupełnij sekcję **Odbiorcy grupy**
   (rozdział 3.2, krok 5).
2. W przepływie dodaj akcję **Wyślij SMS do grupy**.
3. Wybierz **Integrację**. Wpisz **Treść** i opcjonalnie **Zlecającego**. Akcja nie ma pola
   numeru, ponieważ odbiorców wyznacza lista integracji.

Oczekiwany wynik: każdy numer z listy dostaje osobny SMS. Dane wyjściowe akcji zawierają
identyfikator każdej wiadomości. Dziennik integracji ma wpis „wysłano” z powodem „Wyślij SMS
do grupy” i liczbą odbiorców, na przykład „Wyślij SMS do grupy, 3 odbiorców”.

Zmiana listy w panelu działa od następnego wywołania. Przepływ nie wymaga zmian. Każdy odbiorca
to osobna wiadomość na koncie Multiinfo, więc SMS do grupy 20 osób to 20 wiadomości.

Gdy lista odbiorców jest pusta, akcja kończy się błędem `Conflict`. Pasek nad przebiegiem
pokazuje komunikat bramki, na przykład: „Integracja Biuro handlowe nie ma odbiorców grupy.
Listę uzupełnia administrator w panelu bramki.” Bramka nie wysyła wtedy żadnej wiadomości.

## 10. Limit części i ochrona przed burzą

### 10.1. Limit części

Limit części ustawia administrator bramki w integracji, w sekcji **Treść**. Dotyczy każdej akcji
wysyłającej: SMS-a do jednego numeru, każdej treści rozsyłki i SMS-a do grupy.

- **„skróć i wyślij”.** Bramka skraca dłuższą treść do limitu i wysyła SMS. Akcja w przepływie
  kończy się powodzeniem. Skrócona treść bez polskich znaków kończy się trzema kropkami,
  a z polskimi znakami znakiem „…”. Wpis w dzienniku ma dopisek „skrócono do 1 części”
- **„nie wysyłaj, zapisz błąd i powiadom”.** Akcja kończy się błędem `BadRequest` z komunikatem
  na przykład „Treść wymaga 3 części, a limit integracji to 1.” W rozsyłce jedna zbyt długa
  treść odrzuca całą rozsyłkę. Komunikat zaczyna się wtedy od pozycji odbiorcy na liście,
  liczonej od zera, na przykład `recipients.4:`. Dziennik dostaje wpis „błąd”, a administrator
  powiadomienie

### 10.2. Ochrona przed burzą

Ochrona przed burzą liczy wywołania akcji wysyłających integracji. Domyślnie przepuszcza 30
wywołań na 10 minut. Rozsyłka do 5000 odbiorców to jedno wywołanie, tak samo jak SMS do jednego
numeru. Zapętlony przepływ zatrzymuje się więc na limicie, zanim wyczerpie konto.

Wywołanie ponad limit dostaje odpowiedź `429` z kodem `integration_throttled` i nie wysyła
SMS-a. Dziennik integracji dostaje wpis „limit”. Administrator dostaje jedno powiadomienie na
okno, bez względu na liczbę odrzuconych wywołań.

Power Automate ponawia akcję po odpowiedzi `429` według domyślnych zasad ponawiania. W próbach
ponowił ją do czterech razy, a przebieg trwał kilka minut, zanim zakończył się błędem.
Każde ponowienie jest osobnym wywołaniem i dostaje osobny wpis „limit”. Ponowienie, które
trafi już w nowe okno, wysyła SMS normalnie.

Akcja, która ma kończyć się błędem od razu, bez ponowień, wymaga zmiany ustawień:

1. Kliknij akcję w projektancie i otwórz zakładkę **Ustawienia**.
2. W sekcji **Sieć**, w polu **Zasady ponawiania**, wybierz **Brak**.
3. Zapisz przepływ.

Limit zmienia administrator bramki w trybie zaawansowanym formularza integracji, w sekcji
**Ochrona i dziennik**. Do wielu odbiorców lepiej wysyłać jednym wywołaniem „Wyślij rozsyłkę”
albo „Wyślij SMS do grupy” niż pętlą wywołań „Wyślij SMS”.

### 10.3. Wyłączona integracja

Wyłączona integracja znika z listy w polu „Integracja”. Zapisany przepływ, który ją wskazuje,
kończy akcję błędem `Conflict` z kodem `integration_disabled`. Bramka nie wysyła wtedy SMS-a
i nie zapisuje wpisu w dzienniku. Po ponownym włączeniu integracji przepływ działa bez zmian.

## 11. Aktualizacja konektora

Nowy plik konektora pobiera się po aktualizacji bramki, gdy opis wydania wymienia zmiany
w konektorze. Aktualizacja łącznika zachowuje zapisane przepływy, ponieważ akcje konektora mają
stałe nazwy wewnętrzne.

1. Pobierz nowy plik z panelu bramki (rozdział 4).
2. W Power Automate otwórz listę **Łączniki niestandardowe** (rozdział 5, krok 2).
3. Przy łączniku Multiinfo Gate kliknij **…** i wybierz **Aktualizuj na podstawie pliku
   interfejsu OpenAPI**.
4. Wskaż nowy plik i kliknij **Kontynuuj**.
5. W kreatorze kliknij **Zaktualizuj łącznik**.

Oczekiwany wynik: po około 20 sekundach łącznik jest zaktualizowany. Zapisane przepływy działają
dalej.

Projektant przepływu pokazuje zmiany od razu. Uruchomione przepływy korzystają jednak przez pewien
czas z poprzedniego opisu łącznika. W próbach trwało to od pół godziny do półtorej godziny.
Zanim sprawdzisz zmianę w przebiegu przepływu, odczekaj ten czas.

## 12. Gdy coś nie działa

Nieudana akcja Multiinfo Gate pokazuje nad przebiegiem czerwony pasek z komunikatem bramki po
polsku. Kod odpowiedzi HTTP, na przykład `BadRequest` albo `Conflict`, widać przy akcji. Kod
błędu bramki (`error.code`) jest w danych wyjściowych akcji. Kody i ich znaczenie dla programisty
opisuje rozdział 5b.6 [API](api.md).

| Objaw | Przyczyna | Co zrobić |
|---|---|---|
| kreator odrzuca plik | plik nie pochodzi z panelu bramki, na przykład to `openapi.json` z dokumentacji API | pobrać plik z panelu bramki (rozdział 4) |
| akcji Multiinfo Gate nie ma w wynikach wyszukiwania | wyniki pokazują najpierw łączniki Microsoftu | kliknąć filtr **Niestandardowe** nad wynikami |
| lista w polu „Integracja” jest pusta | klucz połączenia nie ma włączonej integracji Power Automate | sprawdzić w panelu bramki klucz i stan integracji; w razie potrzeby wpisać w połączeniu inny klucz (rozdział 6.4) |
| błąd `401` z kodem `invalid_api_key`, `revoked_api_key` albo `expired_api_key` | klucz w połączeniu jest błędny, odwołany albo wygasł | wpisać w połączeniu ważny klucz (rozdział 6.4) |
| błąd `404` z kodem `integration_not_found` | integracja wskazana w akcji została usunięta albo należy do innego klucza niż klucz połączenia | wybrać integrację z listy ponownie |
| błąd `409` z kodem `integration_disabled` | integracja jest wyłączona w panelu bramki | poprosić administratora o włączenie integracji |
| błąd `409` z kodem `group_empty` | lista odbiorców grupy integracji jest pusta | poprosić administratora o uzupełnienie listy (rozdział 9) |
| błąd `400` z kodem `too_many_parts` | treść przekracza limit części integracji przy ustawieniu „nie wysyłaj” | skrócić treść albo poprosić administratora o zmianę limitu (rozdział 10.1) |
| błąd `400` z kodem `invalid_phone` | numer nie daje się sprowadzić do poprawnej postaci; komunikat podaje powód | poprawić numer w danych przepływu |
| błąd `400` z kodem `invalid_body` | pusty numer, brak treści albo pole w złym formacie; komunikat wymienia pola | uzupełnić albo poprawić wskazane pola akcji |
| błąd `403` z kodem `service_not_allowed` albo `orig_not_allowed` | usługa albo nadpis integracji jest spoza uprawnień klucza | poprosić administratora o poprawienie integracji albo uprawnień klucza |
| akcja ponawia się przez kilka minut i kończy błędem `429` z kodem `integration_throttled` | przekroczony limit ochrony przed burzą integracji | rozdział 10.2 |
| błąd `429` z kodem `rate_limited` | przekroczony limit żądań klucza na minutę | wysyłać rozsyłką zamiast pętli albo poprosić administratora o wyższy limit klucza |
| błąd `503` z kodem `integration_unavailable` | konto Multiinfo integracji jest wstrzymane albo nie istnieje | przekazać administratorowi bramki |
| błąd połączenia albo certyfikatu | bramka jest niedostępna z internetu albo jej certyfikat nie pochodzi od publicznego urzędu | sprawdzić dostępność według rozdziału 2.3 |
| po aktualizacji łącznika przebieg działa według poprzedniego opisu | Power Automate korzysta jeszcze z poprzedniego opisu łącznika | odczekać (rozdział 11) |

## 13. Bez licencji Premium: Outlook i Mail2SMS

Łącznik Office 365 Outlook jest standardowy. Działa więc z licencją dołączoną do Microsoft 365,
bez Premium. Przepływ wysyła nim mail na skrzynkę integracji Mail2SMS, a bramka zamienia ten
mail na SMS.

Ta droga wymaga integracji Mail2SMS w bramce. Opisuje ją rozdział 5
[Integracji z aplikacjami](integracje.md). Najważniejsze warunki:

- skrzynka Mail2SMS jest u dostawcy innego niż Microsoft 365, na przykład w home.pl, OVH albo
  na własnym serwerze poczty (rozdział 5.1 Integracji)
- adres konta, z którego przepływ wysyła mail, jest na liście dozwolonych nadawców integracji
  (rozdział 5.2)
- integracja wie, do kogo wysłać SMS: numer w temacie albo w pierwszej linii maila, numery
  przypisane nadawcy albo stała lista (rozdział 5.3)

Kroki w przepływie:

1. Dodaj akcję **Wyślij wiadomość e-mail (V2)** łącznika Office 365 Outlook.
2. W polu **Do** wpisz adres skrzynki Mail2SMS.
3. Temat i treść maila ułóż według ustawień integracji, na przykład numer odbiorcy w temacie,
   a treść SMS-a w treści maila.
4. Zapisz przepływ i przetestuj go.

Oczekiwany wynik: SMS dociera po czasie odczytu skrzynki przez bramkę. W próbie było to około 30
sekund. Dziennik integracji Mail2SMS ma wpis „wysłano” z adresem nadawcy maila.

Edytor treści w akcji Outlooka wysyła mail w formacie HTML. Bramka usuwa znaczniki i wysyła
sam tekst. Przepływ nie dostaje identyfikatora wiadomości ani stanu doręczenia. Wysyłkę widać
w dzienniku integracji Mail2SMS i na ekranie **Wiadomości** w panelu bramki.
