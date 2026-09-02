# Multiinfo Gate

Bramka SMS między Twoimi aplikacjami a API Multiinfo (Plus, Polkomtel). Trzyma certyfikat
kliencki, login i hasło do Multiinfo w jednym miejscu, a aplikacjom wystawia proste HTTP API
z kluczem w nagłówku. Aplikacja wysyłająca SMS-y nie instaluje certyfikatów i nie zna ASPX.

![Przegląd: liczniki wiadomości wychodzących i odebranych z ostatniej doby, stan połączeń z Multiinfo i ostatnie niepowodzenia](docs/obrazki/przeglad.png)

![Szczegół wiadomości z podziałem na pięć części UCS-2, przebiegiem doręczenia i śladem protokołu](docs/obrazki/wiadomosc-dluga.png)

## Dla kogo

Dla firmy z kontem Multiinfo, która chce dać własnym systemom albo agencji zewnętrznej
jedno API zamiast certyfikatów, oraz panel do zarządzania kontami, kluczami i podglądu
doręczeń.

Od wersji 1.3 bramka odbiera też SMS-y od abonentów: przekazuje je aplikacji powiadomieniem
`message.received`, udostępnia do odczytu przez `GET /v1/inbound` i pozwala odpowiedzieć
w wątku (`inReplyTo`). Od wersji 1.5 integruje się z aplikacjami o narzuconym formacie
(Uptime Kuma, Grafana, Zabbix, FreeScout, Freshdesk, ntfy) przez
adres wejściowy `/hooks/` i szablony Liquid, a administratora powiadamia mailem o błędach
i certyfikatach.

## Co trzeba mieć

- Konto Multiinfo z użytkownikiem API i certyfikatem (`.pfx` z hasłem)
- ID usługi (z panelu Multiinfo albo od opiekuna technicznego Polkomtela) i, jeżeli mają być używane, nadpisy nadawcy uruchomione przez Polkomtel na wniosek z panelu Multiinfo
- Serwer Linux (Ubuntu 24.04) z Dockerem (wystarczy najmniejsza maszyna w chmurze, x86-64 albo ARM64) albo własny Proxmox VE, na którym skrypt tworzy gotowy kontener LXC bez Dockera

## Instalacja

Bramka działa z gotowego obrazu `ghcr.io/sqlik/multiinfo-gate`, publikowanego przy każdym
wydaniu. Do uruchomienia wystarczą pliki z katalogu `docker/`, klucz główny w `docker/.env`
i `docker compose up -d`; HTTPS pod własną domeną daje Caddy, nginx albo Traefik według
wyboru. Na Proxmox VE jedno polecenie w powłoce hosta tworzy kontener LXC z zainstalowaną bramką
(rozdział 9 instrukcji). Kolejne kroki, od konta Multiinfo po wystawienie API na świat, opisuje
instrukcja poniżej.

## Dokumentacja

Strona dokumentacji: [sqlik.github.io/multiinfo-gate](https://sqlik.github.io/multiinfo-gate/)

- [Uruchomienie krok po kroku](https://sqlik.github.io/multiinfo-gate/uruchomienie/) - od konta Multiinfo do pierwszego SMS-a i wystawienia API na świat
- [API dla aplikacji](https://sqlik.github.io/multiinfo-gate/api/) - każde wywołanie z przykładem w siedmiu wariantach (curl, HTTP, PHP, Python, Node.js, PowerShell, C#), webhooki, błędy, limity
- [Integracje z aplikacjami](https://sqlik.github.io/multiinfo-gate/integracje/) - adres wejściowy dla aplikacji z własnym formatem, szablony Liquid, gotowe ustawienia, powiadomienia administratora mailem
- [Przykład w PHP](examples/php/) - strona testowa i kod do skopiowania

Źródłem strony są pliki w katalogu [`docs/`](docs/); przykłady z zakładkami czytają się w nich
gorzej niż na stronie, bo GitHub nie wyświetla zakładek.

## Licencja

MIT, patrz [LICENSE](LICENSE).
