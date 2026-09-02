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
  expect: {
    recipients: ['48601000001'], text: 'Wiadomość testowa z automatu',
    outboundJson: { event: 'message.received', at: '2026-09-02T10:00:00.000Z', id: 'in_1', serviceId: '24138', from: '48601000001', to: '7968', kind: 'text', text: 'Pomocy, nie działa', receivedAt: '2026-09-02T10:00:00.000Z', relatedMessageId: null },
  },
  guide: [
    '**Do SMS.** Aplikacja wysyła `POST` na adres wejściowy z nagłówkiem `Content-Type: application/json` i ładunkiem:',
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
