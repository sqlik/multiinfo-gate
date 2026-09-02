import type { InboundConfig } from '../config.ts';
import type { Preset } from './types.ts';

/** Domyślna treść SMS-a - pierwszy wariant w trybie prostym i szablon w zaawansowanym. */
const TEKST: InboundConfig['text'] = { mode: 'liquid', template: '{% if p.status == "firing" %}ALARM{% else %}OK{% endif %}: {% for a in p.alerts limit: 3 %}{{ a.labels.alertname }}{% unless forloop.last %}, {% endunless %}{% endfor %}{% if p.alerts.size > 3 %} (+{{ p.alerts.size | minus: 3 }}){% endif %}' };

export const grafana: Preset = {
  id: 'grafana',
  name: 'Grafana',
  blurb: 'SMS z alertów Grafany (punkt kontaktu Webhook, basic auth)',
  kinds: ['webhook_in'],
  // Ładunek „firing” z Grafany 13.2.0 z jednym alertem, przycięty o adresy wyciszania i valueString.
  sample: {
    receiver: 'sms', status: 'firing',
    alerts: [
      {
        status: 'firing',
        labels: { alertname: 'CPU high', grafana_folder: 'Alerty', instance: 'web-1', severity: 'critical' },
        annotations: { description: 'Serwer web-1 jest przeciążony', summary: 'CPU ponad 90% od 5 minut' },
        startsAt: '2026-09-02T18:56:50Z', endsAt: '0001-01-01T00:00:00Z',
        generatorURL: 'http://localhost:3000/alerting/grafana/efx2f25h4uf40b/view?orgId=1',
        fingerprint: '41980c48991e89ca', ruleUID: 'efx2f25h4uf40b', values: { B: 100, C: 1 }, orgId: 1,
      },
    ],
    groupLabels: { alertname: 'CPU high', grafana_folder: 'Alerty' },
    commonLabels: { alertname: 'CPU high', grafana_folder: 'Alerty', instance: 'web-1', severity: 'critical' },
    commonAnnotations: { description: 'Serwer web-1 jest przeciążony', summary: 'CPU ponad 90% od 5 minut' },
    externalURL: 'http://localhost:3000/', appVersion: '13.2.0', version: '1',
    groupKey: '{}:{alertname="CPU high", grafana_folder="Alerty"}', truncatedAlerts: 0, orgId: 1,
    title: '[FIRING:1] CPU high Alerty (web-1 critical)', state: 'alerting',
    message: '**Firing**\n\nValue: B=100, C=1\nLabels:\n - alertname = CPU high\n - grafana_folder = Alerty\n - instance = web-1\n - severity = critical\nAnnotations:\n - description = Serwer web-1 jest przeciążony\n - summary = CPU ponad 90% od 5 minut\nSource: http://localhost:3000/alerting/grafana/efx2f25h4uf40b/view?orgId=1\n',
  },
  fields: [
    { path: 'status', label: 'firing albo resolved' },
    { path: 'alerts[0].labels.alertname', label: 'nazwa pierwszego alertu' },
    { path: 'alerts[0].labels.instance', label: 'etykieta instance pierwszego alertu (gdy reguła ją nadaje)' },
    { path: 'alerts[0].annotations.summary', label: 'opis pierwszego alertu' },
    { path: 'alerts[0].values', label: 'wartości wyrażeń reguły; null przy powrocie' },
    { path: 'title', label: 'tytuł z Grafany, np. „[FIRING:1] CPU high Alerty (web-1 critical)”' },
    { path: 'message', label: 'pełny komunikat z Grafany (Markdown)' },
  ],
  inbound: {
    auth: { basic: { user: 'grafana', passRef: 'basic' }, sources: [] },
    to: { fallback: [] },
    text: TEKST,
    maxParts: 1, overflow: 'truncate',
  },
  secrets: [{ ref: 'basic', label: 'Hasło basic auth', hint: 'Login grafana i to hasło wpisz w punkcie kontaktu Grafany' }],
  expect: { text: 'ALARM: CPU high' },
  sampleSource: 'Grafana 13.2.0, żywa instancja, 2026-09-02: ładunki firing i resolved z punktu kontaktu Webhook z basic auth',
  simple: {
    inbound: {
      addressField: 'w Grafanie w polu URL punktu kontaktu typu Webhook',
      recipients: { source: 'list', note: 'Grafana nie przesyła numerów telefonów, więc SMS idzie zawsze na numery wpisane tutaj.' },
      when: [
        { id: 'alarm', label: 'tylko gdy alert się zapali', condition: { mode: 'builder', rules: [{ path: 'status', op: 'eq', value: 'firing' }] } },
        { id: 'alarm-i-powrot', label: 'gdy się zapali i gdy zgaśnie', condition: { mode: 'builder', rules: [] } },
      ],
      text: [
        { id: 'nazwy', label: 'stan i nazwy alertów (do trzech)', text: TEKST },
        { id: 'z-opisem', label: 'stan, pierwszy alert z opisem z reguły', text: { mode: 'liquid', template: '{% if p.status == "firing" %}ALARM{% else %}OK{% endif %}: {{ p.alerts[0].labels.alertname }}{% if p.alerts[0].labels.instance %} ({{ p.alerts[0].labels.instance }}){% endif %}{% if p.alerts[0].annotations.summary %} - {{ p.alerts[0].annotations.summary | sms_truncate: 100 }}{% endif %}{% if p.alerts.size > 1 %} (+{{ p.alerts.size | minus: 1 }}){% endif %}' } },
      ],
      auth: { kind: 'basic', user: 'grafana', label: 'Hasło, które wpiszesz też w Grafanie', where: 'w Grafanie w punkcie kontaktu: Basic Authentication, login grafana i to hasło' },
    },
  },
  guide: [
    'W Grafanie **Alerting → Contact points → Add contact point**, integracja **Webhook**. **URL** to adres wejściowy integracji, **HTTP Method** `POST`, **Basic Authentication** z loginem `grafana` i hasłem z bramki. Numer odbiorcy wpisz w bramce w liście zapasowej.',
    '',
    'Grafana wysyła jedno żądanie na grupę alertów; szablon wypisuje do trzech nazw i liczbę pozostałych. Klucz grupy (`groupKey`) jest stały dla grupy, więc nie nadaje się na identyfikator zdarzenia - bramka nie odrzucałaby powtórek, tylko każdy kolejny alert tej grupy. SMS o alarmie przychodzi po czasie **Group wait** polityki powiadomień (domyślnie 30 s), o powrocie po **Group interval** (domyślnie 5 min). Żeby dostawać SMS tylko o alarmie, dodaj warunek `status równe firing`.',
  ].join('\n'),
};
