# Integracje z aplikacjami

Od wersji 1.5 bramka rozmawia także z aplikacjami, które mają własny, narzucony format
komunikatów. Przyjmuje od nich zlecenia wysyłki SMS-a. W drugą stronę przekazuje im odebrane
SMS-y oraz statusy wysyłki w takim kształcie, jakiego oczekują. Służy do tego integracja. Jest to
obiekt konfigurowany w panelu i przypięty do klucza API. Ma adres wejściowy albo docelowy,
szablon i warunek.

Od wersji 1.8 integracją jest również skrzynka pocztowa: bramka odczytuje wiadomości od
dozwolonych nadawców i zamienia je na SMS-y (Mail2SMS, rozdział 5).

Ten rozdział opisuje trzy kierunki, język szablonów, gotowe ustawienia dla popularnych aplikacji,
dziennik integracji oraz powiadomienia dla administratora wysyłane mailem. Wysyłkę przez pełne
API z kluczem w nagłówku opisuje rozdział [API dla aplikacji](api.md). Integracje są dla
przypadków, w których aplikacja nie potrafi tego API użyć.

## 1. Czym jest integracja

Integracja działa w jednym z trzech kierunków:

| Kierunek | W panelu | Co robi |
|---|---|---|
| do SMS | „Aplikacja wysyła SMS” | aplikacja wywołuje adres wejściowy bramki `POST /hooks/<identyfikator>` własnym ładunkiem, bramka odczytuje z niego numer i treść, składa SMS i wysyła |
| z SMS-a | „SMS albo status trafia do aplikacji” | odebrany SMS albo status wysyłki bramka wysyła na adres aplikacji w formacie zapisanym w szablonie |
| z poczty | „Mail2SMS” | bramka odczytuje skrzynkę IMAP i zamienia wiadomości od dozwolonych nadawców na SMS-y; numery wskazuje nadawca, lista nadawców albo stała lista (rozdział 5) |

Każda integracja działa w imieniu jednego klucza API. Obowiązują więc konto Multiinfo tego
klucza, jego dozwolone usługi, nadpisy i limity, dokładnie tak jak przy wysyłce przez API.
Wiadomości wysłane przez integrację widać na ekranie „Wiadomości” z nazwą klucza i nazwą
integracji. Jeden klucz może mieć wiele integracji. Klucz z włączoną integracją nie może zostać
odwołany. Najpierw trzeba integrację wyłączyć albo usunąć.

Każde zdarzenie przechodzi przez ten sam potok. Na początku jest źródło: żądanie aplikacji albo
zdarzenie w bramce. Potem warunek, który rozstrzyga, czy w ogóle reagować. Dalej ochrona, czyli
idempotencja i limit burzy. Następnie szablony: numer, treść albo body żądania. Na końcu
wykonanie, czyli wysyłka SMS-a albo dostawa do aplikacji, oraz wpis w dzienniku integracji.
Każdy krok, który coś odrzuca, zostawia wpis z powodem. Niektóre odrzucenia wysyłają też mail do
administratora (rozdział 9).

## 2. Dodanie integracji w panelu

Ekran **Integracje** w grupie „Konfiguracja” pokazuje listę integracji. Przy każdej widać
kierunek, ustawienie, klucz, stan (włączona, wyłączona albo błąd w ostatniej dobie), ostatnie
zdarzenie i liczniki z ostatniej doby. Plakietka przy pozycji w menu liczy integracje, które
w ostatniej dobie miały błąd.

![Lista integracji: nazwa z ustawieniem, kierunek, klucz i konto, stan, ostatnie zdarzenie i liczniki z doby](obrazki/integracje.png)

### 2.1. Adres bramki

Zanim dodasz pierwszą integrację, podaj raz **adres, pod którym aplikacje widzą bramkę**. Panel
prosi o niego na ekranie **Klucze API**, a dopóki go nie ma, także na liście integracji. To ten
sam adres, który aplikacje wpisują przed `/v1/messages`. Dla bramki pod domeną będzie to na
przykład `https://sms.firma.pl`. Dla kontenera na Proxmoxie dostępnego w sieci firmowej będzie
to adres kontenera z portem API, na przykład `http://10.10.10.159:8080`. Adres podaje się bez
ścieżki na końcu.

Od tej chwili panel pokazuje przy każdym kluczu gotowe wywołanie do wklejenia w terminalu. Przy
każdej integracji pokazuje pełny adres wejściowy zamiast samej ścieżki `/hooks/…`. Rozdział 3.1
opisuje, jaki adres wpisać zależnie od tego, w jakim środowisku została postawiona bramka.

### 2.2. Trzy kroki

Przycisk **Dodaj integrację** prowadzi przez trzy kroki:

1. Kierunek: „Aplikacja wysyła SMS”, „SMS albo status trafia do aplikacji” albo „Mail2SMS”.
2. Gotowe ustawienie: kafelek z nazwą aplikacji (rozdział 7) albo „Własne” dla aplikacji spoza
   listy.
3. Formularz. Gotowe ustawienie otwiera się w **trybie prostym**, „Własne” natychmiast
   w **zaawansowanym**. Przełącznik nad formularzem zmienia tryb w każdej chwili.

![Wybór gotowego ustawienia: kafelki z nazwą aplikacji i jednym zdaniem o tym, co ustawienie robi](obrazki/integracja-katalog.png)

Niektóre ustawienia pokazują nad przyciskiem zapisu uwagę w ramce. Uwaga zbiera to, o czym warto
wiedzieć przed uruchomieniem integracji, a czego nie widać w samych polach formularza. Tak jest
przy ustawieniu „WooCommerce: status do klienta”, ponieważ SMS trafia tam do klienta sklepu, a nie do
obsługi. Ramka informuje wtedy, jaki numer nadawcy zobaczy klient oraz że wiadomość o treści
marketingowej wymaga jego zgody. Pojawia się w obu trybach formularza. Niczego nie blokuje.

### 2.3. Tryb prosty

Tryb prosty nie wymaga znajomości ładunku aplikacji ani szablonów. Formularz ma pięć punktów.
Każdy z nich jest decyzją użytkownika, wyrażoną w jego języku:

1. **Nazwa i konto** - nazwa integracji i klucz API. SMS-y są wysyłane z konta Multiinfo tego klucza.
2. **Kto otrzyma SMS** - numery telefonów, jeden w wierszu. Gdy aplikacja sama przesyła numer
   (Zabbix, Prosty JSON), pole nazywa się „Numery zapasowe”, a zdanie pod nim wyjaśnia, skąd pochodzi
   numer.
3. **Kiedy wysyłać SMS** - lista wariantów przygotowanych dla tej aplikacji. W Uptime Kumie są
   to na przykład: „tylko gdy monitor przestanie działać”, „gdy przestanie działać i gdy zacznie działać ponownie”,
   „zawsze, także przy przycisku Test”.
4. **Treść SMS-a** - dwa warianty treści. Panel pokazuje je jako gotowy SMS obliczony
   z prawdziwego ładunku tej aplikacji, na przykład „AWARIA: Strona firmowa - Request failed
   with status code 403”. Szablonu nie pokazuje.
5. **Zabezpieczenie** - jedno, takie, które dana aplikacja obsługuje. Jest to hasło, które
   wpisuje się też po stronie aplikacji. Przycisk **Wygeneruj** losuje bezpieczne hasło. Przy
   aplikacjach bez pola na hasło (FreeScout, Freshdesk) panel wyjaśnia jednym zdaniem, co
   zamiast hasła chroni adres.

![Formularz Uptime Kumy w trybie prostym: numery, kiedy wysyłać, dwa warianty treści jako gotowe SMS-y, hasło z przyciskiem Wygeneruj](obrazki/integracja-formularz.png)

Integracja z SMS-a w trybie prostym ma cztery grupy pól. Nazwa i konto działają jak wyżej.
Adres aplikacji ma podpowiedź, co tam wpisać, na przykład „adres FreeScouta z końcówką
/api/conversations”. Parametry aplikacji to na przykład numer skrzynki we FreeScoucie. Dostęp
do aplikacji to jej klucz API. Przy Freshdesku bramka sama zamienia klucz na wymagany nagłówek.

Po zapisaniu panel pokazuje jeden raz ramkę z **pełnym adresem do wklejenia**. Obok jest zdanie,
gdzie go wkleić, na przykład „w Uptime Kumie w polu Post URL powiadomienia typu Webhook”, oraz
instrukcja krok po kroku dla tej aplikacji.

![Ramka po zapisaniu: pełny adres wejściowy, gdzie go wkleić i instrukcja krok po kroku](obrazki/integracja-adres.png)

Tryb prosty zapisuje dokładnie tę samą konfigurację, którą pokazuje tryb zaawansowany. Wybrany
wariant „kiedy” to warunek. Wariant treści to szablon. Hasło to nagłówek albo basic auth. Dopóki
konfiguracja mieści się w listach ustawienia, edycja otwiera tryb prosty z zaznaczonymi
wyborami. Gdy ktoś w trybie zaawansowanym wpisze własny szablon albo warunek, edycja otwiera
się w trybie zaawansowanym z komunikatem (jednym zdaniem dlaczego), a szczegóły integracji
pokazują warunek i szablon zamiast słów z list.

### 2.4. Tryb zaawansowany

Tryb zaawansowany pokazuje pola silnika, podzielone na sekcje:

- podstawy: nazwa, klucz, usługa, nadawca, włączona
- wejście albo wyjście: uwierzytelnianie i lista źródeł, a w drugim kierunku adres, metoda,
  nagłówki i zdarzenia
- warunek: reguły albo wyrażenie Liquid
- odbiorca: ścieżki numeru i identyfikatorów, lista zapasowa, odpowiedź na numer nie do odczytania
- treść albo żądanie: szablon Liquid albo pole z ładunku, a w drugim kierunku body
- ochrona i dziennik
- próbka

Rozdziały 3 i 4 opisują każde pole. Rozdział 6 opisuje język szablonów.

Pod formularzem są dwa przyciski. **Sprawdź szablon** niczego nie zapisuje i nie wysyła SMS-a.
Używa próbki ładunku z pola na dole (z ustawienia albo z dziennika) i pokazuje wynik: czy
warunek jest spełniony, jak wyglądają odbiorcy po normalizacji, jaka będzie treść i ile zajmie
części. Dla integracji z SMS-a pokazuje nagłówki (z zamaskowanymi sekretami) i body. **Utwórz
integrację** zapisuje. Zapis wymaga poprawnego szablonu i warunku. Błąd składni Liquida wraca
jako komunikat z numerem linii i kolumny.

![Podgląd „Sprawdź szablon” w trybie zaawansowanym: warunek spełniony, odbiorcy, treść SMS-a i liczba części](obrazki/integracja-sprawdz.png)

Adres wejściowy widać w szczególe integracji i na stronie edycji. Tam też jest przycisk
**Wygeneruj nowy**. Stary adres przestaje działać natychmiast, więc należy go zastąpić
w aplikacji.

Sekrety zapisują się zaszyfrowane kluczem głównym. Dotyczy to hasła z trybu prostego, tokenu
w nagłówku, hasła basic auth i sekretnych nagłówków integracji z SMS-a. Po zapisaniu nie można
ich odczytać w panelu. W edycji puste pole sekretu zachowuje dotychczasową wartość. Aby wyłączyć
warstwę w trybie zaawansowanym, wyczyść nazwę nagłówka albo login.

## 3. Aplikacja wysyła SMS

### 3.1. Adres wejściowy

Adres wejściowy to `POST /hooks/<identyfikator>` na porcie API bramki, czyli tym samym, na
którym działa `/v1/messages`. Przykład: `https://sms.firma.example/hooks/k9x…`. Identyfikator
ma 32 losowe znaki i sam w sobie jest sekretem. Kto go zna, może wysyłać SMS-y na koszt konta,
do wysokości limitów klucza i w granicach ochrony z rozdziału 3.7.

Bramka przyjmuje `Content-Type: application/json` oraz `application/x-www-form-urlencoded`.
Formularz zamienia na płaski obiekt, a powtórzone pole staje się tablicą. Ładunek może mieć do
256 KB. Większy otrzymuje kod 413, a niepoprawny JSON kod 400. Inne metody niż `POST` otrzymują 405.
Nieznany identyfikator i integracja wyłączona otrzymują 404, bez wpisu w dzienniku.

Panel pokazuje pełny adres, gdy zna adres bramki (rozdział 2.1). Bez niego pokazuje samą ścieżkę
`/hooks/<identyfikator>`. Ścieżkę dopisuje się do adresu, pod jakim aplikacja widzi API bramki.
Ten adres zależy od środowiska bramki i od tego, skąd wywołuje ją aplikacja:

| Środowisko bramki | Skąd wywołuje aplikacja | Pełny adres do wpisania w aplikacji |
|---|---|---|
| Docker z odwrotnym proxy pod domeną (Caddy, nginx albo Traefik z rozdziału 6 Uruchomienia) | z internetu | `https://<TWOJA-DOMENA>/hooks/<identyfikator>` |
| Docker bez proxy (porty przypięte do `127.0.0.1`, jak w `docker-compose.yml`) | tylko z tego samego serwera | `http://127.0.0.1:8080/hooks/<identyfikator>`; aplikacja z innego komputera nie połączy się z bramką, dopóki API nie zostanie wystawione według rozdziału 6 |
| Kontener LXC na Proxmoxie (rozdział 9 Uruchomienia) | z tej samej sieci co kontener (biuro, serwerownia) | `http://<ADRES-KONTENERA>:8080/hooks/<identyfikator>`, np. `http://10.10.10.159:8080/hooks/k9x…`; bez HTTPS, więc token jest przesyłany jawnym tekstem, wyłącznie w zaufanej sieci firmowej |
| Kontener LXC na Proxmoxie | z internetu (Grafana Cloud, Freshdesk, FreeScout u hostingodawcy, Zapier) | kontener nie ma publicznego adresu; potrzebne odwrotne proxy z HTTPS pod publiczną domeną, kierowane na `http://<ADRES-KONTENERA>:8080` (punkt 9.6 Uruchomienia) |

Weryfikacja ścieżki: z komputera albo serwera, na którym działa aplikacja, wywołaj
`curl <ADRES-BEZ-ŚCIEŻKI>/healthz`, na przykład `curl https://sms.firma.example/healthz`.
Prawidłowa odpowiedź to `{"status":"ok"}`. Odpowiedź `Connection refused` albo przekroczony
czas oznaczają, że sieć nie prowadzi do bramki. Żadne ustawienie integracji tego nie naprawi.
W drugą stronę, gdy to bramka wywołuje aplikację (rozdział 4), obowiązuje reguła z punktu 4.3
o adresach w sieci wewnętrznej.

### 3.2. Uwierzytelnianie

Bramka ma pięć warstw uwierzytelniania. Pierwsza działa zawsze. Pozostałe włącza się
w sekcji „Wejście”:

| Warstwa | Jak działa | Kiedy używać |
|---|---|---|
| sekret w adresie | identyfikator z adresu wejściowego | zawsze |
| nagłówek z tokenem | nazwa nagłówka i wartość z konfiguracji, np. `Authorization: Bearer …`, porównanie w stałym czasie | aplikacje z polem na nagłówki: Uptime Kuma, Zabbix, automaty |
| sekret w polu ładunku | ścieżka do pola i wartość z konfiguracji, porównanie w stałym czasie | aplikacje bez pola na nagłówki, które wkładają token do treści żądania: Fakturownia |
| basic auth | login i hasło z konfiguracji | Grafana i inne z gotowym polem „Basic Authentication” |
| lista źródeł | adresy IP, zakresy CIDR (IPv4 i IPv6) albo nazwy hostów rozwiązywane przy żądaniu z buforem 60 s | aplikacje ze stałym adresem albo NAS z DDNS |

Nieudane uwierzytelnienie daje kod 401 (token, sekret w polu ładunku, basic auth) albo 403
(źródło). W dzienniku powstaje wpis `odrzucono` z adresem źródłowym, bez ładunku. Administrator otrzymuje mail,
grupowany. Niezależnie od limitów klucza adres `/hooks/` ma własny limit: 120 żądań na minutę
z jednego adresu źródłowego. Nadmiar otrzymuje kod 429.

