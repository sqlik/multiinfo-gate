import type { Preset } from './types.ts';

/** SMS do grupy: jedyna pozycja katalogu dla rodzaju `sms_group`; formularz prosty zbiera listy, prefiks i treść. */
export const smsGrupa: Preset = {
  id: 'sms-grupa',
  name: 'SMS do grupy',
  blurb: 'Jeden SMS na numer bramki, rozesłany do stałej listy numerów',
  kinds: ['sms_group'],
  fields: [],
  smsGroup: {},
  warning: 'Każdy odbiorca otrzymuje osobną wiadomość. Jeden SMS do grupy 20 numerów to 20 wiadomości na koncie',
  sampleSource: 'Przepływ własny bramki, 2026-10-30',
  guide: `Pisać mogą wyłącznie numery z listy uprawnionych, a w grupie zamkniętej członkowie grupy. SMS od innego numeru zostaje bez odpowiedzi i bez wysyłki, widać go tylko w dzienniku integracji.

Prefiks to słowo na początku SMS-a, które wybiera grupę. Bramka zdejmuje je z treści i rozsyła resztę. Zapisy \`serwis awaria pompy\` oraz \`Serwis: awaria pompy\` dają ten sam SMS o treści \`awaria pompy\`. Wielkość liter nie ma znaczenia. Puste pole prefiksu oznacza, że każdy SMS od uprawnionego numeru idzie do grupy.

Druga grupa, na przykład biuro obok ekipy serwisowej, to druga integracja na tym samym kluczu i tej samej usłudze, z innym prefiksem.

Numer na liście uprawnionych wysyła na koszt konta do wszystkich odbiorców. Lista ma być krótka, a numer zgubionego telefonu należy z niej usunąć.`,
};
