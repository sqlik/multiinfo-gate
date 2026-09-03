import type { Preset } from './types.ts';

export const prostyJson: Preset = {
  id: 'prosty-json',
  name: 'Prosty JSON',
  blurb: 'n8n, Make, Zapier, własne skrypty, NAS - ładunek { to, text }',
  kinds: ['webhook_in', 'webhook_out'],
  sample: { to: '48601000001', text: 'Wiadomość testowa z automatu' },
  fields: [
    { path: 'to', label: 'numer albo lista numerów' },
    { path: 'text', label: 'treść SMS-a' },
    { path: 'inReplyTo', label: 'identyfikator zgłoszenia, gdy to odpowiedź w wątku (opcjonalny)' },
    { path: 'eventId', label: 'identyfikator zdarzenia do idempotencji (opcjonalny)' },
  ],
  inbound: {
    to: { path: 'to', fallback: [] }, text: { mode: 'path', path: 'text' }, ticketRefPath: 'inReplyTo', eventIdPath: 'eventId',
    maxParts: 3, overflow: 'reject',
  },
  outbound: { body: { mode: 'json', template: '{{ p | json }}' } },
  simple: {
    inbound: {
      addressField: 'w aplikacji albo automacie jako adres żądania POST',
      recipients: { source: 'payload', note: 'Numer przychodzi w polu to ładunku. Numery wpisane tutaj są zapasowe, gdy ładunek numeru nie ma.' },
      when: [{ id: 'zawsze', label: 'przy każdym żądaniu', condition: { mode: 'builder', rules: [] } }],
      text: [{ id: 'pole-text', label: 'treść z pola text', text: { mode: 'path', path: 'text' } }],
      auth: { kind: 'header', name: 'Authorization', prefix: 'Bearer ', label: 'Hasło, które aplikacja wyśle w nagłówku Authorization', where: 'w aplikacji jako nagłówek Authorization: Bearer <hasło>' },
    },
    outbound: {
      address: { label: 'Adres aplikacji', hint: 'Adres, na który bramka ma wysłać zdarzenie jako JSON żądaniem POST', placeholder: 'https://automat.firma.pl/webhook' },
      secrets: [], params: [],
      note: 'Bramka wysyła pełne zdarzenie w formacie z dokumentacji API: event, from, to, text, receivedAt i pozostałe pola.',
    },
  },
  expect: {
    recipients: ['48601000001'], text: 'Wiadomość testowa z automatu',
    outboundJson: { event: 'message.received', at: '2026-09-02T10:00:00.000Z', id: 'in_1', serviceId: '24138', from: '48601000001', to: '7968', kind: 'text', text: 'Pomocy, nie działa', receivedAt: '2026-09-02T10:00:00.000Z', relatedMessageId: null },
  },
  guide: [
    '**Do SMS.** Aplikacja wysyła `POST` na adres wejściowy z nagłówkami `Content-Type: application/json` i `Authorization: Bearer <hasło z bramki>` oraz ładunkiem:',
    '',
    '```json',
    '{ "to": "48601000001", "text": "Treść wiadomości" }',
    '```',
    '',
    'Pole `to` może być tekstem z numerami po przecinku albo tablicą (do 50 numerów). Numery w formacie ludzkim (`+48 601 000 001`) są normalizowane. Pole `inReplyTo` z identyfikatorem zgłoszenia wysyła SMS jako odpowiedź w wątku, a `eventId` chroni przed podwójną wysyłką przy ponowieniu żądania.',
    '',
    '**Z SMS-a.** Bramka wysyła pełne zdarzenie w formacie z rozdziału o webhookach API: `event`, `at`, `id`, `serviceId`, `from`, `to`, `kind`, `text`, `receivedAt`, `relatedMessageId`.',
  ].join('\n'),
};