Adresem źródłowym jest adres gniazda. Gdy bramka działa za odwrotnym proxy (Caddy, nginx,
Traefik), adresem gniazda jest adres proxy. Aby lista źródeł i dziennik widziały adres klienta,
podaj adresy proxy w zmiennej `MIG_TRUSTED_PROXIES` ([Uruchomienie](uruchomienie.md), rozdział
7.7). Bramka ufa nagłówkowi `X-Forwarded-For` wyłącznie od tych adresów.

Sekret podany w polu ładunku bramka usuwa z treści żądania natychmiast po sprawdzeniu. W dzienniku,
w podglądzie ładunku oraz w szablonie w jego miejscu znajduje się słowo `(sekret)`. Nazwa pola zostaje,
bo pomaga rozpoznać żądanie.

### 3.3. Odbiorcy i normalizacja

Numer odbiorcy bramka ustala na podstawie trzech źródeł, w tej kolejności:

1. Ze ścieżki w ładunku (sekcja „Odbiorca”), na przykład `phone` albo `to`. Wartość może być
   tekstem z numerami po przecinku albo tablicą.
2. Od nadawcy odebranego SMS-a, do którego pasuje identyfikator zgłoszenia z ładunku
   (rozdział 3.9). To droga dla własnych integracji, w których aplikacja przesyła identyfikator
   zgłoszenia założonego z SMS-a, ale nie przesyła numeru.
3. Z listy zapasowej w konfiguracji, jeden numer w wierszu. Tak działają Uptime Kuma i Grafana,
   które numerów nie przesyłają.

Normalizacja przyjmuje numery w różnych zapisach. Usuwa spacje, myślniki, nawiasy i kropki. Zdejmuje
wiodący `+` albo `00`. Zdejmuje też wiodące zero, czyli krajowy prefiks międzymiastowy, którym
kupujący niekiedy poprzedzają numer w formularzu zamówienia. Numer dziewięciocyfrowy uzupełnia kodem kraju
konta. W efekcie `+48 601 000 001`, `601-000-001`, `(48) 601.000.001`, `0048601000001`
oraz `0601 000 001` dają to samo: `48601000001`. Wynik przechodzi ten sam walidator, co numery
w API. Jedno żądanie może mieć do 50 odbiorców. Każdy otrzymuje osobną wiadomość z tą samą
treścią. Więcej odbiorców daje wpis `błąd` bez wysyłki.

Pole „Numer z ładunku nieprawidłowy albo nieobecny” rozstrzyga, co bramka odpowiada aplikacji
źródłowej. Domyślnie zgłasza błąd. Aplikacja otrzymuje kod 422, administrator otrzymuje mail,
a w dzienniku zostaje wpis `błąd`. Druga możliwość to „pomiń zdarzenie”. Wtedy aplikacja otrzymuje
kod 200, mail nie jest wysyłany, a w dzienniku zostaje wpis `pominięto`.

Pominięcie jest dla sklepów. Sklep liczy każdą odpowiedź inną niż `2xx` jako nieudane
dostarczenie. Po kilku takich odpowiedziach z rzędu wyłącza webhook, czyli przestaje wysyłać cokolwiek.
Jedno zamówienie z telefonem w nietypowym zapisie może w ten sposób zatrzymać całą integrację.
Dlatego gotowe ustawienie „WooCommerce: status do klienta” ma tu wybrane pominięcie.

Przełącznik dotyczy wyłącznie numeru odczytanego z ładunku. Zły numer na liście zapasowej zostaje
błędem, bo listę wpisuje administrator w tym samym formularzu i pomyłka ma być widoczna. Brak
numeru w ogóle także zostaje błędem. Przełącznik nie zmienia tego, kto otrzymuje SMS.

### 3.4. Zapytanie uzupełniające

Niektóre aplikacje wysyłają powiadomienie bez numeru telefonu. Fakturownia przy wystawieniu
faktury przysyła dane dokumentu oraz nazwę nabywcy. Numeru w tym powiadomieniu nie ma, bo numer
znajduje się w kartotece klienta. Zapytanie uzupełniające służy do tego, aby bramka sama go
sięgnęła.

Przebiega to tak. Bramka odbiera powiadomienie. Odczytuje z niego identyfikator klienta. Odpytuje
aplikację o kartotekę tego klienta. Z odpowiedzi odczytuje numer telefonu i dopiero wtedy składa
SMS-a. Zapytanie jest wysyłane raz na jedno powiadomienie, bez ponowień i bez dodatkowych zapytań.

Odpowiedź aplikacji trafia do szablonu pod nazwą `e`. Ładunek powiadomienia zostaje pod `p`.
Numer komórkowy z kartoteki ma więc postać `e.mobile_phone`, a nazwa klienta `e.name`.
Tej samej nazwy używa się w sekcji „Odbiorca”: wpis `e.mobile_phone` kieruje SMS na numer
z kartoteki.

Zapytanie ustawia się w sekcji „Zapytanie uzupełniające”. Potrzebne są dwie rzeczy. Pierwsza to
adres, pod którym aplikacja udostępnia kartoteki. Druga to kod autoryzacyjny do jej API. Kod
jest przechowywany w postaci zaszyfrowanej. Bramka dodaje go do adresu jako parametr `api_token`. Nie trafia ani
do szablonu, ani do dziennika.

![Sekcja „Zapytanie uzupełniające” w trybie zaawansowanym: adres zapytania z polem ładunku i filtrem url_encode, kod autoryzacyjny API oraz lista „Gdy aplikacja nie odpowie”](obrazki/integracja-dopytanie.png)

Adres jest szablonem, tak samo jak treść SMS-a. Identyfikator klienta wstawia się do niego
z ładunku:

```liquid
https://firma.fakturownia.pl/clients/{{ p.deal.client.external_ids.fakturownia | url_encode }}.json
```

Filtr `url_encode` jest tutaj obowiązkowy. Wartość wstawiana do adresu pochodzi od aplikacji,
która wysłała powiadomienie. Bez filtru mogłaby zawierać ukośnik albo znak zapytania i tak
zmienić adres docelowy w aplikacji.

Bramka sprawdza to niezależnie od filtru. Zapamiętuje nazwę serwera oraz początek ścieżki
wpisane wprost, czyli wszystko przed pierwszym miejscem ze zmienną. Gdy złożony adres z tego
miejsca wychodzi, zapytania nie będzie. Nazwę serwera wpisuj więc zawsze wprost. Pola z ładunku
wstawiaj dopiero dalej, w ścieżce.

Bramka nie odpytuje aplikacji w sieci wewnętrznej. Obowiązuje ta sama zasada, co przy integracjach
wychodzących. Gdy aplikacja działa w tej samej sieci co bramka, ustaw `MIG_WEBHOOK_ALLOW_PRIVATE`
([Uruchomienie](uruchomienie.md), rozdział 7.7).

Aplikacja może nie odpowiedzieć. Może też odpowiedzieć kartoteką bez numeru telefonu. Pole „Gdy
aplikacja nie odpowie” rozstrzyga, jak bramka postępuje w takim przypadku.

Domyślnie zgłasza błąd. Aplikacja otrzymuje kod 422, administrator otrzymuje mail, a w dzienniku
zostaje wpis `błąd`. Kod 422 jest prośbą o ponowienie żądania. Ponowione powiadomienie przejdzie
przez bramkę zwyczajnie, nawet przy włączonej ochronie przed duplikatami z rozdziału 3.8.

Druga możliwość to „pomiń wiadomość”. Aplikacja otrzymuje wtedy kod 200, mail nie jest wysyłany, a w
dzienniku zostaje wpis `pominięto`. Jest właściwa dla aplikacji, które liczą nieudane dostarczenia
i po kilku z rzędu wyłączają webhook. Tak działa Fakturownia, dlatego oba jej gotowe ustawienia
mają tutaj pominięcie.

Zapytanie odchodzi dopiero wtedy, gdy powiadomienie przejdzie warunek, ochronę przed duplikatami
oraz limit burzy. Powiadomienie odrzucone wcześniej nie generuje zapytania.

Podgląd „Sprawdź szablon” nie wysyła zapytania do aplikacji. Gotowe ustawienia mają przykładową odpowiedź
i podgląd podstawia właśnie ją. Własne ustawienie takiej próbki nie ma, więc pola z przedrostkiem `e`
zostaną w podglądzie puste. Informacja o tym jest wyświetlana pod podglądem.

### 3.5. Treść

Treść SMS-a pochodzi z jednego z dwóch miejsc. Pierwsze to szablon Liquid (rozdział 6),
w którym ładunek jest dostępny pod nazwą `p`. Drugie to pole z ładunku wskazane ścieżką, gdy
aplikacja przysyła gotowy tekst. Do tego dochodzi limit części (od 1 do 9, domyślnie 1)
i zachowanie przy nadmiarze: „skróć z wielokropkiem” albo „odrzuć zdarzenie”. Części liczy
ten sam kod, który dzieli wiadomości w API. Polskie znaki skracają więc część do 70 znaków.
Filtr `gsm` zamienia je na łacińskie i przywraca 160.

### 3.6. Warunek

Sekcja „Warunek” decyduje, czy zdarzenie jest przetwarzane dalej. Ma dwa tryby. W trybie reguł wpisuje
się wiersze „ścieżka, operator, wartość”, łączone spójnikiem „i”. Operatory to: równe, różne od,
zawiera, zaczyna się od, pasuje do wyrażenia regularnego, istnieje, nie istnieje, większe niż
i mniejsze niż. Dwa ostatnie porównują liczbowo, gdy obie strony są liczbami. W trybie
wyrażenia Liquid wpisuje się jedno wyrażenie. Jego wynik po przycięciu oznacza „wyślij”, jeżeli
jest różny od pustego ciągu, `false` i `0`. Bez reguł każde zdarzenie jest przetwarzane. Zdarzenie
odrzucone warunkiem otrzymuje wpis `pominięto` i odpowiedź 200 bez SMS-a.

Typowe reguły: `heartbeat.status równe 0` (Uptime Kuma tylko przy awarii), `status równe firing`
(Grafana bez powiadomienia o powrocie), `status równe PROBLEM` (Zabbix).

### 3.7. Ochrona przed burzą

Sekcja „Ochrona i dziennik” ma limit burzy: liczbę zdarzeń w oknie minut, domyślnie 10 w 10
minut. Okno liczy się od pierwszego zdarzenia. Nadmiar otrzymuje wpis `limit` i odpowiedź 200 bez
SMS-a. Administrator otrzymuje jeden mail na okno, nie na każde zdarzenie. Przykład: monitoring,
który przy awarii łącza wysyła alert o każdym z 40 hostów, kosztuje wtedy 10 SMS-ów, nie 40.

### 3.8. Idempotencja

Ścieżka „identyfikator zdarzenia” (sekcja „Odbiorca”) chroni przed podwójnym SMS-em. Aplikacja
czasem ponawia żądanie po przekroczeniu czasu. Ten sam identyfikator w ciągu doby otrzymuje wtedy
wpis `duplikat` i odpowiedź 200. Zabbix ma `{EVENT.ID}`. Skrypt z rozdziału 7.5 dopisuje do niego
status, bo rozwiązanie problemu otrzymuje ten sam identyfikator co problem. Prosty JSON ma pole
`eventId`. Klucz grupy Grafany nie nadaje się na identyfikator, bo jest stały dla grupy alertów.

### 3.9. Odpowiedź w wątku

Ścieżka „identyfikator zgłoszenia” łączy oba kierunki w integracjach własnych. Scenariusz
wygląda tak. Integracja z SMS-a założyła w aplikacji zgłoszenie z odebranego SMS-a i odczytała
jego identyfikator (rozdział 4.4). Potem aplikacja wywołuje adres wejściowy z tym identyfikatorem.
Bramka wysyła wtedy SMS do nadawcy tamtej wiadomości jako odpowiedź w wątku, tak jak
`inReplyTo` w [API](api.md), rozdział 5a.3. Gdy ładunek podaje też numer, wątek powstaje tylko
wtedy, gdy to numer nadawcy. Odpowiedź widać przy odebranej wiadomości. Bez dopasowania wysyłany jest
zwykły SMS na numer z ładunku albo z listy zapasowej. Gdy nie ma ani jednego, ani drugiego,
powstaje wpis `błąd` z numerem zgłoszenia w powodzie.

### 3.10. Kody odpowiedzi

Bramka odpowiada po zapisaniu wpisu i zakolejkowaniu wysyłki. Nie czeka na Multiinfo:

| Sytuacja | Kod | Body |
|---|---|---|
| wysyłka zakolejkowana | 202 | `{ "accepted": true, "messageIds": ["msg_…"] }` |
| warunek niespełniony | 200 | `{ "accepted": false, "reason": "condition" }` |
| limit burzy | 200 | `{ "accepted": false, "reason": "throttled" }` |
| duplikat | 200 | `{ "accepted": false, "reason": "duplicate" }` |
| nieprawidłowy numer z ładunku, gdy ustawienie przewiduje pominięcie | 200 | `{ "accepted": false, "reason": "invalid_recipient" }` |
| aplikacja nie odpowiedziała na zapytanie uzupełniające, gdy ustawienie każe pomijać | 200 | `{ "accepted": false, "reason": "enrich" }` |
| aplikacja nie odpowiedziała na zapytanie uzupełniające, gdy ustawienie przewiduje zgłoszenie błędu | 422 | `{ "accepted": false, "reason": "enrich", "detail": "…" }` |
| pusta treść, brak numeru, nieprawidłowy numer, nadmiar z opcją „odrzuć”, ponad 50 odbiorców | 422 | `{ "accepted": false, "reason": "…", "detail": "…" }` |
| błąd szablonu w czasie wykonania | 422 | jak wyżej |
| nieprawidłowy token, basic auth, źródło spoza listy | 401 albo 403 | `{ "accepted": false, "reason": "unauthorized" }` |
| ładunek za duży, niepoprawny JSON | 413 albo 400 | komunikat serwera |
| za dużo żądań z adresu | 429 | `{ "accepted": false, "reason": "rate_limited" }` |
| klucz odwołany albo przeterminowany, konto wstrzymane | 503 | `{ "accepted": false, "reason": "unavailable", "detail": "…" }` |
| nieznany identyfikator, integracja wyłączona | 404 | `{ "accepted": false, "reason": "unknown" }` |

Kody 200 przy odrzuceniu są celowe. Aplikacje monitorujące traktują je jako sukces i nie
ponawiają żądania. Odmowa Multiinfo po przyjęciu (na przykład błąd certyfikatu) nie zmienia już
odpowiedzi. Wiadomość otrzymuje wtedy status `failed`, widoczny na ekranie „Wiadomości”, a administrator
powiadomienie według reguł z rozdziału 9.

## 4. SMS albo status trafia do aplikacji

### 4.1. Zdarzenia i warunek

Integracja z SMS-a wybiera zdarzenia, na które reaguje: `message.received` (odebrany SMS) oraz
statusy wysyłki `message.sent`, `message.delivered` i `message.failed`. Reaguje tylko na
zdarzenia z usług, do których klucz ma dostęp. Włączona integracja nasłuchująca
`message.received` sama uruchamia odbiór z usług klucza. Nie trzeba zaznaczać odbioru przy
kluczu ani podawać adresu webhooka.

Warunek działa jak w rozdziale 3.6, tylko na polach zdarzenia. Przykłady: `from zaczyna się od
48601`, `text zaczyna się od POMOC`, `serviceId równe 24138`, `status równe failed`. Dwie
integracje z różnymi warunkami rozdzielają ruch. SMS-y z prefiksem `POMOC` trafiają do helpdesku,
a reszta na telefon przez ntfy.

### 4.2. Żądanie

Sekcja „Wyjście” ma adres, metodę (`POST`, `PUT`, `PATCH`) i nagłówki jako listę par
nazwa-wartość. Wartość jawna może być szablonem, na przykład `Title: SMS od {{ from }}`. Wartość
oznaczona jako sekret jest szyfrowana i maskowana w panelu. Bramka podstawia ją po
renderowaniu, poza silnikiem szablonów. Body to szablon Liquid w jednym z trzech trybów:

| Tryb | Nagłówek `Content-Type` | Uwagi |
|---|---|---|
| JSON z szablonu | `application/json` | wynik musi się parsować; pola tekstowe wstawiaj filtrem `json`, np. `{{ text \| json }}`, który dodaje cudzysłowy i ucieczki |
| formularz | `application/x-www-form-urlencoded` | lista pól, każde z własnym szablonem |
| surowy tekst | `text/plain` | np. ntfy |

