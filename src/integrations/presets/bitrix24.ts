import type { Preset } from './types.ts';

/**
 * Paczka batch: dwa wywołania REST w jednym żądaniu. Pierwsze szuka kontaktu po numerze, drugie
 * zakłada zadanie i wiąże je z tym kontaktem przez `$result`. Bitrix nie ma jednego wywołania,
 * które zrobiłoby oba kroki, a drugie żądanie z bramki nie miałoby skąd wziąć identyfikatora.
 */
const BODY = [
  '{"halt":0,"cmd":{',
  '"znajdz":"crm.duplicate.findbycomm?entity_type=CONTACT&type=PHONE&values[0]={{ from | prepend: "+" | url_encode }}",',
  '"zadanie":"tasks.task.add?fields[TITLE]={{ "SMS od " | append: from | url_encode }}',
  '&fields[DESCRIPTION]={{ text | url_encode }}',
  '&fields[RESPONSIBLE_ID]=1',
  '&fields[UF_CRM_TASK][0]=C_$result[znajdz][CONTACT][0]"',
  '}}',
].join('');

export const bitrix24: Preset = {
  id: 'bitrix24',
  name: 'Bitrix24: zadanie z SMS-a',
  blurb: 'Odebrany SMS zakłada zadanie przy kartotece klienta (webhook przychodzący Bitrixa)',
  kinds: ['webhook_out'],
  fields: [
    { path: 'from', label: 'numer nadawcy' },
    { path: 'text', label: 'treść SMS-a' },
    { path: 'receivedAt', label: 'czas odbioru' },
  ],
  outbound: {
    events: ['message.received'],
    url: 'https://firma.bitrix24.pl/rest/1/…/batch.json',
    method: 'POST',
    body: { mode: 'json', template: BODY },
  },
  expect: {
    outboundJson: {
      halt: 0,
      cmd: {
        znajdz: 'crm.duplicate.findbycomm?entity_type=CONTACT&type=PHONE&values[0]=%2B48601000001',
        zadanie: 'tasks.task.add?fields[TITLE]=SMS+od+48601000001&fields[DESCRIPTION]=Pomocy%2C+nie+dzia%C5%82a'
          + '&fields[RESPONSIBLE_ID]=1&fields[UF_CRM_TASK][0]=C_$result[znajdz][CONTACT][0]',
      },
    },
  },
  sampleSource: 'Bitrix24, portal próbny, 2026-09-15: paczka batch znalazła kontakt po numerze oraz założyła zadanie z powiązaniem C_2',
  simple: {
    outbound: {
      address: {
        label: 'Adres webhooka z Bitrixa',
        hint: 'Adres z kafelka Webhook przychodzący, uzupełniony o końcówkę batch.json',
        placeholder: 'https://firma.bitrix24.pl/rest/1/abcdefghij123456/batch.json',
        mustEndWith: 'batch.json',
      },
      secrets: [],
      params: [{
        key: 'fields[RESPONSIBLE_ID]',
        label: 'Numer pracownika, na którego idą zadania',
        hint: 'Widoczny w adresie profilu w Bitrixie: /company/personal/user/1/ to numer 1',
        digits: true, where: 'query',
      }],
      note: 'Każdy odebrany SMS zakłada w Bitrixie zadanie z treścią wiadomości, powiązane z kontaktem o tym numerze.',
    },
  },
  warning: 'Adres webhooka jest hasłem do Twojego portalu. Nie wklejaj go do zgłoszeń ani na zrzuty ekranu.',
  guide: [
    '**Webhook.** W Bitrixie wejdź w **Aplikacje**, potem **Zasoby dla programistów** i wybierz kafelek **Webhook przychodzący**.',
    '',
    '**Uprawnienia.** Zaznacz wyłącznie dwa: **CRM (crm)** oraz **Zadania (task)**. Pierwsze pozwala odnaleźć kontakt po numerze, drugie założyć zadanie. Więcej uprawnień nie jest potrzebne, a każde dodatkowe rozszerza to, co może zrobić ten, kto zdobędzie adres.',
    '',
    '**Adres.** Bitrix pokaże adres w postaci `https://firma.bitrix24.pl/rest/1/abcdefghij123456/`. Dopisz na jego końcu `batch.json`, czyli nazwę wywołania, które przyjmuje paczkę dwóch poleceń. Pełny adres wygląda tak:',
    '',
    '```',
    'https://firma.bitrix24.pl/rest/1/abcdefghij123456/batch.json',
    '```',
    '',
    '**Numer pracownika.** Zadania trafią na jedną osobę. Jej numer zobaczysz w adresie profilu w Bitrixie: przy `/company/personal/user/1/` numerem jest 1.',
    '',
    '**Czego się spodziewać.** Zadanie ma w tytule numer nadawcy, w opisie treść SMS-a, a w polu CRM powiązanie z kontaktem. Gdy numer nie pasuje do żadnego kontaktu, zadanie powstaje bez powiązania i jest widoczne na liście zadań pracownika.',
    '',
    'Adres webhooka jest hasłem: kto go ma, ten czyta CRM i zakłada zadania. Trzymaj go wyłącznie w bramce. Gdy wyciekł, skasuj webhook w Bitrixie oraz zrób nowy.',
    '',
    'Powiadomienia wychodzące z Bitrixa, w tym przypomnienia o rezerwacjach, przyjdą w późniejszym wydaniu bramki.',
  ].join('\n'),
};
