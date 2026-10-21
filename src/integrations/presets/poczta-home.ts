import type { Preset } from './types.ts';

/** home.pl: każda skrzynka ma własną nazwę serwera z Panelu klienta; port i TLS są wspólne. */
export const pocztaHome: Preset = {
  id: 'poczta-home',
  name: 'home.pl',
  blurb: 'Skrzynka na hostingu home.pl, hasło skrzynki',
  kinds: ['mail_in'],
  fields: [],
  mailIn: { imap: { host: '', port: 993, security: 'tls', verifyCert: true, user: '', passRef: 'imap_password' } },
  guide: `home.pl nie ma jednego adresu serwera poczty. Każdy serwer ma własną nazwę w postaci \`serwerNNNNNN.home.pl\`.

1. Zaloguj się do **Panelu klienta** home.pl i otwórz sekcję **Poczta**.
2. Przy skrzynce znajdź dane do programu pocztowego: nazwę serwera poczty przychodzącej (IMAP).
3. Wpisz tę nazwę w polu **Serwer IMAP**. Port 993 i TLS są już ustawione.
4. Login to pełny adres skrzynki. Hasło to **hasło skrzynki**, nie hasło do Panelu klienta.

Gdy serwer odrzuca logowanie, sprawdź hasło skrzynki w Panelu klienta: można je tam zmienić bez wpływu na hasło do Panelu.`,
  sampleSource: 'Port i szyfrowanie według pomocy home.pl „Numery portów używane w konfiguracji serwera home.pl” oraz „Konfiguracja programu pocztowego - Mozilla Thunderbird”, sprawdzone 2026-10-21; nazwa serwera jest przypisana do konta',
};