Body, które po podstawieniu nie jest poprawnym JSON-em, daje wpis z błędem bez wysyłki
i generuje mail do administratora.

Podpis HMAC bramki (`X-MIG-Signature`, [API](api.md), rozdział 6.1) dołącza się tylko po
zaznaczeniu „Podpisuj żądania”. Wymaga sekretu webhooka klucza, który powstaje razem z adresem
webhooka klucza. Gotowe aplikacje nie obsługują podpisu, więc pole jest domyślnie wyłączone.

### 4.3. Dostawa i ponowienia

Dostawa korzysta z tego samego mechanizmu, co webhook klucza. Aplikacja ma 10 sekund na odpowiedź.
Odpowiedź `2xx` to sukces. Odpowiedź `4xx` kończy dostawę bez ponowień. Odpowiedź `5xx` i błędy
sieci uruchamiają ponowienia po 1, 5 i 15 minutach oraz po 1 i 6 godzinach. Po wyczerpaniu
ponowień powstaje wpis `niedostarczone`, administrator otrzymuje mail, a w dzienniku integracji
pojawia się przycisk „Ponów”.

Adresy w sieci wewnętrznej bramka odrzuca. Wyjątkiem jest środowisko ze zmienną
`MIG_WEBHOOK_ALLOW_PRIVATE=1`. Dotyczy to aplikacji na tym samym serwerze albo w sieci firmowej,
na przykład własnego skryptu albo automatyzacji domowej. W Dockerze zmienną wpisuje się
w `docker/.env`, po czym wykonuje `docker compose up -d`. W kontenerze LXC z Proxmoxa wpisuje
się ją w pliku `/etc/multiinfo-gate/env`, po czym wykonuje `systemctl restart multiinfo-gate`.
Bez tej zmiennej panel odrzuca taki adres już przy zapisie integracji. Komunikat informuje wtedy, że
adres jest w sieci wewnętrznej.

### 4.4. Odczyt odpowiedzi

Pole „ścieżka identyfikatora w odpowiedzi” (na przykład `id` we FreeScoucie i Freshdesku) nakazuje
bramce odczytać z odpowiedzi JSON aplikacji identyfikator założonego zgłoszenia. Dla
`message.received` identyfikator zapisuje się przy odebranej wiadomości. W jej szczególe widać
wiersz „Zgłoszenie: 4821 (FreeScout)”. Integracje własne mogą użyć tego identyfikatora do
odpowiedzi w wątku z rozdziału 3.9. Gdy ścieżka jest wskazana, a w odpowiedzi nie ma wartości,
dostawa jest udana, ale wpis otrzymuje ostrzeżenie.

### 4.5. Wiele integracji i webhook klucza

Jedno zdarzenie może trafić do wielu integracji. Każda ma własną dostawę i własne ponowienia.
Dotychczasowy webhook klucza z rozdziału 6 [API](api.md) działa niezależnie. Nadal wysyła pełne
zdarzenia w formacie bramki, z podpisem.

## 5. Mail2SMS

Od wersji 1.8 bramka odczytuje wskazaną skrzynkę pocztową i zamienia wiadomości e-mail na
SMS-y. Służy do tego integracja „z poczty”, w panelu nazwana Mail2SMS. Jest przeznaczona dla
nadawców, którzy potrafią wysłać wiadomość e-mail, ale nie potrafią wywołać API ani webhooka:
zasilacz UPS zgłasza utratę zasilania, serwer NAS wysyła raport o stanie dysku, starszy system
księgowy informuje o błędzie nocnego przetwarzania, a pracownik wysyła z Outlooka wiadomość,
która ma dotrzeć na trzy telefony. Po stronie urządzenia ani aplikacji nie są potrzebne żadne
zmiany. Wystarczy, aby wiadomość trafiła do skrzynki odczytywanej przez bramkę.

Skrzynka powinna być przeznaczona dla bramki. Bramka przetwarza wyłącznie wiadomości
nieprzeczytane. Jeżeli użytkownik otworzy wiadomość w programie pocztowym, zanim bramka ją
sprawdzi, wiadomość zostanie oznaczona jako przeczytana i SMS nie zostanie wysłany. Zalecane
jest założenie osobnej skrzynki, na przykład `alarmy@firma.pl`, albo wskazanie folderu, do
którego użytkownicy nie zaglądają, a serwer pocztowy kieruje do niego wiadomości regułą
sortowania.

Wiadomość przechodzi przez ten sam potok co zlecenie z aplikacji: warunek, ochronę przed burzą,
szablon, wysyłkę w imieniu klucza API i wpis w dzienniku integracji. SMS-y wysłane na podstawie
wiadomości e-mail są widoczne na ekranie „Wiadomości” z nazwą klucza i nazwą integracji, tak jak
pozostałe.

### 5.1. Skrzynka

Przycisk **Dodaj integrację**, kierunek „Z poczty”, następnie kafelek z nazwą dostawcy. Kafelek
uzupełnia serwer, port i zabezpieczenie, a obok formularza wyświetla instrukcję, gdzie uzyskać
hasło.

![Wybór dostawcy poczty: kafelki Gmail, home.pl, OVH i Własny serwer](obrazki/poczta-katalog.png)

| Kafelek | Serwer | Hasło |
|---|---|---|
| Gmail | `imap.gmail.com`, port 993, TLS | hasło aplikacji, dostępne po włączeniu weryfikacji dwuetapowej w koncie Google; hasło do konta nie jest przyjmowane |
| home.pl | nazwa z Panelu klienta w postaci `serwerNNNNNN.home.pl`, port 993, TLS | hasło skrzynki z Panelu klienta, nie hasło do Panelu |
| OVH | `imap.mail.ovh.net`, port 993, TLS | hasło skrzynki z panelu OVHcloud; usługa Email Pro ma własną nazwę serwera |
| Własny serwer | do wpisania | hasło skrzynki według dostawcy albo administratora serwera |

Skrzynek Outlook.com i Microsoft 365 nie ma na liście. Od września 2024 roku Microsoft nie
przyjmuje do IMAP hasła ani hasła aplikacji, a wyłącznie logowanie OAuth2. Obsługa tego
logowania wejdzie w osobnym wydaniu. Do tego czasu wiadomości z Outlooka można kierować na
skrzynkę u innego dostawcy albo ustawić w Outlooku przekazywanie do takiej skrzynki.

Formularz w trybie prostym ma sekcje ułożone od najważniejszej. Sekcja **Skrzynka** zawiera
serwer, port, zabezpieczenie, login, hasło, folder i częstotliwość sprawdzania.

![Formularz Mail2SMS z kafelka Gmail w trybie prostym: skrzynka, kto może wysyłać, do kogo, co w SMS-ie, po przetworzeniu](obrazki/poczta-formularz.png)

Zabezpieczenie ma trzy wartości. **TLS** oznacza połączenie szyfrowane od początku, zwykle na
porcie 993. Jest to wartość domyślna, właściwa dla każdego serwera dostępnego z internetu.
**STARTTLS** włącza szyfrowanie po powitaniu serwera, zwykle na porcie 143. Jeżeli serwer nie
zaoferuje szyfrowania, połączenie kończy się błędem, nie przesyłaniem danych bez szyfrowania.
**Brak** oznacza połączenie bez szyfrowania. Hasło i treść wiadomości są wówczas przesyłane
w postaci jawnej. Ta wartość jest dopuszczalna wyłącznie dla serwera w sieci wewnętrznej.
Formularz wyświetla przy niej ostrzeżenie, ale nie blokuje zapisu.

Tryb zaawansowany udostępnia pole **Sprawdzaj certyfikat serwera**. Należy je wyłączyć
wyłącznie dla serwera z własnym certyfikatem bez zaufanego urzędu, dostępnego wewnątrz sieci
firmowej. Połączenie bez sprawdzania certyfikatu jest podatne na podsłuch.

Częstotliwość sprawdzania wybiera się z listy od 30 sekund do 60 minut. Wartość domyślna to
jedna minuta. Minimalna częstotliwość wynosi 30 sekund, ponieważ dostawcy poczty blokują
konta logujące się częściej. SMS jest wysyłany natychmiast po odczytaniu wiadomości, więc
częstotliwość decyduje wyłącznie o tym, jak długo wiadomość oczekuje w skrzynce.

Bramka przetwarza wiadomości, które nadejdą po zapisaniu integracji. Starsze wiadomości
nieprzeczytane pozostają nietknięte. Jeżeli mają zostać przetworzone również zaległe, należy
zaznaczyć pole **Przetwórz także zaległe wiadomości nieprzeczytane**. Działa ono jednorazowo,
przy najbliższym sprawdzeniu, po 50 wiadomości na jedno sprawdzenie. Przy dużej zaległości
ochrona przed burzą zatrzyma wysyłkę na limicie integracji, a pozostałe wiadomości otrzymają
w dzienniku wynik „limit”. Zmiana folderu w edycji działa jak ponowne włączenie: bramka znów
rozpoczyna od wiadomości, które nadejdą po zapisaniu. Tak samo działa włączenie wcześniej
wyłączonej skrzynki: wiadomości z okresu wyłączenia nie są przetwarzane.

Przed zapisaniem warto użyć przycisku **Sprawdź połączenie**. Bramka loguje się, otwiera
folder, wyświetla liczbę wiadomości nieprzeczytanych i listę folderów skrzynki. Kliknięcie
nazwy folderu wpisuje ją do pola. Przycisk niczego nie przetwarza ani nie zapisuje. Dla
zapisanej skrzynki używa zapisanego hasła, dopóki serwer, port, zabezpieczenie i login
pozostają bez zmian. Po zmianie któregokolwiek z tych pól hasło należy podać ponownie.

![Wynik „Sprawdź połączenie”: połączenie działa, liczba nieprzeczytanych i lista folderów do kliknięcia](obrazki/poczta-polaczenie.png)

Połączenie ze skrzynką jest wychodzące: z maszyny bramki do serwera poczty na porcie 993 albo
143. W Dockerze ani w Traefiku nie trzeba otwierać żadnego portu. Zapora na serwerze albo
w sieci firmowej musi przepuszczać ten ruch wychodzący.

Serwer poczty w sieci wewnętrznej wymaga osobnej zgody. Bramka domyślnie łączy się wyłącznie
z serwerami o adresach publicznych. Adres z pętli zwrotnej, z zakresów `10/8`, `172.16/12`
i `192.168/16` albo z sieci kontenerów jest odrzucany. Panel odrzuca taki serwer już przy zapisie
skrzynki i w „Sprawdź połączenie”, z komunikatem o zmiennej `MIG_MAIL_ALLOW_PRIVATE`. Zgodę
daje ustawienie `MIG_MAIL_ALLOW_PRIVATE=1` w środowisku bramki. W Dockerze wpisz je do pliku
`docker/.env` i wykonaj `docker compose up -d`. W kontenerze LXC wpisz je do pliku
`/etc/multiinfo-gate/env` i wykonaj `systemctl restart multiinfo-gate`. Zmienna jest osobna od
`MIG_WEBHOOK_ALLOW_PRIVATE`, ponieważ serwer poczty w sieci firmowej to częstszy przypadek niż
aplikacja odbierająca webhooki. Przed połączeniem bramka rozwiązuje nazwę serwera i łączy się
z tym samym adresem, który przeszedł sprawdzenie. Nazwa serwera nadal służy do sprawdzenia
certyfikatu.

### 5.2. Kto może wysyłać

Sekcja **Kto może wysyłać** zawiera listę nadawców. Bramka sprawdza adres z nagłówka `From`.
Wiadomość od nadawcy spoza listy jest pomijana z wpisem w dzienniku. Pusta lista oznacza, że
żadna wiadomość nie zostanie przetworzona. Formularz informuje o tym zdaniem pod listą, ale nie
blokuje zapisu, ponieważ skrzynkę można zapisać i sprawdzić połączenie przed wpisaniem
nadawców.

Jedna pozycja w wierszu. Pozycja to pełny adres albo domena poprzedzona znakiem @. Po dwukropku
można podać numery, na które mają trafiać SMS-y od tego nadawcy, oddzielone przecinkiem:

```
ups@firma.pl: 48601000001, 48601000002
nas@firma.pl: 48601000001
@firma.pl
```

Pierwsza linia dopuszcza wiadomości z zasilacza UPS i kieruje je na dwa numery. Druga dopuszcza
serwer NAS z jednym numerem. Trzecia dopuszcza każdego pracownika z domeny `firma.pl` bez
przypisanych numerów. Domena nie obejmuje poddomen: `@firma.pl` nie pasuje do
`jan@mail.firma.pl`. Wielkość liter nie ma znaczenia. Jeżeli do adresu pasuje zarówno pełny
adres, jak i domena, pierwszeństwo ma pełny adres.

Przełącznik **Wymagaj potwierdzenia nadawcy przez serwer (SPF/DKIM)** nakazuje bramce
sprawdzić, czy serwer skrzynki potwierdził nadawcę. Serwer dodaje na początku wiadomości
nagłówek z wynikiem sprawdzenia SPF i DKIM. Bramka odczytuje wyłącznie ten pierwszy nagłówek
i przepuszcza wiadomość, gdy zawiera on `dkim=pass` albo `spf=pass` dla domeny nadawcy.
Nagłówek dodany przez samego nadawcę znajduje się niżej i nie jest brany pod uwagę. Bez tego
przełącznika osoba znająca adres z listy może go podrobić w nagłówku `From`. Przełącznik jest
zalecany u dostawców publicznych: Gmail, home.pl, OVH. Serwery wewnętrzne zwykle nie dodają
tych nagłówków i wówczas każda wiadomość zostanie odrzucona. Domyślnie wyłączony.

Pole **Nazwa serwera w nagłówku Authentication-Results** (tryb zaawansowany) wzmacnia to
sprawdzenie. Serwer skrzynki podpisuje swój nagłówek własną nazwą, na przykład `mx.google.com`.
Jest to identyfikator authserv-id z RFC 8601. Gdy pole jest wypełnione, pierwszy nagłówek od góry
musi rozpoczynać się od tej nazwy. W przeciwnym razie wiadomość jest odrzucana z powodem „brak
potwierdzenia SPF/DKIM od serwera mx.google.com”. Chroni to przed wiadomością, do której serwer
skrzynki nie dopisał własnego nagłówka, a nadawca podrobił cudzy. Bez nazwy bramka uznałaby
podrobiony nagłówek za nagłówek serwera. Nagłówki położone niżej nie są czytane nigdy, także
z nazwą serwera, ponieważ nadawca może je wpisać sam. Nazwę podpowiada przycisk „Sprawdź
połączenie”: odczytuje ją z ostatniej wiadomości w folderze i wyświetla z przyciskiem wpisującym
ją do pola. Nazwę można też odczytać z nagłówków dowolnej wiadomości w skrzynce, z pierwszego
nagłówka `Authentication-Results`. Puste pole oznacza odczyt pierwszego nagłówka bez sprawdzania
nazwy. Skrzynka za wewnętrznym przekaźnikiem, który dopisuje własny nagłówek nad nagłówkiem
serwera MX, działa tylko wtedy, gdy ten przekaźnik sam sprawdza SPF i DKIM. W polu podaje się
wówczas nazwę przekaźnika.

### 5.3. Do kogo

Bramka ustala odbiorców na trzech poziomach, sprawdzanych po kolei. Pierwszy poziom, który
dostarczy choć jeden numer, decyduje.

1. **Numery wskazane w wiadomości.** Działają wyłącznie po włączeniu przełącznika **Nadawca
   może wskazać numery w wiadomości**. Każdy nadawca z listy może wówczas wysłać SMS na dowolny
   numer na koszt konta. Domyślnie wyłączony.
2. **Numery przypisane do nadawcy** na liście z rozdziału 5.2.
3. **Odbiorcy** w sekcji **Do kogo**, czyli stała lista integracji. Jeden numer w wierszu.

Przykład z zasilaczem UPS: nadawca `ups@firma.pl` ma na liście dwa numery, więc alarm trafia na
oba. Po stronie zasilacza nie są potrzebne żadne ustawienia. Przykład z pracownikiem:
`jan@firma.pl` pasuje do pozycji `@firma.pl` bez numerów. Jeżeli przełącznik numerów
w wiadomości jest włączony, pracownik wpisuje temat
`48601000001, 48601000002: Awaria klimatyzacji w serwerowni` i SMS trafia na oba numery
z tematem bez przedrostka. Jeżeli numerów nie poda, SMS trafia na stałą listę odbiorców. Jeżeli
lista jest pusta, wiadomość otrzymuje wpis „błąd” z powodem „brak numeru odbiorcy”,
a administrator powiadomienie.

