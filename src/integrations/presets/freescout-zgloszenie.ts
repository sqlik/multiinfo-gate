import type { Preset } from './types.ts';

export const freescoutZgloszenie: Preset = {
  id: 'freescout-zgloszenie',
  name: 'FreeScout: nowe zgłoszenie',
  blurb: 'SMS do agentów, gdy we FreeScoucie pojawia się nowa rozmowa',
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
    // Bez polskich znaków (filtr gsm) SMS mieści 160 znaków zamiast 70 - temat i nazwisko zwykle je mają.
    text: { mode: 'liquid', template: '{% capture t %}Nowe zgłoszenie #{{ p.number }} od {{ p.customer.firstName }} {{ p.customer.lastName }}: {{ p.subject | sms_truncate: 90 }}{% endcapture %}{{ t | gsm }}' },
    maxParts: 1, overflow: 'truncate',
  },
  expect: { text: 'Nowe zgloszenie #10143 od Anna Nowak: [Zgloszenie] Nie dziala logowanie' },
  sampleSource: 'FreeScout 1.8, prawdziwy webhook convo.created z żywej instancji, 2026-09-02',
  guide: [
    'We FreeScoucie **Zarządzaj → API & Webhooks → Webhooks → Dodaj**: URL to adres wejściowy integracji, zdarzenie `convo.created`, skrzynki wszystkie albo wybrane. Numery agentów wpisz w bramce w liście zapasowej - FreeScout nie wie, kogo budzić.',
    '',
    'Żeby SMS szedł tylko z jednej skrzynki, dodaj warunek `mailboxId równe <numer>` (numer skrzynki widać w adresie jej ustawień). Rozmowy zakładane przez bramkę z SMS-ów też wywołują `convo.created` - agent dostaje wtedy SMS o SMS-ie, co zwykle jest pożądane; warunek `source.via równe customer` odsiewa rozmowy zakładane ręcznie przez agentów.',
    '',
    'FreeScout nie ma pola na nagłówki - zamiast tokenu wpisz w bramce listę źródeł z adresem serwera FreeScouta.',
  ].join('\n'),
};
