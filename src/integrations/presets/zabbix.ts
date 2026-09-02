import type { Preset } from './types.ts';

export const zabbix: Preset = {
  id: 'zabbix',
  name: 'Zabbix',
  blurb: 'SMS z akcji Zabbiksa przez typ mediów Webhook z gotowym skryptem',
  kinds: ['webhook_in'],
  // Ładunek PROBLEM z Zabbiksa 7.4 z domyślnymi szablonami wiadomości typu mediów.
  sample: {
    to: '48601000001',
    subject: 'Problem: High CPU utilization on web-1',
    message: 'Problem started at 18:56:37 on 2026.09.02\r\nProblem name: High CPU utilization on web-1\r\nHost: web-1\r\nSeverity: High\r\nOperational data: 97 %\r\nOriginal problem ID: 26\r\n',
    eventId: '26:PROBLEM',
    status: 'PROBLEM',
  },
  fields: [
    { path: 'to', label: 'numer z pola „Send to” odbiorcy' },
    { path: 'subject', label: 'temat z szablonu wiadomości' },
    { path: 'message', label: 'treść z szablonu wiadomości' },
    { path: 'eventId', label: 'identyfikator zdarzenia ze statusem, np. 26:PROBLEM' },
    { path: 'status', label: 'PROBLEM albo RESOLVED' },
  ],
  inbound: {
    to: { path: 'to', fallback: [] }, eventIdPath: 'eventId',
    text: { mode: 'liquid', template: '{{ p.subject }}' },
    maxParts: 1, overflow: 'truncate',
  },
  secrets: [{ ref: 'token', label: 'Token w nagłówku Authorization', hint: 'Wpisz z przedrostkiem Bearer; ten sam w parametrze token typu mediów' }],
  expect: { recipients: ['48601000001'], text: 'Problem: High CPU utilization on web-1' },
  sampleSource: 'Zabbix 7.4.14, żywa instancja, 2026-09-02: PROBLEM i RESOLVED z akcji z domyślnymi szablonami wiadomości',
  guide: [
    'W Zabbiksie **Alerts → Media types → Create media type**, typ **Webhook**. Parametry: `url` (adres wejściowy integracji), `token` (ten sam co w bramce), `to` = `{ALERT.SENDTO}`, `subject` = `{ALERT.SUBJECT}`, `message` = `{ALERT.MESSAGE}`, `eventId` = `{EVENT.ID}`, `status` = `{EVENT.STATUS}`. W zakładce **Message templates** dodaj szablony dla problemu i rozwiązania (przycisk **Add** podpowiada domyślne). Skrypt:',
    '',
    '```js',
    'var p = JSON.parse(value), req = new HttpRequest();',
    'req.addHeader(\'Content-Type: application/json\');',
    'req.addHeader(\'Authorization: \' + p.token);',
    'var body = { to: p.to, subject: p.subject, message: p.message, eventId: p.eventId + \':\' + p.status, status: p.status };',
    'var res = req.post(p.url, JSON.stringify(body));',
    'if (req.getStatus() >= 400) throw \'Bramka odpowiedziała \' + req.getStatus() + \': \' + res;',
    'return \'OK\';',
    '```',
    '',
    'Przy użytkowniku ustaw medium tego typu z numerem w polu **Send to**, a w akcji (**Alerts → Actions → Trigger actions**) operację i operację przywracania z tym typem mediów. Skrypt skleja identyfikator zdarzenia ze statusem, bo Zabbix nadaje rozwiązaniu ten sam `{EVENT.ID}` co problemowi: ponowienie tej samej wysyłki bramka odrzuca jako powtórkę, a SMS o rozwiązaniu przechodzi. Żeby nie dostawać SMS-a o rozwiązaniu, dodaj warunek `status równe PROBLEM`.',
  ].join('\n'),
};