Numery w wiadomości mogą znajdować się w jednym z dwóch miejsc. **W temacie, przed
dwukropkiem**: temat rozpoczyna się od numerów oddzielonych przecinkiem, średnikiem albo spacją
i zakończonych dwukropkiem. **W pierwszej linii treści**: pierwsza niepusta linia zawiera
wyłącznie numery z separatorami. Linia ta jest usuwana z treści SMS-a. Temat rozpoczynający
się od liczby, która nie jest numerem telefonu, na przykład `2 serwery niedostępne: sprawdź`,
pozostaje w całości, a bramka przechodzi na kolejny poziom.

Numery są normalizowane zgodnie z rozdziałem 3.3, z kodem kraju konta. Nieprawidłowy numer
podany w wiadomości jest pomijany, a SMS trafia do pozostałych odbiorców. Wpis w dzienniku
otrzymuje informację o pominiętym numerze, administrator powiadomienie regułą „Błąd
integracji”, a nadawca, jeżeli odpowiedzi są włączone, listę pominiętych numerów
w raporcie. Jeżeli wszystkie podane numery są nieprawidłowe, wiadomość jest odrzucana,
ponieważ nadawca wyraźnie wskazał odbiorców. Nieprawidłowy numer na liście nadawców albo na
stałej liście to błąd konfiguracji: SMS nie jest wysyłany, a administrator otrzymuje
powiadomienie do czasu poprawienia listy. Jedna wiadomość może wskazać do 50 numerów.

### 5.4. Treść SMS-a

Bramka zamienia wiadomość na tekst. Odczytuje część tekstową, a jeżeli wiadomość zawiera
wyłącznie HTML, zamienia go na tekst: tabele jako wiersze z komórkami oddzielonymi dwiema
spacjami, odnośniki bez adresów, obrazki pominięte. Załączniki nie są odczytywane ani
zapisywane. Wiadomość większa niż 2 MB jest pomijana bez pobierania.

Z tekstu bramka usuwa elementy zbędne w SMS-ie:

- cytaty: linie rozpoczynające się od `>` oraz wszystko od nagłówka cytatu w dół
  (`W dniu … napisał:`, `On … wrote:`, `-----Original Message-----`,
  `-----Wiadomość oryginalna-----`, blok `Od: … Wysłano: …`),
- podpis: wszystko od linii zawierającej wyłącznie nazwę nadawcy z nagłówka `From`, stojącej
  po pustej linii (kolejność słów i wielkość liter nie mają znaczenia, „Kowalski, Jan” pasuje
  do „Jan Kowalski”), od separatora `-- ` w osobnej linii, od zwrotu kończącego na początku
  krótkiej linii (`Pozdrawiam`, `Z pozdrowieniami`, `Z poważaniem`, `Z wyrazami szacunku`,
  `Dziękuję`, `Best regards`, `Kind regards`, `Regards`, `Sincerely`, `Thanks`) oraz od
  podpisu telefonu albo programu pocztowego na początku linii krótszej niż 60 znaków
  (`Wysłane z iPhone’a`, `Wysłane z iPada`, `Wysłane z urządzenia …`, `Wysłane z aplikacji …`,
  `Wysłano z aplikacji …`, `Sent from my …`, `Get Outlook for …`, `Pobierz aplikację
  Outlook …`),
- stopkę: wszystko od początku klauzuli prawnej (`Ta wiadomość`, `Niniejsza wiadomość`,
  `This e-mail`, `This message`, `Administratorem danych`), od linii zawierającej zwrot
  rejestrowy (`z siedzibą w`, `zarejestrowana w rejestrze`, `zarejestrowany w rejestrze`,
  `registered office`, `registered in England`) oraz od linii zawierającej `kapitał
  zakładowy` albo `Sąd Rejonowy` razem z oznaczeniem spółki albo rejestru (`sp. z o.o.`,
  `S.A.`, `KRS`, `NIP`, `REGON`),
- linie zawierające wyłącznie znacznik obrazka osadzonego `[cid:…]`, który program pocztowy
  zostawia w części tekstowej,
- nadmiarowe białe znaki: spacje na końcach linii, podwójne puste linie.

Zwrot kończący jest rozpoznawany wyłącznie w linii krótszej niż 40 znaków, dzięki czemu zdanie
„Dziękuję za zgłoszenie, jutro przerwa serwisowa” pozostaje w treści. Nazwa nadawcy
jednowyrazowa (na przykład „Biuro”) nie rozpoczyna podpisu, a nazwa w pierwszej linii albo
bezpośrednio pod inną linią (na przykład pod „Zgłaszający:”) jest treścią. Zwrot rejestrowy
`z siedzibą w` kończy treść także w zdaniu nadawcy, dlatego zdanie „Firma z siedzibą w
Warszawie zamawia 3 sztuki” należy sformułować inaczej. Wiadomość składająca się z samego
„Pozdrawiam” albo z samej nazwy nadawcy daje pustą treść i wpis „błąd”.

Urządzenie albo aplikacja ma niekiedy własną stopkę, której lista nie rozpoznaje, na przykład
„Wygenerowano automatycznie przez system monitoringu”. Jej początek należy wpisać w polu
**Pomijaj treść od frazy**, jedna fraza w wierszu, do 10 fraz. Linia rozpoczynająca się od
frazy i wszystko poniżej niej jest usuwane z treści. Wielkość liter nie ma znaczenia.

Sekcja **Co w SMS-ie** zawiera listę wyboru treści: „temat i treść” (temat, nowa linia,
oczyszczona treść), „tylko temat” albo „tylko treść”. Tryb zaawansowany pozwala zamiast tego
zapisać szablon Liquid ze zmiennymi z rozdziału 6.2, na przykład
`{{ subject }} od {{ from_name }}: {{ text | sms_truncate: 120 }}`.

**Limit części** oraz wybór „skróć i wyślij” albo „nie wysyłaj, zapisz błąd i powiadom”
działają jak przy aplikacjach (rozdział 3.5). Wiadomość od człowieka bywa długa, więc przy
„skróć” SMS zawiera początek treści do zadanej liczby części, a przy „nie wysyłaj” wiadomość
otrzymuje wpis „błąd”, administrator powiadomienie, a nadawca odpowiedź, jeżeli odpowiedzi są
włączone.

### 5.5. Wycinki

Wiadomość z urządzenia ma stałą budowę. Zasilacz UPS wysyła na przykład tabelę:

```
Device      UPS-01
Status      ON BATTERY
Error code  E042
```

Przesyłanie całej wiadomości w SMS-ie niepotrzebnie zużywa części. **Wycinki** wyodrębniają
z treści wybrane pola, z których można złożyć krótki SMS. Wycinek ma nazwę i sposób
odnalezienia wartości. W trybie prostym jest to „tekst od frazy początkowej do frazy końcowej”:
wartością jest tekst po frazie początkowej aż do frazy końcowej albo do końca linii. Wycinki
odczytują treść sprzed czyszczenia, ponieważ szukane pole bywa umieszczone poniżej fragmentu,
który czyszczenie uznaje za stopkę. Brak frazy w wiadomości daje pustą wartość, nie błąd.

Krok po kroku na wiadomości z zasilacza UPS:

1. W sekcji **Co w SMS-ie** dodaj trzy wycinki. Nazwa `urzadzenie`, tekst po `Device`. Nazwa
   `stan`, tekst po `Status`. Nazwa `kod`, tekst po `Error code`. Pole „do frazy” pozostaw
   puste, co oznacza koniec linii.
2. Przełącz formularz na tryb **Zaawansowany** i w polu szablonu wpisz
   `{{ fields.urzadzenie }}: {{ fields.stan }}, kod {{ fields.kod }}`.
3. W sekcji **Próbka do sprawdzenia** wklej całą wiadomość z zasilacza. W programie pocztowym
   jest to funkcja „pokaż oryginał” albo zapis do pliku `.eml`. Można też wypełnić trzy pola:
   nadawcę, temat i treść.
4. Kliknij **Sprawdź szablon**. Nadawcę można podać z nazwą, na przykład
   `Jan Kowalski <jan@przyklad.pl>`, wtedy podgląd ucina podpis od nazwy tak jak wysyłka.
   Podgląd pokazuje, czy nadawca jest na liście, odbiorców i poziom,
   z którego pochodzą, wartości wycinków, oczyszczoną treść, gotowy SMS i liczbę części. Podgląd
   niczego nie wysyła ani nie zapisuje.

![Podgląd „Sprawdź szablon” dla wiadomości z zasilacza UPS: nadawca na liście, dwaj odbiorcy z listy nadawcy, trzy wycinki, oczyszczona treść i SMS „UPS-01: ON BATTERY, kod E042”](obrazki/poczta-wycinki.png)

Po uruchomieniu skrzynki próbkę można pobrać z dziennika. Przy włączonym przechowywaniu
ładunków każdy wpis ma odnośnik **Użyj jako próbki**, który otwiera edycję z nadawcą (z nazwą,
jeżeli była w wiadomości), tematem i treścią tej wiadomości.

Tryb zaawansowany dodaje drugi sposób: wyrażenie regularne. Wartością jest pierwsza grupa albo
całe dopasowanie. Dostępne są flagi `i` oraz `m`. Wzorzec może mieć do 200 znaków i 50 ms na
dopasowanie. Wzorzec, którego nie można skompilować, jest odrzucany przy zapisie. Wycinek
`Error code\s+(E\d+)` daje `E042`.

Wycinków może być do 20. W warunku z konstruktora działają jak ścieżki, na przykład
„`fields.stan` równe `ON BATTERY`”. Dzięki temu SMS jest wysyłany wyłącznie przy alarmie, a nie
przy każdym raporcie z urządzenia.

### 5.6. Po przetworzeniu

Sekcja **Po przetworzeniu** określa, co bramka robi z wiadomością po jej przetworzeniu:

| Wybór | Działanie |
|---|---|
| pozostaw w skrzynce | wiadomość otrzymuje oznaczenie „przeczytana” i pozostaje w folderze |
| przenieś do folderu | wiadomość otrzymuje oznaczenie „przeczytana” i trafia do wskazanego folderu; folder, który nie istnieje, bramka tworzy przy pierwszym użyciu |
| usuń | wiadomość jest usuwana; w Gmailu oznacza to przeniesienie do kosza, nie trwałe usunięcie |

Domyślnie „pozostaw w skrzynce”, ponieważ jest to jedyny wybór, który niczego nie usuwa.
Działanie dotyczy także wiadomości pominiętych i odrzuconych: od nadawcy spoza listy, z pustą
treścią, bez numeru. W przeciwnym razie skrzynka zapełniałaby się odrzuconymi wiadomościami.
Nieudane przeniesienie nie cofa SMS-a. Wpis „wysłano” pozostaje, a błąd folderu jest
zapisywany w stanie skrzynki.

Wiadomość ponownie oznaczoną jako nieprzeczytana bramka ignoruje. Zapamiętuje każdą
przetworzoną wiadomość po nagłówku `Message-ID` i po numerze w folderze. Dzięki temu restart
w trakcie sprawdzania ani odtworzenie skrzynki u dostawcy nie powodują wysłania drugiego SMS-a.

### 5.7. Odpowiedź do nadawcy

Przełącznik **Odpowiadaj nadawcy wiadomością e-mail** nakazuje bramce odpowiedzieć na każdą
przetworzoną wiadomość. Wymaga skonfigurowanego SMTP z rozdziału 9.1. Bez SMTP formularz
informuje o tym i wyświetla odnośnik do ustawień. Domyślnie wyłączony.

Odpowiedź jest wysyłana zwykłym tekstem, w wątku wiadomości nadawcy, z tematem `Re: <temat>`.
Nadawcą odpowiedzi jest adres i nazwa z ustawień SMTP na ekranie Powiadomienia.

Po udanej wysyłce nadawca otrzymuje raport minutę po przetworzeniu wiadomości. Minuta
wystarcza, aby raport doręczenia zdążył dotrzeć do bramki. Raport zawiera czas przekazania do
Multiinfo, nadpis, treść SMS-a z liczbą części oraz status przy każdym numerze:

```
SMS z wiadomości „Awaria pompy” wysłany 2026-10-22 o 11:40:05.
Nadpis: Firma Info
Treść (2 części):
Awaria pompy. Proszę o pilny kontakt z serwisem.

Odbiorcy:
48601000001 - doręczona 11:40:14
48601000002 - w drodze

Potwierdzenie doręczenia dla numerów w drodze zostanie dostarczone w kolejnej wiadomości.
```

Status przy numerze to „doręczona” z godziną doręczenia, „w drodze”, „w kolejce”, „błąd” albo
„zablokowana” z godziną i opisem przyczyny, „przedawniona” albo „anulowana” z godziną,
„wysłana, bez potwierdzenia doręczenia” z godziną (Multiinfo zakończyło wiadomość bez raportu
doręczenia), „wstrzymana limitem” albo „brak danych” (wiadomość usunięta z bazy przed
raportem). Status z innego dnia niż wysyłka ma przed godziną datę. Numer nieprawidłowy,
pominięty przy wysyłce, jest wymieniony w osobnym zdaniu. Gdy po minucie każdy numer ma status
ostateczny, raport jest jedyną odpowiedzią. Gdy konto jest wstrzymane i SMS czeka w kolejce
bramki, nagłówek raportu brzmi „przyjęty do wysyłki” zamiast „wysłany”.

Jeżeli któryś numer jest wtedy jeszcze w drodze, bramka sprawdza statusy ponownie: do dwóch
minut od wysyłki co minutę, do pięciu minut co dwie, do 15 minut co pięć, do pół godziny co
dziesięć, do dwóch godzin co trzydzieści, a następnie co godzinę. Gdy wszystkie numery mają
status ostateczny, nadawca otrzymuje drugą wiadomość z wynikiem końcowym:

```
Wynik końcowy SMS-a z wiadomości „Awaria pompy” wysłanego 2026-10-22 o 11:40:05.

Odbiorcy:
48601000001 - doręczona 11:40:14
48601000002 - błąd 12:01:00: numer nie istnieje
```

Sprawdzanie trwa najwyżej 24 godziny od wysyłki. Po tym czasie nadawca otrzymuje wiadomość
z informacją, że doręczenia nie udało się potwierdzić w ciągu 24 godzin i dalsze odpytania
o status nie będą realizowane, wraz z ostatnim znanym statusem każdego numeru.

Po nieudanej wysyłce odpowiedź jest wysyłana natychmiast: `SMS nie został wysłany: treść wymaga
więcej niż 1 części.`, `SMS nie został wysłany: nie udało się ustalić odbiorcy.` albo `SMS nie
został wysłany: przekroczono limit integracji (10 w 10 min).`

Odpowiedź otrzymuje wyłącznie nadawca z listy. Do nadawcy spoza listy bramka nie odpowiada
nigdy. Taka odpowiedź ujawniałaby, że skrzynka jest bramką, a to zachęca do wysyłania spamu.
Bramka nie odpowiada również na wiadomości automatyczne (oznaczone jako wysłane przez system
albo pochodzące z listy dyskusyjnej), na wiadomości pominięte jako zbyt duże albo już
przetworzone ani na wiadomości odrzucone warunkiem, ponieważ te administrator filtruje celowo.

### 5.8. Lista, szczegóły i dziennik

Na liście integracji skrzynka ma kierunek „z poczty”. Kolumna stanu wyświetla zieloną kropkę
i „sprawdzono 2 min temu”, czerwoną i „błąd od 13:05” albo szarą i „wyłączona”. Przycisk
**Z poczty** nad listą ogranicza ją do skrzynek.

![Lista integracji ze skrzynkami: kierunek „z poczty”, stan ze znacznikiem czasu ostatniego sprawdzenia, liczniki z doby](obrazki/poczta-lista.png)

