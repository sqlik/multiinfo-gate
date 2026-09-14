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
  sampleSource: 'Slack, żywa przestrzeń organizacji, 2026-09-14: webhook przychodzący przyjął wiadomość (200 ok, treść widoczna na kanale)',
  guide: [
    'W Slacku utwórz aplikację (**api.slack.com/apps**), włącz **Incoming Webhooks** i dodaj webhook do kanału. Adres `https://hooks.slack.com/services/…` wklej jako adres integracji. Body to `{"text": "…"}`; Slack przyjmuje też bloki (`blocks`), jeśli zmienisz szablon.',
    '',
    'Adres webhooka sam w sobie jest hasłem. Kto go ma, ten pisze na kanale. Trzymaj go wyłącznie w bramce, a gdy wyciekł, wygeneruj nowy przyciskiem **Regenerate** w ustawieniach integracji.',
    '',
    'W przestrzeni firmowej bywa włączone **Require approved apps**. Wtedy aplikację dodaje osoba z rolą App Manager, czyli właściciel przestrzeni albo ktoś wskazany przez administratora. Zwykły członek może jedynie poprosić o zatwierdzenie. Jeśli nie masz tej roli, poproś administratora Slacka o dodanie aplikacji oraz o adres webhooka.',
    '',
    'W katalogu aplikacji Slacka jest też gotowa pozycja **Incoming WebHooks**. Daje ten sam adres, ale to stara integracja. Slack odradza jej zakładanie i zapowiada wycofanie, więc nową integrację rób jako własną aplikację.',
    '',
    'Nazwę oraz obrazek, pod którymi bramka pisze na kanale, ustawisz po stronie Slacka w ustawieniach webhooka.',
  ].join('\n'),
};
