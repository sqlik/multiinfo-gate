import type { Preset } from './types.ts';

/** Gmail: IMAP zawsze włączony, logowanie hasłem aplikacji po włączeniu weryfikacji dwuetapowej. */
export const pocztaGmail: Preset = {
  id: 'poczta-gmail',
  name: 'Gmail',
  blurb: 'Skrzynka Gmail albo Google Workspace z hasłem aplikacji',
  kinds: ['mail_in'],
  fields: [],
  mailIn: { imap: { host: 'imap.gmail.com', port: 993, security: 'tls', verifyCert: true, user: '', passRef: 'imap_password' } },
  guide: `Do logowania bramka wymaga **hasła aplikacji**, nie hasła do konta Google. Hasło aplikacji jest dostępne po włączeniu weryfikacji dwuetapowej.

1. Otwórz **Konto Google**, zakładkę **Bezpieczeństwo**.
2. Włącz **Weryfikację dwuetapową**, jeśli nie jest jeszcze aktywna.
3. Przejdź do sekcji **Hasła do aplikacji** (na tej samej zakładce albo przez wyszukiwarkę ustawień), nadaj nazwę, np. „Bramka SMS”, i skopiuj 16-znakowe hasło.
4. W formularzu wpisz pełny adres Gmaila jako login oraz skopiowane hasło jako hasło skrzynki.

Dostępu IMAP nie trzeba włączać: od stycznia 2025 roku jest w Gmailu włączony na stałe. W Google Workspace administrator organizacji może go wyłączyć; wówczas należy go odblokować w konsoli administracyjnej.

Działanie **usuń** oznacza w Gmailu przeniesienie do kosza, nie trwałe usunięcie. **Przenieś do folderu** tworzy etykietę o nazwie folderu.`,
  sampleSource: 'Adres serwera i zasady dostępu IMAP według pomocy Google „Ustawienia klienta IMAP w Gmailu” i „Hasła do aplikacji”, sprawdzone 2026-10-21',
};
