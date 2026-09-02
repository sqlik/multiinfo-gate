import type { Preset } from './types.ts';

export const uptimeKuma: Preset = {
  id: 'uptime-kuma',
  name: 'Uptime Kuma',
  blurb: 'SMS przy awarii monitora - powiadomienie typu Webhook',
  kinds: ['webhook_in'],
  // Ładunek DOWN z Uptime Kumy 2.5.3 przycięty do pól, które coś znaczą (pełny ma ~90 pól monitora).
  sample: {
    heartbeat: {
      monitorID: 54, status: 0, time: '2026-09-02 17:05:33.920', msg: 'Request failed with status code 403', important: true, retries: 2,
      timezone: 'Europe/Warsaw', timezoneOffset: '+02:00', localDateTime: '2026-09-02 19:05:33',
    },
    monitor: { id: 54, name: 'Strona firmowa', pathName: 'Strona firmowa', url: 'https://firma.example', type: 'http', interval: 60, active: true },
    msg: '[Strona firmowa] [🔴 Down] Request failed with status code 403',
  },
  fields: [
    { path: 'heartbeat.status', label: '0 = awaria, 1 = działa; brak przy przycisku „Test”' },
    { path: 'heartbeat.msg', label: 'komunikat sprawdzenia, np. „200 - OK” albo błąd' },
    { path: 'heartbeat.localDateTime', label: 'czas sprawdzenia w strefie Uptime Kumy' },
    { path: 'heartbeat.retries', label: 'liczba ponowień przed uznaniem awarii' },
    { path: 'monitor.name', label: 'nazwa monitora' },
    { path: 'monitor.pathName', label: 'nazwa z grupą, np. „Serwery / WWW”' },
    { path: 'monitor.url', label: 'adres monitora' },
    { path: 'msg', label: 'gotowy komunikat Uptime Kumy, np. „[Strona] [🔴 Down] …”' },
  ],
  inbound: {
    auth: { header: { name: 'Authorization', valueRef: 'token' }, sources: [] },
    to: { fallback: [] },
    // Bez heartbeat (przycisk „Test” w Uptime Kumie) zostaje sam komunikat, żeby nie wyszło „OK:  - ”.
    text: { mode: 'liquid', template: '{% if p.heartbeat %}{% if p.heartbeat.status == 0 %}AWARIA{% else %}OK{% endif %}: {{ p.monitor.name }} - {{ p.heartbeat.msg | sms_truncate: 100 }}{% else %}{{ p.msg | sms_truncate: 140 }}{% endif %}' },
    condition: { mode: 'builder', rules: [] },
    maxParts: 1, overflow: 'truncate',
  },
  secrets: [{ ref: 'token', label: 'Token w nagłówku Authorization', hint: 'Wpisz z przedrostkiem, np. Bearer 7f3a…; to samo wklej w Uptime Kumie w polu nagłówków' }],
  expect: { text: 'AWARIA: Strona firmowa - Request failed with status code 403' },
  sampleSource: 'Uptime Kuma 2.5.3, prawdziwe ładunki DOWN, UP i „Test” z żywej instancji, 2026-09-02',
  guide: [
    'W Uptime Kumie: **Ustawienia → Powiadomienia → Dodaj powiadomienie**, typ **Webhook**.',
    '',
    '- **Post URL**: adres wejściowy integracji z panelu bramki',
    '- **Request Body**: `application/json`',
    '- **Additional Headers**: `{ "Authorization": "Bearer <token>" }` z tokenem, który wpisałeś w bramce',
    '',
    'Numer odbiorcy wpisz w bramce w liście zapasowej - Uptime Kuma nie przesyła numerów. Żeby SMS szedł tylko przy awarii, dodaj warunek `heartbeat.status równe 0`; bez warunku przyjdzie też SMS o powrocie (`OK: …`) i SMS z przycisku „Test” w Uptime Kumie (ten ładunek nie ma `heartbeat`, szablon wysyła wtedy samo `msg`).',
  ].join('\n'),
};
