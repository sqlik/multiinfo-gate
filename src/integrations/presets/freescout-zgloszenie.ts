import type { InboundConfig } from '../config.ts';
import type { Preset } from './types.ts';

/** Domyślna treść SMS-a - pierwszy wariant w trybie prostym i szablon w zaawansowanym. */
// Bez polskich znaków (filtr gsm) SMS mieści 160 znaków zamiast 70 - temat i nazwisko zwykle je mają.
const TEKST: InboundConfig['text'] = { mode: 'liquid', template: '{% capture t %}{% if p.threadsCount > 1 %}Odpowiedź klienta w #{{ p.number }}{% else %}Nowe zgłoszenie #{{ p.number }}{% endif %} od {{ p.customer.firstName }} {{ p.customer.lastName }}: {{ p.subject | sms_truncate: 90 }}{% endcapture %}{{ t | gsm }}' };

export const freescoutZgloszenie: Preset = {
  id: 'freescout-zgloszenie',
  name: 'FreeScout: nowe zgłoszenie',
  blurb: 'SMS do agentów o nowej rozmowie albo odpowiedzi klienta we FreeScoucie',
  kinds: ['webhook_in'],
  // Webhook convo.created z FreeScouta 1.8 (przycięty): rozmowa z e-maila klienta.
  sample: {
    id: 45, number: 10143, threadsCount: 0, type: 'email', folderId: 19, status: 'active', state: 'published',
    subject: '[Zgłoszenie] Nie działa logowanie', preview: 'Dzień dobry, od rana nie mogę się zalogować do panelu klienta.',
    mailboxId: 3, assignee: null,
    createdBy: { id: 8, type: 'customer', firstName: 'Anna', lastName: 'Nowak', photoUrl: '', email: 'anna@example' },
    createdAt: '2026-09-02T17:16:09Z', updatedAt: '2026-09-02T17:16:09Z',
    customerWaitingSince: { time: '2026-09-02T17:16:09Z', friendly: 'Właśnie teraz', latestReplyFrom: 'customer' },
    source: { type: 'email', via: 'customer' },
    customer: { id: 8, type: 'customer', firstName: 'Anna', lastName: 'Nowak', photoUrl: '', email: 'anna@example' },
    _embedded: { threads: [{ id: 100, type: 'customer', status: 'active', state: 'published', body: '<p>Dzień dobry, od rana nie mogę się zalogować do panelu klienta.</p>', createdAt: '2026-09-02T17:16:09Z' }] },
  },
  fields: [
    { path: 'number', label: 'numer rozmowy widoczny we FreeScoucie' },
    { path: 'threadsCount', label: 'liczba wątków; 0 przy nowej rozmowie, więcej przy odpowiedzi klienta' },
    { path: 'subject', label: 'temat' },
    { path: 'preview', label: 'początek treści jako czysty tekst' },
    { path: 'customer.firstName', label: 'imię klienta' },
    { path: 'customer.lastName', label: 'nazwisko klienta' },
    { path: 'customer.email', label: 'e-mail klienta' },
    { path: 'mailboxId', label: 'numer skrzynki - do warunku, gdy SMS ma budzić tylko przy jednej' },
    { path: 'type', label: 'email, phone albo chat' },
    { path: 'source.via', label: 'customer = od klienta, user = założona przez agenta' },
  ],
  inbound: {
    to: { fallback: [] },
    text: TEKST,
    maxParts: 1, overflow: 'truncate',
  },
  expect: { text: 'Nowe zgloszenie #10143 od Anna Nowak: [Zgloszenie] Nie dziala logowanie' },
  sampleSource: 'FreeScout 1.8, żywa instancja, 2026-09-02: webhooki convo.created (threadsCount 0) i convo.customer.reply.created (threadsCount 3)',
  simple: {
    inbound: {
      addressField: 'we FreeScoucie w polu URL webhooka',
      recipients: { source: 'list', note: 'FreeScout nie przesyła numerów agentów, więc SMS idzie zawsze na numery wpisane tutaj.' },
      when: [
        { id: 'nowe-i-odpowiedzi', label: 'przy nowej rozmowie i przy odpowiedzi klienta', condition: { mode: 'builder', rules: [] } },
        { id: 'tylko-nowe', label: 'tylko przy nowej rozmowie', condition: { mode: 'builder', rules: [{ path: 'threadsCount', op: 'lt', value: '2' }] } },
      ],
      text: [
        { id: 'z-tematem', label: 'numer rozmowy, klient i temat', text: TEKST },
        { id: 'krotko', label: 'numer rozmowy i klient', text: { mode: 'liquid', template: '{% capture t %}{% if p.threadsCount > 1 %}Odpowiedź klienta w #{{ p.number }}{% else %}Nowe zgłoszenie #{{ p.number }}{% endif %} od {{ p.customer.firstName }} {{ p.customer.lastName }}{% endcapture %}{{ t | gsm }}' } },
      ],
      auth: { kind: 'none', note: 'FreeScout nie ma pola na hasło ani nagłówki. Zabezpieczeniem jest sekret w adresie wejściowym; w trybie zaawansowanym można dopisać adres serwera FreeScouta do listy dozwolonych źródeł.' },
    },
  },
  guide: [
    'We FreeScoucie **Zarządzaj → API & Webhooks → Webhooks → Dodaj**: URL to adres wejściowy integracji, zdarzenia `convo.created` (nowa rozmowa) i `convo.customer.reply.created` (odpowiedź klienta), skrzynki wszystkie albo wybrane. Numery agentów wpisz w bramce w liście zapasowej - FreeScout nie wie, kogo budzić. Szablon rozróżnia oba zdarzenia po liczbie wątków.',
    '',
    'Żeby SMS szedł tylko z jednej skrzynki, dodaj warunek `mailboxId równe <numer>` (numer skrzynki widać w adresie jej ustawień). Rozmowy zakładane przez bramkę z SMS-ów (ustawienie „FreeScout: zgłoszenie z SMS-a”) też wywołują `convo.created`, więc agent dostaje SMS o SMS-ie.',
    '',
    'FreeScout nie ma pola na nagłówki - zamiast tokenu wpisz w bramce listę źródeł z adresem serwera FreeScouta.',
  ].join('\n'),
};
