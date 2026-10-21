import type { Preset } from './types.ts';

/** OVH MX Plan: wspólny serwer IMAP, hasło skrzynki. Email Pro ma własne nazwy serwerów. */
export const pocztaOvh: Preset = {
  id: 'poczta-ovh',
  name: 'OVH',
  blurb: 'Skrzynka w usłudze OVH MX Plan, hasło skrzynki',
  kinds: ['mail_in'],
  fields: [],
  mailIn: { imap: { host: 'imap.mail.ovh.net', port: 993, security: 'tls', verifyCert: true, user: '', passRef: 'imap_password' } },
  guide: `Skrzynka z usługi **MX Plan** (poczta przy domenie albo hostingu) łączy się z serwerem \`imap.mail.ovh.net\` na porcie 993 z TLS. Starsza nazwa \`ssl0.ovh.net\` nadal działa.

1. Login to pełny adres skrzynki, np. \`alarmy@firma.pl\`.
2. Hasło to **hasło skrzynki** ustawione w panelu OVHcloud w sekcji Web Cloud, E-maile. Hasło do konta OVHcloud nie jest tu przyjmowane.

Usługa **Email Pro** używa innych serwerów: nazwę w postaci \`proN.mail.ovh.net\` znajdziesz w panelu OVHcloud w zakładce Informacje ogólne, w sekcji Połączenie. Wpisz ją w polu **Serwer IMAP**; port i TLS pozostają bez zmian.`,
  sampleSource: 'Adresy serwerów według dokumentacji OVHcloud „MX Plan - konfiguracja konta e-mail” (Mail dla macOS, Outlook), sprawdzone 2026-10-21',
};
