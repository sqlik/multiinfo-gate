import type { Preset } from './types.ts';

export const teams: Preset = {
  id: 'teams',
  name: 'Microsoft Teams',
  blurb: 'Odebrany SMS jako karta na kanale (Workflows, Adaptive Card)',
  kinds: ['webhook_out'],
  fields: [
    { path: 'from', label: 'numer nadawcy' },
    { path: 'text', label: 'treść SMS-a' },
    { path: 'receivedAt', label: 'czas odbioru' },
  ],
  outbound: {
    url: 'https://prod-00.westeurope.logic.azure.com/workflows/…',
    body: {
      mode: 'json',
      template: '{% capture title %}SMS od {{ from }}{% endcapture %}{"type": "message", "attachments": [{"contentType": "application/vnd.microsoft.card.adaptive", "content": {"type": "AdaptiveCard", "version": "1.4", "body": [{"type": "TextBlock", "weight": "Bolder", "text": {{ title | json }}}, {"type": "TextBlock", "wrap": true, "text": {{ text | json }}}]}}]}',
    },
  },
  expect: {
    outboundJson: {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: { type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', weight: 'Bolder', text: 'SMS od 48601000001' }, { type: 'TextBlock', wrap: true, text: 'Pomocy, nie działa' }] },
      }],
    },
  },
  sampleSource: 'dokumentacja Microsoft (Workflows) - do potwierdzenia na żywo',
  guide: [
    'W Teams na kanale wybierz **Workflows → Post to a channel when a webhook request is received**. Skopiowany adres przepływu wklej jako adres integracji. Body to koperta z kartą Adaptive Card w wersji 1.4; przepływ przekazuje ją na kanał bez zmian.',
  ].join('\n'),
};
