import type { Preset } from './types.ts';

export const ntfy: Preset = {
  id: 'ntfy',
  name: 'ntfy',
  blurb: 'Odebrany SMS jako powiadomienie push na telefon przez ntfy.sh albo własny serwer',
  kinds: ['webhook_out'],
  fields: [
    { path: 'from', label: 'numer nadawcy' },
    { path: 'text', label: 'treść SMS-a' },
  ],
  outbound: {
    url: 'https://ntfy.sh/nazwa-tematu',
    headers: [{ name: 'Title', value: 'SMS od {{ from }}' }, { name: 'Priority', value: 'default' }],
    body: { mode: 'text', template: '{{ text }}' },
  },
  secrets: [{ ref: 'authorization', label: 'Nagłówek Authorization (opcjonalny)', hint: 'Bearer tk_… dla tematów chronionych; dodaj nagłówek Authorization z tym sekretem' }],
  simple: {
    outbound: {
      address: { label: 'Adres tematu ntfy', hint: 'Serwer i nazwa tematu, którą subskrybujesz w aplikacji ntfy na telefonie', placeholder: 'https://ntfy.sh/firma-sms' },
      secrets: [], params: [],
      note: 'Każdy odebrany SMS przychodzi na telefon jako powiadomienie z tytułem „SMS od <numer>” i treścią SMS-a. Temat chroniony tokenem ustawisz w trybie zaawansowanym.',
    },
  },
  expect: { outboundText: 'Pomocy, nie działa' },
  sampleSource: 'ntfy.sh, 2026-09-02: wysyłka z nagłówkami Title i Priority przyjęta (200), wiadomość widoczna w temacie',
  guide: [
    'Adres to serwer i nazwa tematu, np. `https://ntfy.sh/firma-sms`. Body jest surowym tekstem, tytuł i priorytet idą nagłówkami `Title` i `Priority`. Dla tematu chronionego dodaj nagłówek `Authorization` z tokenem jako sekretem. W aplikacji ntfy zasubskrybuj temat.',
  ].join('\n'),
};
