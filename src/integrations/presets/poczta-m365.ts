import { M365_DOCS_URL } from '../../docs-links.ts';
import { M365_IMAP } from '../../m365/oauth.ts';
import type { Preset } from './types.ts';

/**
 * Microsoft 365: logowanie kontem z ekranu „Konta Microsoft 365” (XOAUTH2), bez hasła w integracji.
 * `accountId: 0` oznacza konto jeszcze niewybrane; formularz podstawia pierwsze połączone. Potwierdzenie nadawcy
 * domyślnie włączone: w tym trybie przepuszcza także pocztę wewnętrzną z domeny skrzynki.
 */
export const pocztaM365: Preset = {
  id: 'poczta-m365',
  name: 'Microsoft 365',
  blurb: 'Skrzynka Microsoft 365 z logowaniem przez konto organizacji',
  kinds: ['mail_in'],
  fields: [],
  mailIn: { imap: { ...M365_IMAP, user: '', passRef: 'imap_password', auth: { mode: 'm365', accountId: 0 } }, requireAuthResults: true },
  guide: `Bramka loguje się do skrzynki kontem dodanym na ekranie **Konta Microsoft 365**, dlatego integracja nie przechowuje hasła. Przygotowanie skrzynki bramki w Microsoft 365 i Entra ID opisuje rozdział 4.8 dokumentacji: ${M365_DOCS_URL}

1. W centrum administracyjnym Microsoft 365, na karcie **Poczta** skrzynki bramki, w zarządzaniu aplikacjami poczty zaznacz **IMAP**.
2. Dodaj konto na ekranie **Konta Microsoft 365** i zaloguj je adresem skrzynki bramki przyciskiem **Zaloguj w Microsoft**.
3. W formularzu wybierz konto z listy. Puste pole **Adres skrzynki** oznacza adres tego konta.
4. Aby odczytywać skrzynkę współdzieloną, wpisz jej adres w polu **Adres skrzynki**. Skrzynka bramki wymaga do niej uprawnienia pełnego dostępu.

Zmiana ustawienia IMAP w skrzynce bramki zaczyna obowiązywać po około 30 minutach.`,
  sampleSource: 'Logowanie XOAUTH2 do outlook.office365.com:993 adresem skrzynki bramki, sprawdzone w tenancie testowym 2026-11-04',
};
