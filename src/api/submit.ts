import { shortId } from '../ids.ts';
import {
  createCodes, linkExpiry, linksBlock, materialize, openCampaign, prepareLinks, storedLinksBlock,
  type LinkRequest, type LinksResponse, type PreparedText,
} from '../links/shortener.ts';
import type { ApiKeyRow, ApiKeysRepo } from '../store/api-keys.ts';
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
  /** Adres e-mail nadawcy wiadomości z Mail2SMS; brak dla pozostałych źródeł. */
  mailFrom?: string;
  /** Zlecający wysyłkę z przepływu Power Automate albo kanał SMS powiadomień; brak dla pozostałych źródeł. */
  requestedBy?: string;
  /** Wiadomość kanału SMS powiadomień: niewidoczna w API, webhooku klucza i integracjach wychodzących. */
  system?: boolean;
  /** Pola skracania z żądania; brak oznacza „pole puste”. */
  links?: LinkRequest;
  /** Szablon przygotowany i przycięty przez integrację; bez niego szablon powstaje z `text`. */
  prepared?: PreparedText;
  /** Nazwa kampanii, gdy żądanie jej nie podaje: nazwa integracji; bez niej nazwa klucza. */
  campaignFallback?: string;
}

export interface SubmitResult {
  id: string; status: string; encoding: Encoding; parts: number; characters: number; slots: number; slotsRemaining: number;
  links?: LinksResponse;
}

export type SubmitDeps = Pick<ApiDeps, 'accounts' | 'messages' | 'events' | 'jobs' | 'inbound' | 'linkDomains' | 'campaigns' | 'shortLinks'>
  & { apiKeys: Pick<ApiKeysRepo, 'linkSettings' | 'get'> };

/** Kontekst uprawnień z wiersza klucza - to samo, co daje `authenticate`, ale bez nagłówka i bez `touch`. */
export function authFromKey(row: ApiKeyRow): AuthContext {
  return {
    apiKeyId: row.id, accountId: row.accountId, allowedServiceIds: row.allowedServiceIds, allowedOrigs: row.allowedOrigs,
    defaultServiceId: row.defaultServiceId, defaultOrig: row.defaultOrig, maxParts: row.maxParts, ratePerMin: row.ratePerMin,
    integrationsOnly: row.integrationsOnly === 1,
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
    // Odpowiedź na SMS powiadomienia bramki istnieje tylko w panelu, więc API jej nie zna.
    if (!original || original.system === 1 || original.accountId !== auth.accountId || original.serviceId !== serviceId) {
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

  // Pomiar i podział dotyczą treści po skróceniu: szablon ma długość treści końcowej.
  const prepared = input.prepared
    ?? prepareLinks(deps, auth.apiKeyId, input.text, input.links ?? {}, input.system ? { system: true } : {});
  const maxParts = Math.min(input.maxParts ?? auth.maxParts, auth.maxParts);
  const measurement = measureText(prepared.text, input.encoding ?? 'auto');
  let segmentation;
  try {
    segmentation = segmentText(prepared.text, measurement, maxParts);
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
    // Klucz jest wspólny dla klucza API: integracja nie może zwrócić wiadomości innej integracji ani zwykłego wywołania.
    if (existing && existing.integrationId !== (input.integrationId ?? null)) {
      throw new ApiError(409, 'idempotency_conflict', 'Ten klucz idempotencji został już użyty przez inną integrację albo w zwykłym wywołaniu API.');
    }
    return { dest, perRecipientIdem, existing };
  });

  // Kampania powstaje wyłącznie dla treści z co najmniej jednym skróconym linkiem.
  const shortening = prepared.info !== null && prepared.slots.length > 0 ? prepared.info : null;
  const expiresAt = shortening === null ? null : linkExpiry(now, shortening.validityDays);
  const campaignLabel = (): string =>
    shortening?.campaign ?? input.campaignFallback ?? deps.apiKeys.get(auth.apiKeyId)?.name ?? `klucz ${auth.apiKeyId}`;

  return deps.messages.transaction(() => {
    // Rzutowanie: kampania powstaje wewnątrz `map`, a zawężanie typów nie widzi przypisań w funkcji zwrotnej.
    let campaign = null as { id: number; name: string } | null;
    let sent = 0;
    const results = checked.map(({ dest, perRecipientIdem, existing }): SubmitResult => {
      if (existing) {
        const links = storedLinksBlock([prepared], storedLinks(deps, existing.id));
        return {
          id: existing.id, status: existing.status, encoding: existing.encoding,
          parts: existing.parts, characters: measurement.characters,
          slots: existing.slots, slotsRemaining: segmentation.slotsRemaining,
          ...(links === undefined ? {} : { links }),
        };
      }

      const id = shortId('msg');
      let text = prepared.text;
      if (shortening !== null) {
        if (campaign === null) {
          const name = campaignLabel();
          campaign = { id: openCampaign(deps, auth.apiKeyId, name, now), name };
        }
        const codes = createCodes(deps, prepared, campaign.id, auth.apiKeyId,
          { recipientKey: id, messageId: id, packageId: null, seq: null, dest, clientId: null }, now, now);
        text = materialize(prepared, codes);
        sent++;
      }
      deps.messages.insert({
        id, apiKeyId: auth.apiKeyId, accountId: auth.accountId, serviceId, dest,
        body: account.storeContent ? text : null, bodyHash: hash,
      encoding: measurement.encoding, parts: segmentation.parts, slots: measurement.slots,
      orig: orig ?? null, costCenter: input.costCenter ?? null,
      validTo: validTo?.toISOString() ?? null,
      idempotencyKey: perRecipientIdem ?? null,
      inReplyTo,
      integrationId: input.integrationId ?? null,
      mailFrom: input.mailFrom ?? null,
      requestedBy: input.requestedBy ?? null,
      system: input.system ? 1 : 0,
      campaignId: campaign?.id ?? null,
      createdAt: now.toISOString(),
    });
    deps.jobs.enqueue('send', { messageId: id, text, deliveryReport }, now);
    deps.events.record(id, now, 'queued', null);

    const links = linksBlock(prepared, campaign?.name ?? null, expiresAt);
    return {
      id, status: 'queued', encoding: measurement.encoding, parts: segmentation.parts,
      characters: measurement.characters, slots: measurement.slots, slotsRemaining: segmentation.slotsRemaining,
      ...(links === undefined ? {} : { links }),
    };
    });
    if (campaign !== null) deps.campaigns.addSent(campaign.id, sent);
    return results;
  });
}

/** Kody zapisanej wiadomości w skrócie, do odpowiedzi na powtórzone żądanie. */
function storedLinks(deps: SubmitDeps, messageId: string) {
  const rows = deps.shortLinks.forMessage(messageId);
  const first = rows[0];
  if (first === undefined) return undefined;
  return {
    count: rows.length, domain: deps.linkDomains.get(first.domainId)?.domain ?? null,
    campaign: deps.campaigns.get(first.campaignId)?.name ?? null, expiresAt: first.expiresAt,
  };
}
