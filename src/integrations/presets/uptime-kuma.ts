import type { InboundConfig } from '../config.ts';
import type { Preset } from './types.ts';

/** Domyślna treść SMS-a - pierwszy wariant w trybie prostym i szablon w zaawansowanym. */
// Bez heartbeat (przycisk „Test” w Uptime Kumie) zostaje sam komunikat, żeby nie wyszło „OK:  - ”.
const TEKST: InboundConfig['text'] = { mode: 'liquid', template: '{% if p.heartbeat %}{% if p.heartbeat.status == 0 %}AWARIA{% else %}OK{% endif %}: {{ p.monitor.name }} - {{ p.heartbeat.msg | sms_truncate: 100 }}{% else %}{{ p.msg | sms_truncate: 140 }}{% endif %}' };

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
    text: TEKST,
    condition: { mode: 'builder', rules: [] },
    maxParts: 1, overflow: 'truncate',
  },
  secrets: [{ ref: 'token', label: 'Token w nagłówku Authorization', hint: 'Wpisz z przedrostkiem, np. Bearer 7f3a…; to samo wklej w Uptime Kumie w polu nagłówków' }],
  expect: { text: 'AWARIA: Strona firmowa - Request failed with status code 403' },
  sampleSource: 'Uptime Kuma 2.5.3, prawdziwe ładunki DOWN, UP i „Test” z żywej instancji, 2026-09-02',
  simple: {
    inbound: {
      addressField: 'w Uptime Kumie w polu Post URL powiadomienia typu Webhook',
      recipients: { source: 'list', note: 'Uptime Kuma nie przesyła numerów telefonów, więc SMS idzie zawsze na numery wpisane tutaj.' },
      when: [
        { id: 'awaria', label: 'tylko gdy monitor przestanie działać', condition: { mode: 'builder', rules: [{ path: 'heartbeat.status', op: 'eq', value: '0' }] } },
        { id: 'awaria-i-powrot', label: 'gdy przestanie działać i gdy wróci', condition: { mode: 'builder', rules: [{ path: 'heartbeat', op: 'exists', value: '' }] } },
        { id: 'zawsze', label: 'zawsze, także przy przycisku „Test” w Uptime Kumie', condition: { mode: 'builder', rules: [] } },
      ],
      text: [
        { id: 'z-komunikatem', label: 'stan, nazwa monitora i komunikat błędu', text: TEKST },
        { id: 'krotko', label: 'tylko stan i nazwa monitora', text: { mode: 'liquid', template: '{% if p.heartbeat %}{% if p.heartbeat.status == 0 %}AWARIA{% else %}OK{% endif %}: {{ p.monitor.name }}{% else %}{{ p.msg | sms_truncate: 140 }}{% endif %}' } },
      ],
      auth: { kind: 'header', name: 'Authorization', prefix: 'Bearer ', label: 'Hasło, które wpiszesz też w Uptime Kumie', where: 'w Uptime Kumie w polu Additional Headers jako { "Authorization": "Bearer <hasło>" }' },
    },
  },
  guide: [
    'W Uptime Kumie: **Ustawienia → Powiadomienia → Dodaj powiadomienie**, typ **Webhook**.',
    '',
    '- **Post URL**: adres wejściowy integracji z panelu bramki',
    '- **Request Body**: `application/json`',
    '- **Additional Headers**: `{ "Authorization": "Bearer <token>" }` z tokenem, który wpisałeś w bramce',
    '',
    'Zapisz powiadomienie i włącz je przy monitorach, które mają budzić SMS-em (edycja monitora, sekcja Powiadomienia), albo zaznacz „Domyślnie włączone” dla nowych monitorów. Przycisk „Test” w Uptime Kumie wysyła próbny ładunek bez danych monitora - bramka przyjmuje go tylko przy wariancie „zawsze”.',
  ].join('\n'),
};
