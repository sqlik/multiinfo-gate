import type { Preset } from './types.ts';

export const grafana: Preset = {
  id: 'grafana',
  name: 'Grafana',
  blurb: 'SMS z alertów Grafany (punkt kontaktu Webhook, basic auth)',
  kinds: ['webhook_in'],
  sample: {
    receiver: 'sms', status: 'firing',
    alerts: [
      { status: 'firing', labels: { alertname: 'CPU high', instance: 'web-1' }, annotations: { summary: 'CPU ponad 90% od 5 minut' } },
      { status: 'firing', labels: { alertname: 'Disk full', instance: 'db-1' }, annotations: { summary: 'Dysk / ponad 95%' } },
    ],
    groupKey: '{}:{alertname="CPU high"}', title: '[FIRING:2]', message: '**Firing**\n\nValue: …',
  },
  fields: [
    { path: 'status', label: 'firing albo resolved' },
    { path: 'alerts[0].labels.alertname', label: 'nazwa pierwszego alertu' },
    { path: 'alerts[0].annotations.summary', label: 'opis pierwszego alertu' },
    { path: 'title', label: 'tytuł z Grafany' },
    { path: 'message', label: 'pełny komunikat z Grafany (Markdown)' },
  ],
  inbound: {
    auth: { basic: { user: 'grafana', passRef: 'basic' }, sources: [] },
    to: { fallback: [] },
    text: { mode: 'liquid', template: '{% if p.status == "firing" %}ALARM{% else %}OK{% endif %}: {% for a in p.alerts limit: 3 %}{{ a.labels.alertname }}{% unless forloop.last %}, {% endunless %}{% endfor %}{% if p.alerts.size > 3 %} (+{{ p.alerts.size | minus: 3 }}){% endif %}' },
    maxParts: 1, overflow: 'truncate',
  },
  secrets: [{ ref: 'basic', label: 'Hasło basic auth', hint: 'Login grafana i to hasło wpisz w punkcie kontaktu Grafany' }],
  expect: { text: 'ALARM: CPU high, Disk full' },
  sampleSource: 'dokumentacja Grafany 11 (Webhook contact point) - do potwierdzenia w Dockerze',
  guide: [
    'W Grafanie **Alerting → Contact points → Add contact point**, integracja **Webhook**. **URL** to adres wejściowy integracji, **HTTP Method** `POST`, **Basic Authentication** z loginem `grafana` i hasłem z bramki. Numer odbiorcy wpisz w bramce w liście zapasowej.',
    '',
    'Grafana wysyła jedno żądanie na grupę alertów; szablon wypisuje do trzech nazw i liczbę pozostałych. Klucz grupy (`groupKey`) jest stały dla grupy, więc nie nadaje się na identyfikator zdarzenia - bramka nie odrzucałaby powtórek, tylko każdy kolejny alert tej grupy. Żeby dostawać SMS tylko o alarmie, dodaj warunek `status równe firing`.',
  ].join('\n'),
};
