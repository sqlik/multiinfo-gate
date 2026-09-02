import type { Preset } from './types.ts';

export const zabbix: Preset = {
  id: 'zabbix',
  name: 'Zabbix',
  blurb: 'SMS z akcji Zabbiksa przez typ mediów Webhook z gotowym skryptem',
  kinds: ['webhook_in'],
  sample: { to: '48601000001', subject: 'Problem: High CPU utilization on web-1', message: 'Trigger: High CPU utilization\nHost: web-1\nSeverity: High', eventId: '1587', status: 'PROBLEM' },
  fields: [
    { path: 'to', label: 'numer z pola „Send to” odbiorcy' },
    { path: 'subject', label: 'temat z szablonu wiadomości' },
    { path: 'message', label: 'treść z szablonu wiadomości' },
    { path: 'eventId', label: 'identyfikator zdarzenia' },
    { path: 'status', label: 'PROBLEM albo RESOLVED' },
  ],
  inbound: {
    to: { path: 'to', fallback: [] }, eventIdPath: 'eventId',
    text: { mode: 'liquid', template: '{{ p.subject }}' },
    maxParts: 1, overflow: 'truncate',
  },
  secrets: [{ ref: 'token', label: 'Token w nagłówku Authorization', hint: 'Wpisz z przedrostkiem Bearer; ten sam w parametrze token typu mediów' }],
  expect: { recipients: ['48601000001'], text: 'Problem: High CPU utilization on web-1' },
  sampleSource: 'skrypt z instrukcji niżej - do potwierdzenia w Dockerze',
  guide: [
    'W Zabbiksie **Alerts → Media types → Create media type**, typ **Webhook**. Parametry: `url` (adres wejściowy integracji), `token` (ten sam co w bramce), `to` = `{ALERT.SENDTO}`, `subject` = `{ALERT.SUBJECT}`, `message` = `{ALERT.MESSAGE}`, `eventId` = `{EVENT.ID}`, `status` = `{EVENT.STATUS}`. Skrypt:',
    '',
    '```js',
    'var p = JSON.parse(value), req = new HttpRequest();',
    'req.addHeader(\'Content-Type: application/json\');',
    'req.addHeader(\'Authorization: \' + p.token);',
    'var body = { to: p.to, subject: p.subject, message: p.message, eventId: p.eventId, status: p.status };',
    'var res = req.post(p.url, JSON.stringify(body));',
    'if (req.getStatus() >= 400) throw \'Bramka odpowiedziała \' + req.getStatus() + \': \' + res;',
    'return \'OK\';',
    '```',
    '',
    'Przy użytkowniku ustaw medium tego typu z numerem w polu **Send to**. Identyfikator zdarzenia chroni przed podwójnym SMS-em przy ponowieniu przez Zabbiksa; żeby nie dostawać SMS-a o rozwiązaniu, dodaj warunek `status równe PROBLEM`.',
  ].join('\n'),
};
