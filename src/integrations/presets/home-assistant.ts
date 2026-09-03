import type { Preset } from './types.ts';

export const homeAssistant: Preset = {
  id: 'home-assistant',
  name: 'Home Assistant',
  blurb: 'SMS z automatyzacji przez rest_command; SMS do automatyzacji przez webhook HA',
  kinds: ['webhook_in', 'webhook_out'],
  sample: { to: '48601000001', text: 'Alarm: otwarte drzwi garażu' },
  fields: [
    { path: 'to', label: 'numer albo lista numerów' },
    { path: 'text', label: 'treść SMS-a' },
  ],
  inbound: { to: { path: 'to', fallback: [] }, text: { mode: 'path', path: 'text' }, maxParts: 2, overflow: 'truncate' },
  outbound: { body: { mode: 'json', template: '{"from": {{ from | json }}, "text": {{ text | json }}, "receivedAt": {{ receivedAt | json }}}' } },
  expect: {
    recipients: ['48601000001'], text: 'Alarm: otwarte drzwi garażu',
    outboundJson: { from: '48601000001', text: 'Pomocy, nie działa', receivedAt: '2026-09-02T10:00:00.000Z' },
  },
  sampleSource: 'format własny bramki; do potwierdzenia na instancji',
  guide: [
    '**Do SMS.** W `configuration.yaml` Home Assistanta:',
    '',
    '```yaml',
    'rest_command:',
    '  sms:',
    '    url: "https://bramka.example/hooks/<identyfikator>"',
    '    method: post',
    '    content_type: "application/json"',
    '    payload: \'{"to": "{{ to }}", "text": "{{ text }}"}\'',
    '```',
    '',
    'W automatyzacji akcja `rest_command.sms` z danymi `to` i `text`. Jeśli chcesz uwierzytelniać nagłówkiem, dodaj `headers: { Authorization: "Bearer <token>" }` i ten sam token w bramce.',
    '',
    '**Z SMS-a.** W automatyzacji wyzwalacz **Webhook** z własnym identyfikatorem; adres integracji wychodzącej to `https://<ha>/api/webhook/<identyfikator>`. Bramka wysyła `from`, `text` i `receivedAt`; w akcjach użyj `{{ trigger.json.text }}`.',
    '',
    'Home Assistant zwykle stoi w sieci lokalnej - bramka domyślnie nie woła takich adresów. Ustaw `MIG_WEBHOOK_ALLOW_PRIVATE=1` albo wystaw HA pod adresem publicznym.',
  ].join('\n'),
};