Szczegóły rozpoczynają się od stanu skrzynki: ostatnie sprawdzenie, ostatnie udane, liczba
wiadomości nieprzeczytanych przy ostatnim sprawdzeniu, następne sprawdzenie, a przy awarii
opis błędu. Przycisk **Sprawdź teraz** uruchamia sprawdzenie skrzynki w najbliższej sekundzie,
bez oczekiwania na termin. Przycisk **Utwórz kopię** kopiuje konfigurację razem z hasłem, nadaje
nazwę z dopiskiem „(kopia)”, zapisuje kopię jako wyłączoną i otwiera ją do edycji. W ten sposób
można obsłużyć drugi folder tej samej skrzynki bez ponownego wpisywania hasła. Kopię mają
wszystkie integracje, nie tylko skrzynki.

![Szczegóły skrzynki: stan z przyciskiem Sprawdź teraz, konfiguracja słowami i dziennik z wpisami „wysłano” i „pominięto”](obrazki/poczta-dziennik.png)

Dziennik działa jak w rozdziale 8. Kolumna „Nadawca” zawiera adres z nagłówka `From`, a powód
rozpoczyna się od tematu wiadomości skróconego do 80 znaków. Powody właściwe dla skrzynki:

| Wynik | Powód |
|---|---|
| pominięto | nadawca spoza listy, brak potwierdzenia SPF/DKIM od serwera, wiadomość zbyt duża, wiadomość już przetworzona, warunek niespełniony |
| limit | nadmiar ponad limit burzy |
| błąd | brak numeru odbiorcy, nieprawidłowy numer, pusta treść, treść ponad limit części przy „nie wysyłaj”, błąd szablonu albo wycinka, nieczytelna wiadomość |
| wysłano | SMS zakolejkowany; przy numerach z wiadomości z informacją o pominiętych nieprawidłowych |

Przy włączonym przechowywaniu ładunków wpis zawiera nadawcę, temat, treść po zamianie na tekst,
datę i `Message-ID`. Załączniki nie są zapisywane. Ładunki są zaszyfrowane i usuwane po siedmiu
dniach, tak jak przy aplikacjach.

### 5.9. Gdy skrzynka jest w błędzie

Stan skrzynki na liście i w szczegółach wskazuje przyczynę. Hasło nigdy nie trafia do
komunikatu.

| Rodzaj | Co sprawdzić |
|---|---|
| logowanie | hasło: w Gmailu musi to być hasło aplikacji, w home.pl i OVH hasło skrzynki; login to zwykle pełny adres; w Google Workspace administrator mógł wyłączyć dostęp IMAP |
| sieć | komunikat wskazuje przyczynę: odrzucone połączenie na porcie, nazwa nieznana w DNS, brak odpowiedzi, certyfikat bez zaufanego urzędu, wygasły albo wystawiony na inną nazwę; połączenie można sprawdzić z maszyny bramki, na przykład `nc -vz imap.firma.pl 993`; przy własnym certyfikacie bez zaufanego urzędu pomaga wyłączenie sprawdzania certyfikatu w trybie zaawansowanym; serwer w sieci wewnętrznej bez `MIG_MAIL_ALLOW_PRIVATE=1` daje komunikat o tej zmiennej (rozdział 5.1) |
| folder | nazwa folderu musi być dokładnie taka, jak na liście ze „Sprawdź połączenie”; folder docelowy przeniesienia bywa tylko do odczytu |
| inny | pełny komunikat serwera w stanie skrzynki |

Po błędzie bramka ponawia sprawdzenie z rosnącym odstępem, od ustawionej częstotliwości do
15 minut. Błąd logowania nie jest ponawiany częściej niż co 5 minut, aby bramka nie
zablokowała konta pocztowego kolejnymi nieudanymi próbami. Po udanym sprawdzeniu obowiązuje
ustawiona częstotliwość.

Reguła powiadomień **Awaria skrzynki pocztowej** (rozdział 9.2) wysyła wiadomość do
administratora. Błąd logowania zgłasza natychmiast, ponieważ nie ustąpi samoistnie. Błąd
sieci, folderu albo inny zgłasza, gdy trwa dłużej niż zadana liczba minut, domyślnie 15. Jedna
awaria to jedna wiadomość. Powrót do pracy nie generuje wiadomości; stan jest widoczny
w panelu. Podsumowanie dzienne zawiera liczbę skrzynek i liczbę skrzynek w błędzie.

### 5.10. Bezpieczeństwo

- Hasło skrzynki jest zaszyfrowane kluczem głównym i odczytywane wyłącznie w chwili logowania.
  Nie trafia do logów, dziennika, powiadomień, podglądu ani do kontekstu szablonu. Komunikaty
  błędów serwera przechodzą przez filtr usuwający hasło, login i inne adresy e-mail
- Pusta lista nadawców oznacza brak wysyłki, nigdy „wszyscy”
- Numery z wiadomości i odpowiedzi do nadawcy są domyślnie wyłączone. Włączenie wymaga
  świadomego zaznaczenia pola z opisem skutku
- Bramka odpowiada wyłącznie nadawcom z listy i nigdy na wiadomości automatyczne
- HTML jest zamieniany na tekst, nie wykonywany. Załączniki nie są odczytywane ani zapisywane.
  Wiadomość większa niż 2 MB jest pomijana bez pobierania
- Wyrażenia regularne wycinków mają limit 200 znaków i 50 ms na dopasowanie
- TLS i STARTTLS sprawdzają certyfikat serwera, a wyłączenie sprawdzania jest oznaczone
  ostrzeżeniem. STARTTLS bez oferty szyfrowania od serwera kończy się błędem, nie połączeniem
  bez szyfrowania
- Przy zmianie serwera, portu, zabezpieczenia albo loginu bramka wymaga ponownego podania
  hasła, aby zapisanego hasła nie można było wysłać na inny serwer
- Serwer IMAP w sieci wewnętrznej jest odrzucany bez `MIG_MAIL_ALLOW_PRIVATE=1`, a połączenie
  jest nawiązywane z adresem, który przeszedł sprawdzenie (rozdział 5.1)
- Nazwa serwera w nagłówku Authentication-Results zamyka drogę podrobionym nagłówkom SPF/DKIM.
  Bez nagłówka serwera wiadomość jest odrzucana (rozdział 5.2)

## 6. Szablony Liquid

### 6.1. Składnia w pigułce

