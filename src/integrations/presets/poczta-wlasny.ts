import type { Preset } from './types.ts';

/** Skrzynka na dowolnym serwerze IMAP: ustawienie nie wypełnia nic, instrukcja tłumaczy trzy zabezpieczenia. */
export const pocztaWlasny: Preset = {
  id: 'poczta-wlasny',
  name: 'Własny serwer',
  blurb: 'Dowolna skrzynka IMAP: serwer firmowy, hosting, inny dostawca',
  kinds: ['mail_in'],
  fields: [],
  mailIn: {},
  guide: `Wpisz serwer IMAP, port, login i hasło skrzynki. Dane znajdziesz w ustawieniach poczty u swojego dostawcy, zwykle pod hasłem „konfiguracja programu pocztowego” albo „IMAP”.

**Zabezpieczenie**

- **TLS**: połączenie szyfrowane od początku, zwykle port 993. To ustawienie domyślne i właściwe dla każdego serwera w internecie.
- **STARTTLS**: szyfrowanie włączane po powitaniu serwera, zwykle port 143. Serwer, który go nie zaoferuje, dostaje błąd, nie połączenie jawne.
- **Brak**: bez szyfrowania, port 143. Hasło i treść maili idą po sieci jawnym tekstem. Tylko dla serwera w sieci wewnętrznej.

**Sprawdzanie certyfikatu** (tryb zaawansowany) wyłącz tylko wtedy, gdy serwer ma własny certyfikat bez zaufanego urzędu, a połączenie idzie wewnątrz sieci firmowej.

Po wpisaniu danych kliknij **Sprawdź połączenie**: bramka zaloguje się, policzy nieprzeczytane maile i pokaże listę folderów skrzynki.`,
};
