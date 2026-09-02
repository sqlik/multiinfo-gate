import type { Preset } from './types.ts';

export const uptimeKuma: Preset = {
  id: 'uptime-kuma',
  name: 'Uptime Kuma',
  blurb: 'SMS przy awarii monitora - powiadomienie typu Webhook',
  kinds: ['webhook_in'],
  sample: {
    heartbeat: { status: 0, msg: 'timeout of 48000ms exceeded', time: '2026-09-02 12:00:00' },
    monitor: { name: 'Strona firmowa', url: 'https://firma.example' },
    msg: '[Strona firmowa] [🔴 Down] timeout of 48000ms exceeded',
  },
  fields: [
    { path: 'heartbeat.status', label: '0 = awaria, 1 = działa' },
    { path: 'heartbeat.msg', label: 'komunikat sprawdzenia' },
    { path: 'heartbeat.time', label: 'czas sprawdzenia' },
    { path: 'monitor.name', label: 'nazwa monitora' },
    { path: 'monitor.url', label: 'adres monitora' },
    { path: 'msg', label: 'gotowy komunikat Uptime Kumy' },
  ],
  inbound: {
    auth: { header: { name: 'Authorization', valueRef: 'token' }, sources: [] },
    to: { fallback: [] },
    text: { mode: 'liquid', template: '{% if p.heartbeat.status == 0 %}AWARIA{% else %}OK{% endif %}: {{ p.monitor.name }} - {{ p.heartbeat.msg | sms_truncate: 100 }}' },
    condition: { mode: 'builder', rules: [] },
    maxParts: 1, overflow: 'truncate',
  },
  secrets: [{ ref: 'token', label: 'Token w nagłówku Authorization', hint: 'Wpisz z przedrostkiem, np. Bearer 7f3a…; to samo wklej w Uptime Kumie w polu nagłówków' }],
  expect: { text: 'AWARIA: Strona firmowa - timeout of 48000ms exceeded' },
  sampleSource: 'Uptime Kuma 2.x - do potwierdzenia na instancji',
  guide: [
    'W Uptime Kumie: **Ustawienia → Powiadomienia → Dodaj powiadomienie**, typ **Webhook**.',
    '',
    '- **Post URL**: adres wejściowy integracji z panelu bramki',
    '- **Request Body**: `application/json`',
    '- **Additional Headers**: `{ "Authorization": "Bearer <token>" }` z tokenem, który wpisałeś w bramce',
    '',
    'Numer odbiorcy wpisz w bramce w liście zapasowej - Uptime Kuma nie przesyła numerów. Żeby SMS szedł tylko przy awarii, dodaj warunek `heartbeat.status równe 0`; bez warunku przyjdzie też SMS o powrocie (`OK: …`).',
  ].join('\n'),
};
