import { shortId } from '../ids.ts';
import type { ApiKeyRow } from '../store/api-keys.ts';
import { sha256Hex } from '../text/hash.ts';
import { measureText, type Encoding, type EncodingRequest } from '../text/measure.ts';
import { InvalidPhoneError, normalizePhone } from '../text/phone.ts';
import { segmentText, TooManyPartsError } from '../text/segment.ts';
import { lastValidDay } from '../time/warsaw.ts';
import type { AuthContext } from './auth.ts';
import { ApiError } from './errors.ts';
import { resolveOrig } from './orig.ts';
import type { ApiDeps } from './server.ts';

const MAX_VALIDITY_MS = 72 * 3600_000;

export interface SubmitInput {
  to: string[];
  text: string;
  serviceId?: string;
  orig?: string;
  encoding?: EncodingRequest;
  maxParts?: number;
  deliveryReport?: boolean;
  validTo?: string;
  costCenter?: string;
  inReplyTo?: string;
  idempotencyKey?: string;
  /** Integracja, która zleciła wysyłkę; brak dla żądań z API. */
  integrationId?: number;
}

export interface SubmitResult {
  id: string; status: string; encoding: Encoding; parts: number; characters: number; slots: number; slotsRemaining: number;
}

export type SubmitDeps = Pick<ApiDeps, 'accounts' | 'messages' | 'events' | 'jobs' | 'inbound'>;

/** Kontekst uprawnień z wiersza klucza - to samo, co daje `authenticate`, ale bez nagłówka i bez `touch`. */
export function authFromKey(row: ApiKeyRow): AuthContext {
  return {
    apiKeyId: row.id, accountId: row.accountId, allowedServiceIds: row.allowedServiceIds, allowedOrigs: row.allowedOrigs,
    defaultServiceId: row.defaultServiceId, defaultOrig: row.defaultOrig, maxParts: row.maxParts, ratePerMin: row.ratePerMin,
  };
}

/** Czy kluczem wolno dziś wysyłać: odwołany i wygasły odpadają, tak jak przy uwierzytelnianiu żądania API. */
export function keyUsable(row: ApiKeyRow, now: Date): { ok: true } | { ok: false; reason: string } {
  if (row.revokedAt !== null) return { ok: false, reason: 'klucz API został odwołany' };
  if (row.expiresAt !== null && Date.parse(row.expiresAt) <= now.getTime()) {
    return { ok: false, reason: `klucz API wygasł ${lastValidDay(row.expiresAt)}` };
  }
  return { ok: true };
}

/**
 * Wspólna droga każdej wysyłki - z `POST /v1/messages` i z integracji: usługa, wątek, nadpis,
 * ważność, segmentacja, odbiorcy, idempotencja, zapis, kolejka. Kody `ApiError` są częścią
 * API i nie zmieniają się od tego, kto woła.
 */
