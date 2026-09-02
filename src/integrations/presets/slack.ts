import type { Preset } from './types.ts';

export const slack: Preset = {
  id: 'slack',
  name: 'Slack',
  blurb: 'Odebrany SMS jako wiadomość na kanale (webhook przychodzący Slacka)',
  kinds: ['webhook_out'],
  fields: [
    { path: 'from', label: 'numer nadawcy' },
    { path: 'text', label: 'treść SMS-a' },
    { path: 'receivedAt', label: 'czas odbioru' },
  ],
  outbound: {
    url: 'https://hooks.slack.com/services/…',
    body: { mode: 'json', template: '{% capture msg %}SMS od {{ from }}: {{ text }}{% endcapture %}{"text": {{ msg | json }}}' },
  },
  expect: { outboundJson: { text: 'SMS od 48601000001: Pomocy, nie działa' } },
  sampleSource: 'dokumentacja Slacka (Incoming Webhooks)',
  guide: [
    'W Slacku utwórz aplikację (**api.slack.com/apps**), włącz **Incoming Webhooks** i dodaj webhook do kanału. Adres `https://hooks.slack.com/services/…` wklej jako adres integracji. Body to `{"text": "…"}`; Slack przyjmuje też bloki (`blocks`), jeśli zmienisz szablon.',
  ].join('\n'),
};
