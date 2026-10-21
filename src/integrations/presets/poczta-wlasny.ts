import type { Preset } from './types.ts';

/** Skrzynka na dowolnym serwerze IMAP: ustawienie nie wypełnia nic, instrukcja tłumaczy trzy zabezpieczenia. */
export const pocztaWlasny: Preset = {
  id: 'poczta-wlasny',
  name: 'Własny serwer',
  blurb: 'Dowolna skrzynka IMAP: serwer firmowy, hosting, inny dostawca',
  kinds: ['mail_in'],
  fields: [],
  mailIn: {},
  guide: `Wpisz serwer IMAP, port, login i hasło skrzynki. Dane te znajdziesz w ustawieniach poczty u dostawcy, zwykle w sekcji „konfiguracja programu pocztowego” albo „IMAP”.

**Zabezpieczenie**

- **TLS**: połączenie szyfrowane od początku, zwykle port 993. Ustawienie domyślne, właściwe dla każdego serwera dostępnego z internetu.
- **STARTTLS**: szyfrowanie włączane po powitaniu serwera, zwykle port 143. Jeżeli serwer nie zaoferuje szyfrowania, połączenie kończy się błędem, nie przesyłaniem danych bez szyfrowania.
- **Brak**: bez szyfrowania, port 143. Hasło i treść wiadomości są przesyłane w postaci jawnej. Wyłącznie dla serwera w sieci wewnętrznej.

**Sprawdzanie certyfikatu** (tryb zaawansowany) wyłącz wyłącznie wtedy, gdy serwer ma własny certyfikat bez zaufanego urzędu, a połączenie przebiega wewnątrz sieci firmowej.

Po wpisaniu danych kliknij **Sprawdź połączenie**: bramka zaloguje się, policzy wiadomości nieprzeczytane i wyświetli listę folderów skrzynki.`,
};