export function submitMessages(deps: SubmitDeps, auth: AuthContext, input: SubmitInput, now: Date): SubmitResult[] {
  const account = deps.accounts.get(auth.accountId);
  if (!account) throw new ApiError(500, 'account_missing', 'Konto przypisane do klucza nie istnieje.');

  const serviceId = String(input.serviceId ?? auth.defaultServiceId ?? '');
  if (!serviceId) throw new ApiError(400, 'service_required', 'Klucz nie ma domyślnej usługi - podaj serviceId.');
  if (!auth.allowedServiceIds.includes(serviceId)) {
    throw new ApiError(403, 'service_not_allowed', `Klucz nie ma dostępu do usługi ${serviceId}.`);
  }

  let inReplyTo: string | null = null;
  if (input.inReplyTo !== undefined) {
    // Odpowiedź dotyczy jednej rozmowy: jeden odbiorca, wiadomość z tej samej usługi konta.
    if (input.to.length !== 1) throw new ApiError(400, 'in_reply_to_single', 'inReplyTo dopuszcza jednego odbiorcę.');
    const original = deps.inbound.get(input.inReplyTo);
    if (!original || original.accountId !== auth.accountId || original.serviceId !== serviceId) {
      throw new ApiError(400, 'in_reply_to_unknown', 'Nie ma takiej wiadomości przychodzącej w tej usłudze.');
    }
    // Odpowiedź idzie do tego, kto pisał: Multiinfo dostaje smsInId, a panel łączy wątek po numerze.
    const raw = input.to[0]!;
    let recipient: string;
    try {
      recipient = normalizePhone(raw, account.defaultCountryCode);
    } catch {
      recipient = raw.trim();
    }
    if (recipient !== original.sender) {
      throw new ApiError(400, 'in_reply_to_recipient', `Odpowiedź na ${original.id} musi iść do jej nadawcy (${original.sender}).`);
    }
    inReplyTo = original.id;
  }

  const orig = resolveOrig(input.orig, auth, account, deps.accounts);

  let validTo: Date | undefined;
  if (input.validTo !== undefined) {
    validTo = new Date(input.validTo);
    const ahead = validTo.getTime() - now.getTime();
    if (ahead <= 0) throw new ApiError(400, 'valid_to_in_past', 'Data ważności już minęła.');
    if (ahead > MAX_VALIDITY_MS) throw new ApiError(400, 'valid_to_too_far', 'Multiinfo dopuszcza ważność najwyżej 72 godziny.');
  }

  const maxParts = Math.min(input.maxParts ?? auth.maxParts, auth.maxParts);
  const measurement = measureText(input.text, input.encoding ?? 'auto');
  let segmentation;
  try {
    segmentation = segmentText(input.text, measurement, maxParts);
  } catch (e) {
    if (e instanceof TooManyPartsError) throw new ApiError(400, 'too_many_parts', e.message);
    throw e;
  }

  const idem = input.idempotencyKey;
  const hash = sha256Hex(input.text);
  const recipients = input.to;
  const deliveryReport = input.deliveryReport ?? true;

  // Najpierw sprawdzamy wszystkich odbiorców, dopiero potem cokolwiek zapisujemy:
  // lista ma wejść w całości albo wcale. Inaczej błędny numer na trzeciej pozycji
  // zostawiłby dwie wiadomości w kolejce, a klient dostałby 400 i wysłał je ponownie.
  const checked = recipients.map((raw, index) => {
    let dest: string;
    try {
      dest = normalizePhone(raw, account.defaultCountryCode);
    } catch (e) {
      if (e instanceof InvalidPhoneError) throw new ApiError(400, 'invalid_phone', e.message);
      throw e;
    }

    const perRecipientIdem = idem === undefined ? undefined : recipients.length === 1 ? idem : `${idem}#${index}`;
    const existing = perRecipientIdem === undefined
      ? undefined
      : deps.messages.findByIdempotencyKey(auth.apiKeyId, perRecipientIdem);
    if (existing && (existing.bodyHash !== hash || existing.dest !== dest)) {
      throw new ApiError(409, 'idempotency_conflict', 'Ten klucz idempotencji został już użyty z inną treścią lub innym odbiorcą.');
    }
    return { dest, perRecipientIdem, existing };
  });

  return deps.messages.transaction(() => checked.map(({ dest, perRecipientIdem, existing }): SubmitResult => {
    if (existing) {
      return {
        id: existing.id, status: existing.status, encoding: existing.encoding,
        parts: existing.parts, characters: measurement.characters,
        slots: existing.slots, slotsRemaining: segmentation.slotsRemaining,
      };
    }

    const id = shortId('msg');
    deps.messages.insert({
      id, apiKeyId: auth.apiKeyId, accountId: auth.accountId, serviceId, dest,
      body: account.storeContent ? input.text : null, bodyHash: hash,
      encoding: measurement.encoding, parts: segmentation.parts, slots: measurement.slots,
      orig: orig ?? null, costCenter: input.costCenter ?? null,
      validTo: validTo?.toISOString() ?? null,
      idempotencyKey: perRecipientIdem ?? null,
      inReplyTo,
      integrationId: input.integrationId ?? null,
      createdAt: now.toISOString(),
    });
    deps.jobs.enqueue('send', { messageId: id, text: input.text, deliveryReport }, now);
    deps.events.record(id, now, 'queued', null);

    return {
      id, status: 'queued', encoding: measurement.encoding, parts: segmentation.parts,
      characters: measurement.characters, slots: measurement.slots, slotsRemaining: segmentation.slotsRemaining,
    };
  }));
}