Szablony renderuje [LiquidJS](https://liquidjs.com/), odmiana języka Liquid znanego ze Shopify
i Jekylla. Najważniejsze konstrukcje:

| Konstrukcja | Zapis | Przykład |
|---|---|---|
| wartość | `{{ … }}` | `{{ p.monitor.name }}` |
| filtr | `{{ … \| filtr: argument }}` | `{{ p.msg \| sms_truncate: 100 }}` |
| warunek | `{% if %} … {% elsif %} … {% else %} … {% endif %}` | `{% if p.status == "firing" %}ALARM{% else %}OK{% endif %}` |
| pętla | `{% for x in lista limit: 3 %} … {% endfor %}` | `{% for a in p.alerts %}{{ a.labels.alertname }}{% endfor %}` |
| zmienna pomocnicza | `{% capture nazwa %} … {% endcapture %}` | `{% capture msg %}SMS od {{ from }}: {{ text }}{% endcapture %}` |
| przypisanie | `{% assign x = … %}` | `{% assign n = p.alerts \| size %}` |

Silnik pracuje w trybie ścisłym dla filtrów: nieznany filtr to błąd przy zapisie. Dla zmiennych
pracuje w trybie łagodnym: brak pola w ładunku daje pusty ciąg, nie błąd. Szablon nie ma
dostępu do plików ani do innych szablonów, więc `include` i `render` są odrzucane. Limity to
100 ms na renderowanie i 4096 znaków wyniku. Przekroczenie daje wpis `błąd`.

### 6.2. Zmienne

W szablonie dostępne są te zmienne:

| Zmienna | Gdzie | Znaczenie |
|---|---|---|
| `p` | oba kierunki | cały ładunek aplikacji (do SMS) albo całe zdarzenie bramki (z SMS-a); dostęp kropką i indeksem: `p.alerts[0].labels.alertname` |
| `e` | do SMS | odpowiedź na zapytanie uzupełniające, gdy integracja je ma (rozdział 3.4); nazwę można zmienić w ustawieniach zaawansowanych |
| `now` | oba | chwila renderowania, ISO 8601 |
| `integration.name` | oba | nazwa integracji |
| `event`, `at`, `id` | z SMS-a | rodzaj zdarzenia, czas, identyfikator wiadomości |
| `from`, `to`, `text` albo `hex`, `kind`, `receivedAt`, `serviceId`, `relatedMessageId` | `message.received` | jak w rozdziale 6.2 [API](api.md) |
| `status`, `to`, `parts`, `error`, `miStatus`, `miSubstatus`, `providerCode`, `inReplyTo` | statusy | jak w rozdziale 6.2 API; pola zdarzenia leżą też na wierzchu, więc `{{ text }}` i `{{ p.text }}` to to samo |
| `from`, `from_name`, `subject`, `text`, `text_full`, `date`, `to`, `message_id`, `fields.<nazwa>` | Mail2SMS | adres i nazwa nadawcy, temat bez przedrostka z numerami, treść oczyszczona, treść pełna, data w formacie ISO 8601, lista adresatów, `Message-ID`, wycinki z rozdziału 5.5; `p` to cały kontekst |

### 6.3. Filtry bramki

Ponad standardowe filtry Liquida (`upcase`, `strip`, `strip_html`, `truncate`, `append`, `json`
i inne z dokumentacji LiquidJS) bramka dodaje pięć własnych:

| Filtr | Działanie | Przykład |
|---|---|---|
| `sms_truncate: N` | utnij do N znaków z wielokropkiem | `{{ p.heartbeat.msg \| sms_truncate: 100 }}` |
| `gsm` | zamień polskie znaki na łacińskie, żeby część SMS-a mieściła 160 zamiast 70 znaków | `{{ p.text \| gsm }}` |
| `phone` | znormalizuj numer jak w rozdziale 3.3 | `{{ p.contact.phone \| phone }}` |
| `date_pl` | czas w strefie polskiej jako `DD.MM.RRRR GG:MM` | `{{ receivedAt \| date_pl }}` |
| `html_text` | HTML helpdesku na tekst: koniec akapitu i `<br>` jako spacja, bez znaczników, encje odkodowane, białe znaki zbite; samo `strip_html` skleja słowa z sąsiednich bloków | `{{ p.text \| html_text }}` |

### 6.4. Przykłady

SMS o awarii z Uptime Kumy. Zawiera nazwę monitora i skrócony komunikat. Gdy ładunek nie ma
`heartbeat` (tak wygląda ładunek z przycisku „Test”), SMS zawiera sam komunikat:

```liquid
{% if p.heartbeat %}{% if p.heartbeat.status == 0 %}AWARIA{% else %}OK{% endif %}: {{ p.monitor.name }} - {{ p.heartbeat.msg | sms_truncate: 100 }}{% else %}{{ p.msg | sms_truncate: 140 }}{% endif %}
```

Lista alertów z Grafany: do trzech nazw, a dalej liczba pozostałych:

```liquid
{% if p.status == "firing" %}ALARM{% else %}OK{% endif %}: {% for a in p.alerts limit: 3 %}{{ a.labels.alertname }}{% unless forloop.last %}, {% endunless %}{% endfor %}{% if p.alerts.size > 3 %} (+{{ p.alerts.size | minus: 3 }}){% endif %}
```

Body JSON dla aplikacji, która przyjmuje `{"text": "…"}`, na przykład webhooka przychodzącego
Slacka. Szablon składa tekst z odebranego SMS-a przez `capture`, a filtr `json` zamienia go
w poprawny ciąg JSON:

```liquid
{% capture msg %}SMS od {{ from }}: {{ text }}{% endcapture %}{"text": {{ msg | json }}}
```

Zgłoszenie we FreeScoucie z numerem klienta i treścią:

```liquid
{"type": "phone", "mailboxId": 1, "subject": {{ "SMS od " | append: from | json }}, "customer": {"firstName": "SMS", "lastName": {{ from | json }}, "phone": {{ from | json }}}, "threads": [{"type": "customer", "text": {{ text | json }}}]}
```

## 7. Gotowe ustawienia

Gotowe ustawienie wypełnia formularz szablonem, warunkiem, ścieżkami, metodą uwierzytelnienia
i nagłówkami właściwymi dla aplikacji. Obok szablonu pokazuje listę pól jej ładunku oraz
instrukcję „co ustawić w aplikacji”. Lista obejmuje: narzędzia do automatyzacji (Prosty JSON,
n8n), narzędzia do monitoringu (Uptime Kuma, Grafana, Zabbix), aplikacje eCommerce (WooCommerce
w dwóch wariantach), fakturowanie (Fakturownia w dwóch wariantach), zarządzanie inteligentnym
domem (Home Assistant), systemy Help Desk (FreeScout, Freshdesk), CRM (Bitrix24), notyfikacje
(Slack, ntfy) oraz skrzynki pocztowe (Gmail, home.pl, OVH, własny serwer). Ustawienia poczty
uzupełniają wyłącznie serwer i zabezpieczenie; pozostałe pola opisuje rozdział 5. Wartości przykładowe
w tym rozdziale (adresy, numery, identyfikatory) są fikcyjne.

| Ustawienie | Do SMS | Z SMS-a | Uwierzytelnienie do SMS |
|---|---|---|---|
| Prosty JSON | tak | tak | opcjonalny nagłówek |
| n8n | tak | tak | nagłówek `Authorization` |
| Uptime Kuma | tak | nie | nagłówek `Authorization` |
| Grafana | tak | nie | basic auth |
| Zabbix | tak | nie | nagłówek `Authorization` |
| WooCommerce: nowe zamówienie | tak | nie | sam adres wejściowy |
| WooCommerce: status do klienta | tak | nie | sam adres wejściowy |
| Fakturownia: powiadomienie obsługi | tak | nie | sekret w polu ładunku |
| Fakturownia: powiadomienie klienta | tak | nie | sekret w polu ładunku |
| Home Assistant | tak | tak | opcjonalny nagłówek |
| FreeScout: nowe zgłoszenie | tak | nie | lista źródeł |
| FreeScout: zgłoszenie z SMS-a | nie | tak | nie dotyczy |
| Freshdesk: nowe zgłoszenie | tak | nie | sekret w adresie |
| Freshdesk: zgłoszenie z SMS-a | nie | tak | nie dotyczy |
| Slack | nie | tak | nie dotyczy |
| ntfy | nie | tak | nie dotyczy |
| Bitrix24: zadanie z SMS-a | nie | tak | nie dotyczy |
| Gmail | tak, z poczty | nie | hasło aplikacji |
| home.pl | tak, z poczty | nie | hasło skrzynki |
| OVH | tak, z poczty | nie | hasło skrzynki |
| Własny serwer | tak, z poczty | nie | hasło skrzynki |
| Własne | tak | tak | dowolne |

### 7.1. Prosty JSON

Ustawienie dla Make, Zapiera, własnych skryptów i NAS-ów. Nadaje się dla wszystkiego, co
potrafi wysłać żądanie HTTP z dowolnym JSON-em. n8n ma własny kafelek (rozdział 7.2).

**Do SMS.** Aplikacja wysyła `POST` na adres wejściowy z nagłówkiem
`Content-Type: application/json` i takim ładunkiem:

```json
{ "to": "48601000001", "text": "Treść wiadomości" }
```

Pole `to` może być tekstem z numerami po przecinku albo tablicą, do 50 numerów. Numery
w zapisie ludzkim są normalizowane. Pole `inReplyTo` z identyfikatorem zgłoszenia wysyła SMS
jako odpowiedź w wątku. Pole `eventId` chroni przed podwójną wysyłką przy ponowieniu żądania.
Ustawienie odczytuje treść wprost z pola `text` (tryb „pole z ładunku”), do trzech części,
a nadmiar odrzuca. Jeżeli aplikacja ma pole na nagłówki, dodaj w bramce nagłówek z tokenem.

**Z SMS-a.** Bramka wysyła pełne zdarzenie w formacie z rozdziału 6.2 API (`event`, `at`, `id`,
`serviceId`, `from`, `to`, `kind`, `text`, `receivedAt`, `relatedMessageId`). Szablon body to
`{{ p | json }}`.

### 7.2. n8n

SMS z przepływu n8n oraz odebrany SMS jako wyzwalacz przepływu. Ustawienie działa w obie strony.

**Do SMS.** W przepływie dodaj węzeł **HTTP Request**. **Method** ustaw na `POST`, a **URL** to
adres wejściowy integracji. Włącz **Send Body** i ustaw **Body Content Type** na `JSON`. W ciele
podaj dwa pola:

```json
{ "to": "48601000001", "text": "Zadanie zakonczone bledem" }
```

Wartość z poprzedniego węzła wstawia się wyrażeniem, na przykład `{{ $json.telefon }}`. Pole `to`
przyjmuje jeden numer, tekst z numerami po przecinku albo tablicę. Pole `eventId` chroni przed
podwójną wysyłką, gdy n8n ponowi krok. Hasło ustaw w **Authentication → Generic Credential
Type → Header Auth**: nazwa `Authorization`, wartość `Bearer <hasło z bramki>`.

**Z SMS-a.** W przepływie dodaj węzeł **Webhook** i ustaw **HTTP Method** na `POST`. Skopiuj
z węzła adres produkcyjny i wklej go jako adres integracji wychodzącej. Przepływ musi być
zapisany i aktywny, bo adres testowy działa tylko przy otwartym oknie edytora.

Bramka wysyła pełne zdarzenie w tym samym formacie, co przy Prostym JSON-ie. Węzeł Webhook
wkłada je do pola `body`, więc w kolejnych węzłach odczytuje się je wyrażeniami `{{ $json.body.from }}`
i `{{ $json.body.text }}`.

n8n zwykle działa w sieci prywatnej, a bramka domyślnie nie wysyła żądań na adresy prywatne. Ustaw zmienną
`MIG_WEBHOOK_ALLOW_PRIVATE=1` albo wystaw n8n pod adresem publicznym.

### 7.3. Uptime Kuma

SMS przy awarii monitora. W Uptime Kumie otwórz **Ustawienia → Powiadomienia → Dodaj
powiadomienie** i wybierz typ **Webhook**. Wypełnij:

- **Post URL**: adres wejściowy integracji z panelu bramki
- **Request Body**: `application/json`
- **Additional Headers**: `{ "Authorization": "Bearer <token>" }`, gdzie token to wartość
  z pola „Nagłówek z tokenem” w bramce

Uptime Kuma nie przesyła numerów. Wpisz je w bramce w liście zapasowej. Tak wygląda ładunek
z Uptime Kumy 2.5.3, przycięty do istotnych pól (pełny ma około 90 pól monitora):

```json
{
  "heartbeat": { "monitorID": 54, "status": 0, "time": "2026-09-02 17:05:33.920", "msg": "Request failed with status code 403",
                 "important": true, "retries": 2, "timezone": "Europe/Warsaw", "localDateTime": "2026-09-02 19:05:33" },
  "monitor": { "id": 54, "name": "Strona firmowa", "pathName": "Strona firmowa", "url": "https://firma.example", "type": "http", "interval": 60 },
  "msg": "[Strona firmowa] [🔴 Down] Request failed with status code 403"
}
```

Domyślny szablon rozróżnia awarię od powrotu po `heartbeat.status`: 0 to awaria, 1 to powrót.
Przycisk „Test” w Uptime Kumie wysyła ładunek bez `heartbeat`. Wtedy SMS zawiera samo `msg`:

```liquid
{% if p.heartbeat %}{% if p.heartbeat.status == 0 %}AWARIA{% else %}OK{% endif %}: {{ p.monitor.name }} - {{ p.heartbeat.msg | sms_truncate: 100 }}{% else %}{{ p.msg | sms_truncate: 140 }}{% endif %}
```

Aby SMS był wysyłany tylko przy awarii, dodaj warunek `heartbeat.status równe 0`. Bez warunku
wysyłany jest też SMS o powrocie i SMS z przycisku „Test”.

### 7.4. Grafana

SMS z alertów Grafany. W Grafanie otwórz **Alerting → Contact points → Add contact point**
i wybierz integrację **Webhook**. W polu **URL** wpisz adres wejściowy integracji, a w **HTTP
Method** wybierz `POST`. W **Basic Authentication** podaj login `grafana` i hasło wpisane
w bramce w polu „Basic auth”. Numer odbiorcy wpisz w bramce w liście zapasowej.

Grafana wysyła jedno żądanie na grupę alertów. Tak wygląda ładunek z Grafany 13.2 przy jednym
alercie, przycięty o adresy wyciszania i `valueString`:

```json
{
  "receiver": "sms", "status": "firing",
  "alerts": [
    {
      "status": "firing",
      "labels": { "alertname": "CPU high", "grafana_folder": "Alerty", "instance": "web-1", "severity": "critical" },
      "annotations": { "description": "Serwer web-1 jest przeciążony", "summary": "CPU ponad 90% od 5 minut" },
      "startsAt": "2026-09-02T18:56:50Z", "endsAt": "0001-01-01T00:00:00Z",
      "fingerprint": "41980c48991e89ca", "ruleUID": "efx2f25h4uf40b", "values": { "B": 100, "C": 1 }
    }
  ],
  "groupLabels": { "alertname": "CPU high", "grafana_folder": "Alerty" },
  "commonAnnotations": { "description": "Serwer web-1 jest przeciążony", "summary": "CPU ponad 90% od 5 minut" },
  "groupKey": "{}:{alertname=\"CPU high\", grafana_folder=\"Alerty\"}", "appVersion": "13.2.0",
  "title": "[FIRING:1] CPU high Alerty (web-1 critical)", "state": "alerting",
  "message": "**Firing**\n\nValue: B=100, C=1\nLabels:\n - alertname = CPU high\n…"
}
```

Powrót przychodzi w tym samym kształcie. Różni się polem `status` równym `resolved`, tytułem
`[RESOLVED] …`, wypełnionym `endsAt` i `values` równym `null`. Domyślny szablon wypisuje do
trzech nazw alertów i liczbę pozostałych (rozdział 6.4). Klucz grupy `groupKey` jest stały dla
grupy, więc nie nadaje się na identyfikator zdarzenia. SMS o alarmie przychodzi po czasie
**Group wait** polityki powiadomień (domyślnie 30 s). SMS o powrocie przychodzi po **Group
interval** (domyślnie 5 min). Aby otrzymywać SMS tylko o alarmie, dodaj warunek `status równe
firing`.

### 7.5. Zabbix

SMS z akcji Zabbiksa przez typ mediów Webhook. W Zabbiksie otwórz **Alerts → Media types →
Create media type** i wybierz typ **Webhook**. Dodaj parametry: `url` (adres wejściowy
integracji), `token` (ten sam, co w bramce w polu „Nagłówek z tokenem”, z przedrostkiem
`Bearer`), `to` = `{ALERT.SENDTO}`, `subject` = `{ALERT.SUBJECT}`, `message` = `{ALERT.MESSAGE}`,
`eventId` = `{EVENT.ID}`, `status` = `{EVENT.STATUS}`. W zakładce **Message templates** dodaj
szablony dla problemu i dla rozwiązania. Przycisk **Add** podpowiada domyślne. Skrypt typu
mediów:

```js
var p = JSON.parse(value), req = new HttpRequest();
req.addHeader('Content-Type: application/json');
req.addHeader('Authorization: ' + p.token);
var body = { to: p.to, subject: p.subject, message: p.message, eventId: p.eventId + ':' + p.status, status: p.status };
var res = req.post(p.url, JSON.stringify(body));
if (req.getStatus() >= 400) throw 'Bramka odpowiedziała ' + req.getStatus() + ': ' + res;
return 'OK';
```

Przy użytkowniku ustaw medium tego typu z numerem w polu **Send to**. W akcji (**Alerts →
Actions → Trigger actions**) dodaj operację i operację przywracania z tym typem mediów. Tak
wygląda ładunek, który skrypt wysyła (Zabbix 7.4, domyślne szablony wiadomości):

```json
{
  "to": "48601000001",
  "subject": "Problem: High CPU utilization on web-1",
  "message": "Problem started at 18:56:37 on 2026.09.02\r\nProblem name: High CPU utilization on web-1\r\nHost: web-1\r\nSeverity: High\r\nOperational data: 97 %\r\nOriginal problem ID: 26\r\n",
  "eventId": "26:PROBLEM",
  "status": "PROBLEM"
}
```

Rozwiązanie przychodzi z tematem `Resolved in 1m 1s: High CPU utilization on web-1`, polem
`eventId` równym `26:RESOLVED` i `status` równym `RESOLVED`. Domyślny szablon to
`{{ p.subject }}`. Numer pochodzi ze ścieżki `to`, a identyfikator zdarzenia ze ścieżki
`eventId`. Skrypt skleja `{EVENT.ID}` ze statusem, bo Zabbix nadaje rozwiązaniu ten sam
identyfikator co problemowi. Dzięki temu ponowienie tej samej wysyłki bramka odrzuca jako
powtórkę, a SMS o rozwiązaniu przechodzi. Aby nie otrzymywać SMS-a o rozwiązaniu, dodaj warunek
`status równe PROBLEM`.

### 7.6. WooCommerce: nowe zamówienie

SMS do obsługi sklepu o każdym nowym zamówieniu. W sklepie wybierz **WooCommerce → Ustawienia →
Zaawansowane → Webhooki → Dodaj webhook**. **Status** ustaw na `Aktywny`, **Temat** na `Order
created`, a w polu **Adres dostarczenia** wklej adres wejściowy integracji. **Wersję API**
zostaw najnowszą z listy. Pole **Klucz** służy do podpisywania żądań. Bramka obecnie nie sprawdza
podpisu. Wygenerowaną wartość należy pozostawić bez zmian.

Zamówienie nie zawiera numerów obsługi. Wpisz je w bramce w liście odbiorców.

Adres bramki musi kończyć się portem 443, 80 albo 8080. WordPress nie dostarcza webhooków na
inne porty i zapisuje wtedy w dzienniku sklepu „Podano nieprawidłowy adres URL”. Adres HTTPS
bez podanego portu używa portu 443, więc spełnia ten warunek.

Tak wygląda ładunek z WooCommerce 11.1.0, przycięty do istotnych pól (pełny ma 47 pól
zamówienia):

```json
{
  "id": 14, "number": "14", "status": "processing", "currency": "PLN", "total": "49.00",
  "date_created": "2026-09-14T15:33:48", "payment_method_title": "Płatność przy odbiorze",
  "billing": { "first_name": "Anna", "last_name": "Kowalska", "phone": "+48 601 000 001", "email": "anna.kowalska@example.test", "city": "Warszawa" },
  "line_items": [{ "id": 3, "name": "Kubek testowy", "quantity": 1, "total": "49.00" }]
}
```

Domyślny szablon składa numer zamówienia, kwotę i kupującego. Filtr `gsm` zdejmuje polskie znaki
z imienia oraz nazwiska, żeby SMS zmieścił się w jednej części:

```liquid
Nowe zamowienie #{{ p.number }} na {{ p.total }} {{ p.currency }} od {{ p.billing.first_name | gsm }} {{ p.billing.last_name | gsm }}
```

Z ładunku wyżej wychodzi „Nowe zamowienie #14 na 49.00 PLN od Anna Kowalska”. Dwa pozostałe
warianty treści dokładają sposób płatności albo liczbę pozycji.

Warunek ustawienia sprawdza, czy ładunek ma pole `id`. Zaraz po zapisaniu webhooka sklep wysyła
pod ten adres żądanie próbne z ciałem `webhook_id=1`. Warunek je odsiewa, więc bramka odpowiada
kodem 200 i nie wysyła SMS-a. Bez tego warunku zamiast zamówienia zostałby wysłany SMS bez treści,
a sklep pokazałby błąd zapisu.

Gdy bramka jest długo nieosiągalna, sklep wyłącza webhook po siódmej nieudanej próbie
z rzędu. Należy wówczas wrócić do listy webhooków i ustawić **Status** ponownie na `Aktywny`.

WooCommerce nie pozwala dodać własnego nagłówka ani hasła, więc integracji broni sam adres
wejściowy. Adres należy chronić. Po wycieku wymień go przyciskiem obok adresu.

### 7.7. WooCommerce: status do klienta

SMS do kupującego, gdy zmienia się status zamówienia. Webhook zakłada się tak samo, jak przy nowym
zamówieniu. Różnica jest jedna: **Temat** ustaw na `Order updated`.

Numer pochodzi z pola rozliczeniowego zamówienia, czyli z `billing.phone`. Lista zapasowa pozostaje
pusta. Gdy kupujący nie podał telefonu, SMS nie jest wysyłany.

Sklep wysyła żądanie przy każdej zmianie zamówienia, nie tylko przy zmianie statusu. Dlatego
warunek zawęża wysyłkę do wybranego statusu. Domyślnie jest to `processing`, czyli „W trakcie
realizacji”. Bez warunku klient otrzyma SMS także po poprawieniu adresu albo notatki.

Pole rozliczeniowe jest zwykłym tekstem, więc może zawierać dowolny wpis. Drugi warunek
ustawienia przepuszcza tylko to, co wygląda na numer telefonu:

```
billing.phone pasuje do wzorca ^[+(]?[0-9][0-9 ().-]{7,}[0-9]$
```

Wzorzec przyjmuje zapis potoczny: z plusem, ze spacjami, z myślnikami albo w nawiasach. Odsiewa
wpisy w rodzaju „brak” oraz dwa numery w jednym polu. Cyfr nie liczy, więc numer o złej długości
przez warunek przejdzie. Takiego numeru bramka nie odczyta. Dlatego ustawienie ma w sekcji
„Odbiorca” wybrane pominięcie zdarzenia (rozdział 3.3). Sklep otrzymuje wtedy kod 200 i nie liczy
tego jako nieudanego dostarczenia. Aby telefon był w każdym zamówieniu, ustaw go jako pole
wymagane w **WooCommerce → Ustawienia → Ogólne**.

Sklep wysyła jedno żądanie na jedną zmianę, ale kilka kolejnych zmian może połączyć w jedno żądanie. Gdy
w ciągu kilkunastu sekund przestawisz zamówienie z „W trakcie realizacji” na „Zrealizowane”, do
bramki dojdzie tylko stan końcowy. Aby klient otrzymał obie wiadomości, status należy zmieniać
dopiero w chwili rzeczywistej zmiany.

Ładunek ma ten sam kształt, co przy nowym zamówieniu. Zamiast `date_created` niesie
`date_modified` z czasem zmiany. Domyślny szablon zwraca się do kupującego po imieniu:

```liquid
{{ p.billing.first_name | gsm }}, Twoje zamowienie #{{ p.number }} jest w realizacji
```

Z ładunku z poprzedniego podrozdziału wychodzi „Anna, Twoje zamowienie #14 jest w realizacji”.

To jedyne ustawienie w katalogu, które pisze do klienta sklepu, a nie do obsługi. Dlatego
formularz pokazuje nad przyciskiem zapisu uwagę o numerze nadawcy oraz o zgodzie na treści
marketingowe (rozdział 2.2).

![Formularz ustawienia „WooCommerce: status do klienta” w trybie prostym: numer z danych kupującego, trzy warianty statusu, trzy warianty treści jako gotowe SMS-y, uwaga nad przyciskiem zapisu](obrazki/integracja-sklep.png)

Dziennik integracji pokazuje każde żądanie ze sklepu. Zamówienie ze statusem spoza warunku oraz
zamówienie bez telefonu otrzymują wpis `pominięto`, a sklep odpowiedź z kodem 200. Zamówienie,
które przeszło warunek, otrzymuje wpis `wysłano` wraz z odnośnikiem do wiadomości.

![Dziennik integracji ze sklepem: konfiguracja w słowach, wpisy „wysłano” z odnośnikiem do wiadomości i wpisy „pominięto” z powodem](obrazki/integracja-sklep-dziennik.png)

### 7.8. Fakturownia: powiadomienie obsługi

SMS do obsługi o każdej nowej fakturze w Fakturowni.

Fakturownia ma własny dodatek do wysyłki SMS. Działa inaczej niż ta integracja. Tamten wysyła
wiadomości z zegarem, w oknie od 8:00 do 18:00, a liczbę dni przed terminem ustala system.
Bramka wysyła natychmiast po wystawieniu faktury oraz z treścią ustaloną w bramce.

**Webhook.** W Fakturowni wejdź w **Ustawienia**, potem **Ustawienia konta** i zakładkę
**Integracja**. Na dole strony znajdziesz sekcję **Webhooki**. W pierwszym wolnym wierszu ustaw
**Rodzaj** na `invoice:create`. W polu **Adres** wklej adres wejściowy integracji. Zaznacz
**Aktywny** oraz zapisz stronę.

Rodzaj wybierz dokładnie `invoice:create`. Fakturownia wysyła webhooki także dla klientów oraz
produktów. Te zdarzenia mają zupełnie inny kształt. Warunek ustawienia sprawdza, czy ładunek ma
numer faktury, więc bramka je pominie.

**Hasło.** Fakturownia nie ma pola na własny nagłówek. Ma za to pole **Api token** w tym samym
wierszu webhooka. Wpisz w nim dowolne długie hasło. To samo hasło podaj w bramce. Fakturownia
wyśle je w treści żądania, a bramka porówna z zapisanym (rozdział 3.2).

Tak wygląda ładunek zdarzenia `invoice:create`, przycięty do istotnych pól:

```json
{
  "id": 564047351,
  "deal": {
    "name": "Usluga testowa", "price": "123.0", "paid": false, "date": "2026-09-15",
    "invoice_no": "1/09/2026", "kind": "vat", "status": "issued", "currency": "PLN",
    "url": "https://firma.fakturownia.net/f/1-09-2026/przykladowyodnosnik",
    "client": { "name": "Anna Kowalska", "external_ids": { "fakturownia": 276200905 } }
  },
  "app_name": "fakturownia", "locale": "pl"
}
```

Domyślny szablon składa numer faktury, kwotę oraz nazwę nabywcy:

```liquid
Faktura {{ p.deal.invoice_no }} na {{ p.deal.price }} {{ p.deal.currency }} dla {{ p.deal.client.name | gsm | sms_truncate: 40 }}
```

Z ładunku wyżej wychodzi „Faktura 1/09/2026 na 123.0 PLN dla Anna Kowalska”. Drugi wariant treści
podaje numer faktury wraz z odnośnikiem do dokumentu.

Webhook faktury nie zawiera numeru telefonu nabywcy. Dlatego to ustawienie wysyła SMS na numery wpisane
w bramce, w liście odbiorców. Należy tam wpisać numery obsługi. Do powiadamiania klienta służy
następne ustawienie.

Webhook przychodzi z opóźnieniem do minuty od zapisania faktury. Limit burzy jest ustawiony na
60 wiadomości na 10 minut, ponieważ faktury są wystawiane seriami. Przy fakturowaniu miesięcznym powstaje
ich naraz kilkadziesiąt.

### 7.9. Fakturownia: powiadomienie klienta

SMS do nabywcy z numerem faktury oraz odnośnikiem do dokumentu.

Webhook zakłada się tak samo, jak w poprzednim ustawieniu. Rodzaj, adres oraz pole **Api token**
wypełnia się identycznie. Różnica dotyczy źródła numeru telefonu.

**Numer klienta.** Webhook faktury zawiera tylko identyfikator nabywcy. Numer telefonu znajduje się
w kartotece klienta. Bramka odpytuje więc Fakturownię o tę kartotekę i odczytuje z niej pole **Telefon
komórkowy**. Nazywa się to zapytaniem uzupełniającym (rozdział 3.4).

Do zapytania potrzebne są dwie rzeczy. Pierwsza to nazwa konta w Fakturowni, czyli
pierwszy człon adresu panelu: dla `firma.fakturownia.pl` nazwą konta jest
`firma`. Druga to kod autoryzacyjny API, dostępny w tym samym miejscu, co webhooki:
**Ustawienia**, **Ustawienia konta**, zakładka **Integracja**, przycisk **Zobacz ApiTokeny**.
Kod wkleja się w bramce. Jest przechowywany w postaci zaszyfrowanej.

W trybie prostym obie wartości wpisuje się w formularzu. Bramka sama składa z nich adres zapytania.
W trybie zaawansowanym adres widać wprost. Zawiera wtedy znacznik `NAZWA-KONTA`, który należy zastąpić
nazwą konta:

```liquid
https://NAZWA-KONTA.fakturownia.pl/clients/{{ p.deal.client.external_ids.fakturownia | url_encode }}.json
```

Numer pochodzi wyłącznie z pola **Telefon komórkowy**. Numer z pola **Telefon** jest pomijany, ponieważ
bywa stacjonarny i SMS nie zostałby doręczony. Lista zapasowa pozostaje pusta. Gdy kartoteka nie
zawiera numeru komórkowego, SMS nie jest wysyłany.

Kartoteka bez numeru komórkowego oznacza pominięcie faktury. W dzienniku zostaje wpis
`pominięto`, a Fakturownia otrzymuje kod 200. Odpowiedź z kodem 200 jest tutaj istotna. Fakturownia
liczy nieudane dostarczenia i po serii niepowodzeń wyłącza webhook.

Domyślny szablon zwraca się do nabywcy jego nazwą z kartoteki:

```liquid
{{ p.deal.client.name | gsm | sms_truncate: 30 }}, faktura {{ p.deal.invoice_no }} na {{ p.deal.price }} {{ p.deal.currency }}: {{ p.deal.url }}
```

Wychodzi z tego „Anna Kowalska, faktura 1/09/2026 na 123.0 PLN: https://firma.fakturownia.net/f/1-09-2026/przykladowyodnosnik”.

To ustawienie wysyła SMS do klienta, a nie do obsługi. Dlatego formularz pokazuje nad
przyciskiem zapisu uwagę o numerze nadawcy oraz o podstawie do wysyłki na numer klienta
(rozdział 2.2).

![Formularz ustawienia „Fakturownia: powiadomienie klienta” w trybie prostym: pusta lista zapasowa z wyjaśnieniem, dwa warianty chwili wysyłki, dwa warianty treści jako gotowe SMS-y, token webhooka oraz dostęp do kartoteki klienta](obrazki/integracja-fakturownia.png)

Dziennik integracji pokazuje każde powiadomienie z Fakturowni. Faktura dla klienta z numerem
komórkowym w kartotece otrzymuje wpis `wysłano` wraz z odnośnikiem do wiadomości. Faktura dla
klienta bez tego numeru otrzymuje wpis `pominięto` z powodem. Zdarzenie, które nie jest fakturą,
odsiewa warunek.

![Szczegół integracji z Fakturownią: konfiguracja w słowach wraz z adresem zapytania uzupełniającego, pod nią dziennik z wpisami „wysłano” oraz „pominięto”](obrazki/integracja-fakturownia-dziennik.png)

### 7.10. Home Assistant

SMS z automatyzacji Home Assistanta oraz odebrany SMS jako wyzwalacz automatyzacji.

**Do SMS.** W pliku `configuration.yaml` dodaj blok:

```yaml
rest_command:
  sms:
    url: "https://bramka.example/hooks/<identyfikator>"
    method: post
    content_type: "application/json"
    payload: '{"to": {{ to | to_json }}, "text": {{ text | to_json }}}'
```

Filtr `to_json` sam zakłada cudzysłowy. Dzięki temu treść z cudzysłowem albo z przełamaniem
wiersza nie psuje ładunku. W `to` wolno wtedy podać jeden numer albo listę numerów.

Po dodaniu bloku uruchom Home Assistanta ponownie. Samo przeładowanie konfiguracji YAML nie
wystarczy, bo nie wczytuje nowej integracji. Późniejsze zmiany w bloku wystarczy przeładować akcją
`rest_command.reload`.

W automatyzacji wywołaj akcję `rest_command.sms` z danymi `to` oraz `text`. Uwierzytelnianie
nagłówkiem wymaga dopisania do bloku `headers: { Authorization: "Bearer <token>" }`
i wpisania tego samego tokenu w bramce.

**Z SMS-a.** W automatyzacji dodaj wyzwalacz **Webhook** z własnym identyfikatorem. Adresem
integracji wychodzącej jest wtedy `https://<ha>/api/webhook/<identyfikator>`. Bramka wysyła trzy
pola:

```json
{ "from": "48601000001", "text": "Pomocy, nie działa", "receivedAt": "2026-09-02T10:00:00.000Z" }
```

W akcjach automatyzacji odczytuje się je wyrażeniem `{{ trigger.json.text }}`.

Wyzwalacz webhooka ma domyślnie zaznaczone **Tylko z sieci lokalnej**. Jeśli bramka działa poza
siecią Home Assistanta, odznacz to pole albo dopisz do wyzwalacza `local_only: false`. Bez tego
Home Assistant odpowiada kodem 200, a automatyzacja nie uruchamia się. W dzienniku integracji
pojawia się wówczas „dostarczono”, choć automatyzacja nie zadziałała.

Home Assistant zwykle działa w sieci lokalnej, a bramka domyślnie nie wysyła żądań na takie adresy. Ustaw
zmienną `MIG_WEBHOOK_ALLOW_PRIVATE=1` albo wystaw Home Assistanta pod adresem publicznym.

### 7.11. FreeScout: nowe zgłoszenie

SMS do agentów, gdy we FreeScoucie pojawia się nowa rozmowa albo klient odpowiada. Wymaga
modułu **API & Webhooks**. Otwórz Zarządzaj → API & Webhooks → Webhooks → Dodaj. Jako URL wpisz
adres wejściowy integracji, a jako zdarzenia zaznacz `convo.created`
i `convo.customer.reply.created`. Numery agentów wpisz w bramce w liście zapasowej. FreeScout
1.8 wysyła całą rozmowę. Ładunek przycięty:

```json
{
  "id": 45, "number": 10143, "threadsCount": 0, "type": "email", "status": "active", "subject": "[Zgłoszenie] Nie działa logowanie",
  "preview": "Dzień dobry, od rana nie mogę się zalogować do panelu klienta.", "mailboxId": 3,
  "customer": { "id": 8, "type": "customer", "firstName": "Anna", "lastName": "Nowak", "email": "anna@example" },
  "source": { "type": "email", "via": "customer" },
  "_embedded": { "threads": [{ "id": 100, "type": "customer", "body": "<p>Dzień dobry, …</p>" }] }
}
```

Domyślny szablon rozróżnia nową rozmowę od odpowiedzi po liczbie wątków. Filtr `gsm` na całości
zdejmuje polskie znaki, żeby SMS mieścił 160 znaków:

```liquid
{% capture t %}{% if p.threadsCount > 1 %}Odpowiedź klienta w #{{ p.number }}{% else %}Nowe zgłoszenie #{{ p.number }}{% endif %} od {{ p.customer.firstName }} {{ p.customer.lastName }}: {{ p.subject | sms_truncate: 90 }}{% endcapture %}{{ t | gsm }}
```

Warunek `mailboxId równe 3` ogranicza SMS-y do jednej skrzynki. FreeScout nie ma pola na
nagłówki. Zamiast tokenu wpisz więc listę źródeł z adresem serwera FreeScouta. Obiekt
`customer` w webhooku nie zawiera telefonów, nawet gdy kontakt ma numer.

### 7.12. FreeScout: zgłoszenie z SMS-a

Odebrany SMS zakłada rozmowę w skrzynce. Adres to `https://<freescout>/api/conversations`.
Klucz API (moduł API & Webhooks, zakładka **API Keys**) wpisz jako sekret nagłówka
`X-FreeScout-API-Key`. W body zamiast `1` wpisz numer skrzynki `mailboxId`. Domyślne body
zakłada rozmowę typu „phone” z klientem „SMS <numer>” i treścią SMS-a (rozdział 6.4). Klient
ma takie imię, bo FreeScout wymaga imienia albo e-maila klienta, a sam numer odrzuca kodem 400.
FreeScout odpowiada kodem 201 i obiektem rozmowy z polem `id`. Ten identyfikator widać przy
odebranej wiadomości w panelu. Agent widzi rozmowę i oddzwania albo odpisuje własnym kanałem.
Bramka nie wysyła odpowiedzi z FreeScouta SMS-em.

### 7.13. Freshdesk: nowe zgłoszenie

SMS do agentów o nowym zgłoszeniu albo odpowiedzi klienta. We Freshdesku otwórz Admin →
Workflows → Automations i załóż dwie reguły. Obie mają akcję „Uruchom element webhook”
z metodą POST, adresem wejściowym integracji, opcją „Szyfrowanie JSON” i treścią
„Zaawansowane”. Ładunek definiuje treść reguły. Pole `event` wpisuje się na stałe, żeby szablon
odróżnił oba zdarzenia.

Pierwsza reguła: Tworzenie zgłoszeń → Nowa reguła, z warunkiem „Źródło jest” obejmującym
wszystkie źródła. Freshdesk nie zapisuje reguły bez warunku:

```json
{ "event": "nowe", "ticket_id": "{{ticket.id}}", "subject": "{{ticket.subject}}", "phone": "{{ticket.contact.phone}}", "mobile": "{{ticket.contact.mobile}}", "text": "{{ticket.description}}" }
```

Druga reguła: Aktualizacja zgłoszeń → Nowa reguła, zdarzenie „Wysłano odpowiedź” wykonane
przez Zgłaszającego:

```json
{ "event": "odpowiedz", "ticket_id": "{{ticket.id}}", "subject": "{{ticket.subject}}", "phone": "{{ticket.contact.phone}}", "mobile": "{{ticket.contact.mobile}}", "text": "{{ticket.latest_public_comment}}" }
```

Z żywej instancji przy tworzeniu zgłoszenia przyszło:

```json
{ "event": "nowe", "ticket_id": "6541", "phone": "", "mobile": "601000001", "text": "<div>Dzień dobry, od rana nie mogę się zalogować do panelu klienta.</div>\n\n" }
```

Odpowiedź klienta z e-maila niesie w `latest_public_comment` cytowaną korespondencję. Cytat
zaczyna się po znaczniku „----- Original message -----” w bloku `blockquote`. Domyślny szablon
ucina cytat, zdejmuje HTML filtrem `html_text`, dokłada temat, gdy reguła go przesyła, a polskie
znaki zamienia filtrem `gsm`:

```liquid
{% assign tresc = p.text | split: "<blockquote" | first | split: "----- Original message -----" | first %}{% capture t %}{% if p.event == "odpowiedz" %}Odpowiedź klienta w #{{ p.ticket_id }}{% else %}Nowe zgłoszenie #{{ p.ticket_id }}{% endif %}{% if p.subject %}: {{ p.subject }}{% endif %} - {{ tresc | html_text | sms_truncate: 100 }}{% endcapture %}{{ t | gsm }}
```

Numery agentów wpisz w liście zapasowej. Freshdesk nie ma pola na nagłówki, a żądania
przychodzą z różnych adresów chmury AWS. Uwierzytelnieniem zostaje więc sekret w adresie
i limit burzy.

### 7.14. Freshdesk: zgłoszenie z SMS-a

Odebrany SMS zakłada zgłoszenie. Adres to `https://<firma>.freshdesk.com/api/v2/tickets`.
Freshdesk uwierzytelnia przez basic auth: kluczem API jako loginem i literą `X` jako hasłem.
W sekrecie nagłówka `Authorization` wpisz gotową wartość `Basic <base64 z „klucz:X”>`. Klucz
API jest dostępny pod awatarem → Ustawienia profilu. Domyślne body zakłada zgłoszenie ze źródłem
„Telefon”, tematem „SMS od <numer>”, treścią SMS-a i telefonem kontaktu. Freshdesk odpowiada
kodem 201 i obiektem zgłoszenia z polem `id`. Ten identyfikator widać przy odebranej wiadomości
w panelu.

Freshdesk dopasowuje kontakt po dokładnym zapisie numeru. Kontakt z telefonem `48601000001`
zostanie rozpoznany, a z `601000001` nie. W drugim przypadku powstanie nowy kontakt bez
e-maila. Agent widzi zgłoszenie i oddzwania albo odpisuje własnym kanałem. Bramka nie wysyła
odpowiedzi z Freshdeska SMS-em.

### 7.15. Slack

Odebrany SMS jako wiadomość na kanale Slacka. Bramka korzysta z webhooka przychodzącego, czyli
z adresu, który Slack wydaje własnej aplikacji organizacji.

**Aplikacja.** Wejdź na **api.slack.com/apps** i kliknij **Create New App**. Wybierz **From
a manifest**, wskaż przestrzeń i wklej gotowy opis aplikacji:

```yaml
display_information:
  name: Multiinfo Gate
  description: SMS odebrane przez bramkę trafiają na kanał
features:
  bot_user:
    display_name: Multiinfo Gate
    always_online: false
oauth_config:
  scopes:
    bot:
      - incoming-webhook
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Manifest wnosi zakres `incoming-webhook`, więc funkcja webhooków jest włączona od początku. Bez
manifestu: wybierz **Blank app** i włącz funkcję w **Features → Incoming Webhooks**.

**Webhook.** W **Features → Incoming Webhooks** kliknij **Add New Webhook to Workspace**. Wybierz
kanał i potwierdź przyciskiem **Allow**. Adres `https://hooks.slack.com/services/…` wklej jako
adres integracji wychodzącej. Jeden adres obsługuje jeden kanał. Dla drugiego kanału utwórz drugi
webhook tym samym przyciskiem.

Body ma jedno pole `text`:

```liquid
{% capture msg %}SMS od {{ from }}: {{ text }}{% endcapture %}{"text": {{ msg | json }}}
```

Na kanale widać wtedy „SMS od 48601000001: Pomocy, nie działa”. Slack przyjmuje też bloki
(`blocks`), jeśli zmienisz szablon. Nazwę i obrazek, pod którymi bramka pisze na kanale,
ustawisz w **Basic Information → Display Information**.

Pozostałych danych z sekcji **App Credentials** bramka nie potrzebuje. Client Secret oraz Signing
Secret służą do ruchu w drugą stronę, czyli wtedy, gdy to Slack wysyła żądania do
aplikacji.

Adres webhooka pełni rolę hasła: jego posiadacz publikuje na kanale. Należy przechowywać go wyłącznie
w bramce. Po wycieku usuń webhook w ustawieniach aplikacji i utwórz nowy.

W przestrzeni firmowej bywa włączone **Require approved apps**. Wtedy aplikację instaluje osoba
z rolą App Manager, czyli właściciel przestrzeni albo ktoś wskazany przez administratora. Zwykły
członek może jedynie poprosić o zatwierdzenie. Jeśli nie masz tej roli, poproś administratora
Slacka o założenie aplikacji oraz o adres webhooka.

W katalogu aplikacji Slacka jest też gotowa pozycja **Incoming WebHooks**. Daje ten sam adres,
ale to stara integracja. Slack odradza jej zakładanie i zapowiada wycofanie, dlatego zalecana jest własna
aplikacja.

### 7.16. ntfy

Odebrany SMS jako powiadomienie push na telefon. Adres to serwer i nazwa tematu, na przykład
`https://ntfy.sh/firma-sms`. Body jest surowym tekstem `{{ text }}`. Tytuł i priorytet idą
nagłówkami `Title: SMS od {{ from }}` i `Priority: default`. Dla tematu chronionego dodaj
nagłówek `Authorization` z tokenem `Bearer tk_…` jako sekretem. W aplikacji ntfy zasubskrybuj
temat.

### 7.17. Bitrix24: zadanie z SMS-a

Odebrany SMS zakłada w Bitrixie zadanie powiązane z kartoteką klienta. Bramka korzysta
z webhooka przychodzącego, czyli z adresu, który Bitrix wydaje portalowi.

**Webhook.** W Bitrixie wejdź w **Aplikacje**, potem **Zasoby dla programistów** i wybierz
kafelek **Webhook przychodzący**.

**Uprawnienia.** Zaznacz wyłącznie dwa: **CRM (crm)** oraz **Zadania (task)**. Pierwsze pozwala
odnaleźć kontakt po numerze. Drugie pozwala założyć zadanie. Więcej uprawnień nie jest potrzebne.
Każde dodatkowe uprawnienie rozszerza możliwości osoby, która zdobędzie adres.

**Adres.** Bitrix pokaże adres w postaci `https://firma.bitrix24.pl/rest/1/abcdefghij123456/`.
Dopisz na jego końcu `batch.json`. Jest to nazwa wywołania, które przyjmuje paczkę poleceń. Pełny
adres wygląda tak:

```
https://firma.bitrix24.pl/rest/1/abcdefghij123456/batch.json
```

**Numer pracownika.** Zadania trafiają na jedną osobę. Jej numer jest widoczny w adresie profilu
w Bitrixie. Przy `/company/personal/user/1/` numerem jest 1. Wpisz go w formularzu bramki.

Bramka wysyła w jednym żądaniu dwa polecenia. Pierwsze szuka kontaktu po numerze nadawcy. Drugie
zakłada zadanie i wiąże je z tym kontaktem. Bitrix nie ma jednego wywołania, które zrobiłoby oba
kroki naraz. Osobne żądanie z bramki nie znałoby identyfikatora kontaktu:

```liquid
{"halt":0,"cmd":{
"znajdz":"crm.duplicate.findbycomm?entity_type=CONTACT&type=PHONE&values[0]={{ from | prepend: "+" | url_encode }}",
"zadanie":"tasks.task.add?fields[TITLE]={{ "SMS od " | append: from | url_encode }}&fields[DESCRIPTION]={{ text | url_encode }}&fields[RESPONSIBLE_ID]=1&fields[UF_CRM_TASK][0]=C_$result[znajdz][CONTACT][0]"
}}
```

Zapis `$result[znajdz]` jest poleceniem dla Bitrixa. Oznacza wynik pierwszego wywołania. Dzięki
niemu drugie wywołanie zna numer znalezionego kontaktu.

**Czego się spodziewać.** Zadanie ma w tytule numer nadawcy, w opisie treść SMS-a, a w polu CRM
powiązanie z kontaktem. Gdy numer nie pasuje do żadnego kontaktu, zadanie powstaje bez powiązania
oraz czeka na liście zadań pracownika.

**Numery w kartotekach muszą mieć kod kraju.** Bitrix szuka kontaktu po numerze w takim zapisie,
w jakim go otrzymuje. Bramka podaje numer z kodem kraju, czyli `+48601000001`. Kontakt zapisany jako
`+48 601 000 001` zostanie znaleziony, bo Bitrix pomija spacje. Kontakt z samym `601 000 001`
znaleziony nie będzie. Zadanie powstanie wtedy bez powiązania z kartoteką.

![Formularz ustawienia „Bitrix24: zadanie z SMS-a” w trybie prostym: adres webhooka z końcówką batch.json, numer pracownika oraz uwaga, że adres jest hasłem do portalu](obrazki/integracja-bitrix.png)

Adres webhooka pełni rolę hasła: jego posiadacz odczytuje CRM i zakłada zadania. Należy przechowywać go
wyłącznie w bramce. Po wycieku usuń webhook w Bitrixie i utwórz nowy.

Powiadomienia wychodzące z Bitrixa, w tym przypomnienia o rezerwacjach, pojawią się w późniejszym
wydaniu bramki.

### 7.18. Własne

Pusty formularz dla aplikacji spoza listy. Do SMS: wskaż ścieżką pole z numerem albo wpisz
numery w liście zapasowej. Treść podaj jako ścieżkę albo jako szablon z ładunkiem pod `p`.
Wklej przykładowy ładunek aplikacji w polu próbki i użyj przycisku „Sprawdź szablon”. Z SMS-a:
podaj adres, metodę i nagłówki aplikacji. Body napisz jako JSON, formularz albo surowy tekst ze
zmiennymi z rozdziału 6.2.

## 8. Dziennik i próbki

Nazwa integracji na liście prowadzi do ekranu ze szczegółami. Ekran opisuje konfigurację
słowami, a pod nią pokazuje dziennik. Każdy wpis dziennika ma czas, wynik, powód, powiązaną
wiadomość (odnośnik do wysłanej albo odebranej) i adres źródłowy. Przy nieudanej dostawie jest
przycisk **Ponów**.

![Szczegóły integracji: konfiguracja opisana słowami i dziennik z wpisami „wysłano”, „pominięto” oraz „odrzucono”](obrazki/integracja-dziennik.png)

| Wynik | Znaczenie |
|---|---|
| wysłano | SMS zakolejkowany albo dostawa zakolejkowana |
| pominięto | warunek niespełniony albo nieprawidłowy numer z ładunku przy ustawieniu „pomiń” |
| duplikat | identyfikator zdarzenia już był w ciągu doby |
| limit | nadmiar ponad limit burzy |
| odrzucono | nieudane uwierzytelnienie (z adresem źródłowym) |
| błąd | pusta treść, brak numeru, błąd szablonu, treść żądania nie jest JSON-em, klucz albo konto niedostępne |
| dostarczono | aplikacja odpowiedziała `2xx` |
| niedostarczone | ponowienia wyczerpane albo odpowiedź `4xx` |

Dziennik ma stały rozmiar, domyślnie 200 wpisów. Rozmiar ustawia się w sekcji „Ochrona
i dziennik”. Starsze wpisy znikają przy zapisie nowych. Domyślnie bramka nie przechowuje
ładunków, tylko wynik, powód i adres. Po włączeniu „Przechowuj ładunki” wpis otrzymuje rozwijany
blok z ładunkiem i odpowiedzią aplikacji. Otrzymuje też odnośnik **Użyj jako próbki**, który
otwiera edycję z tym ładunkiem w polu próbki. To najszybsza droga do dopasowania szablonu do
prawdziwego formatu aplikacji. Ładunki są zaszyfrowane kluczem głównym i znikają po siedmiu
dniach. Ładunki bywają wrażliwe, dlatego przechowywanie zaleca się włączać tylko na czas konfiguracji.

Ślady integracji widać też na innych ekranach. Szczegóły wiadomości mają wiersz
„Integracja”. Szczegóły odebranej wiadomości mają wiersz „Zgłoszenie” z identyfikatorem oraz
dostawy pod nazwą integracji. Przegląd ma kafelek „Integracje z błędami” z ostrzeżeniem. Edycja klucza pokazuje
listę jego integracji.

## 9. Powiadomienia administratora

Bramka wysyła mailem powiadomienia o błędach integracji, niedostarczonych webhookach,
certyfikatach, kontach, odbiorze, awariach skrzynek pocztowych i nowych wydaniach bramki. Ekran **Powiadomienia** w grupie „Konfiguracja” ma dwie
zakładki: **Konfiguracja** z formularzem SMTP i **Reguły** z tabelą zdarzeń.

![Ekran Powiadomienia, zakładka Konfiguracja: formularz SMTP z przyciskiem maila testowego](obrazki/powiadomienia.png)

### 9.1. SMTP

Formularz ma pola: host, port, szyfrowanie, login i hasło, adres i nazwę wyświetlaną nadawcy,
odbiorców, nazwę instancji i adres panelu. Szyfrowanie to TLS (zwykle port 465), STARTTLS
(zwykle 587) albo brak szyfrowania. Ostatnia opcja wymaga potwierdzenia, że hasło będzie przesyłane
jawnie. Puste hasło przy kolejnym zapisie zachowuje dotychczasowe. Odbiorców wpisuje się po
jednym adresie w wierszu, do 20. Nazwa instancji trafia do tematu każdego maila, co pozwala odróżnić
bramki. Adres panelu jest opcjonalny. Bramka umieszcza go w powiadomieniach jako odnośnik do
właściwego ekranu. Hasło jest zaszyfrowane kluczem głównym.

Po zapisaniu użyj przycisku **Wyślij mail testowy**. Wynik pojawia się na pasku u góry. Przy
błędzie widać pełny komunikat serwera SMTP. Z niego wynika, czy przyczyną jest hasło, port czy
certyfikat. Bez zapisanego SMTP tabela reguł jest wyszarzona, a zgłoszone zdarzenia czekają
w kolejce do 30 dni.

Maile wysyła worker zadaniem `mail`. Przy błędzie ponawia po 1, 5 i 15 minutach. Potem rezygnuje
z wysyłki z wpisem w logu bramki.

### 9.2. Reguły

| Zdarzenie | Domyślnie | Maks. na godzinę | Grupowanie | Parametry |
|---|---|---|---|---|
| Błąd integracji (pusta treść, brak numeru, błąd szablonu, odrzucone uwierzytelnienie, błąd ładunku) | włączone | 5 | co 1 h | - |
| Limit burzy przekroczony | włączone | 5 | brak | - |
| Webhook niedostarczony po wszystkich ponowieniach | włączone | 5 | co 1 h | - |
| Certyfikat konta wygasa | włączone | 1 | brak | dni przed wygaśnięciem: 30, 14, 7, 1 |
| Konto Multiinfo odrzuca wysyłkę (certyfikat, uwierzytelnienie, wstrzymanie) | włączone | 1 | brak | - |
| Awaria odbioru (odpytywanie usługi kończy się błędem dłużej niż podany czas) | włączone | 1 | brak | po minutach: 15 |
| Awaria skrzynki pocztowej (logowanie do IMAP nieudane albo serwer poczty niedostępny dłużej niż podany czas) | włączone | 5 | brak | po minutach: 15 |
| Podsumowanie dzienne (SMS-y, błędy, stan integracji, skrzynek i kont z ostatniej doby) | wyłączone | 1 | brak | godzina: 8 |
| Nowe wydanie bramki (w serwisie GitHub dostępne jest nowsze wydanie niż zainstalowane) | włączone | 1 | brak | - |

Każdą regułę można wyłączyć, zmienić jej limit na godzinę i grupowanie. Limit burzy zgłasza się
raz na okno na integrację (rozdział 3.7). Certyfikat, konto, odbiór i skrzynka zgłaszają się
raz na przyczynę: ten sam próg dni albo ta sama trwająca awaria nie dają drugiego maila. Błąd
logowania do skrzynki jest zgłaszany natychmiast, pozostałe awarie skrzynki po zadanej liczbie
minut. Nowe wydanie
zgłasza się raz na numer wydania. Mail zawiera numer nowego i zainstalowanego wydania,
odnośnik do opisu zmian i do instrukcji aktualizacji (rozdział 7.4 [Uruchomienia](uruchomienie.md)).
Gdy jest nowsze wydanie, wspomina o nim także podsumowanie dzienne.

![Ekran Powiadomienia, zakładka Reguły: tabela zdarzeń z włączeniem, limitem na godzinę, grupowaniem i parametrami](obrazki/powiadomienia-reguly.png)

### 9.3. Grupowanie i limity

Reguła z grupowaniem zbiera zdarzenia w kolejce. Co minutę worker sprawdza, czy od ostatniego
maila tej reguły minęło zadane X godzin. Jeżeli tak, wysyła jeden mail z listą: do 100 pozycji,
a reszta jako liczba. Reguła bez grupowania wysyła mail natychmiast, nie więcej niż N na godzinę.
Nadmiar jest liczony i wspomniany w następnym mailu („pominięto 37 podobnych”). Liczniki są
w bazie, więc restart bramki ich nie kasuje.

### 9.4. Treść maila

Mail to zwykły tekst po polsku, bez HTML. Temat zawiera nazwę instancji, na przykład
`[Multiinfo Gate Firma] Błędy integracji: 3`. Do maila trafia nazwa integracji albo konta,
rodzaj błędu, czas i identyfikator wiadomości. Gdy podano adres panelu, trafia też odnośnik do
właściwego ekranu. Nigdy nie trafia treść SMS-a, ładunek aplikacji, sekret ani pełny numer
telefonu.

## 10. Bezpieczeństwo

- Szablony nie mają dostępu do sekretów konta, klucza ani integracji. Sekretne nagłówki są
  podstawiane po renderowaniu, poza silnikiem, a w podglądzie maskowane
- Ścieżki w ładunku to prosty zapis `a.b[0].c` bez wyrażeń. Nieznane pole daje pusty ciąg
- Ładunki w dzienniku są domyślnie wyłączone. Włączone leżą zaszyfrowane kluczem głównym
  i znikają po siedmiu dniach
- Sekrety integracji, hasło SMTP i hasło skrzynki pocztowej są zaszyfrowane kluczem głównym.
  Nie trafiają do dziennika, audytu, maili, logu ani odpowiedzi HTTP. Zasady właściwe dla
  skrzynek zebrano w rozdziale 5.10
- Adresy integracji z SMS-a w sieci wewnętrznej wymagają `MIG_WEBHOOK_ALLOW_PRIVATE=1`, tak samo
  jak adresy webhooków kluczy
- Adres `/hooks/` ma limit 120 żądań na minutę na adres źródłowy, niezależny od limitów klucza.
  Adres klienta zza odwrotnego proxy bramka odczytuje z `X-Forwarded-For` tylko od adresów
  z `MIG_TRUSTED_PROXIES`
- Dziennik audytu panelu zapisuje utworzenie, zmianę (z listą zmienionych pól), włączenie,
  wyłączenie i usunięcie integracji, wygenerowanie nowego adresu, zmiany SMTP i reguł oraz
  odłożenie wydania, bez sekretów
- Kopia zapasowa bazy obejmuje integracje, dziennik, ustawienia SMTP i kolejkę powiadomień
