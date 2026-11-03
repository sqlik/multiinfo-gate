import { sha256Hex } from '../text/hash.ts';
import { shortId } from '../ids.ts';
import type { PackageStatus, RecipientInput } from '../store/packages.ts';
import { measureText, type EncodingRequest } from '../text/measure.ts';
import { InvalidPhoneError, normalizePhone } from '../text/phone.ts';
import { TooManyPartsError, segmentText } from '../text/segment.ts';
import type { AuthContext } from './auth.ts';
import { ApiError } from './errors.ts';
import { resolveOrig } from './orig.ts';
import type { ApiDeps } from './server.ts';

export type SubmitPackageDeps = Pick<ApiDeps, 'accounts' | 'packages' | 'jobs'>;

export interface PackageSubmitInput {
  recipients: Array<{ to: string; text?: string | undefined; clientId?: string | undefined }>;
  defaultText?: string | undefined;
  serviceId?: string | undefined;
  orig?: string | undefined;
  startAt?: string | undefined;
  deliveryReport: boolean;
  encoding: EncodingRequest;
  costCenter?: string | undefined;
  /** Limit części niższy niż klucza (integracja); wyższy niż klucza nie działa. */
  maxParts?: number | undefined;
  /** Integracja Power Automate, która zleciła rozsyłkę; brak dla żądań z API. */
  integrationId?: number | undefined;
  /** Zlecający z przepływu Power Automate; brak dla pozostałych źródeł. */
  requestedBy?: string | undefined;
  /** Nagłówek `Idempotency-Key`: powtórzenie tej samej rozsyłki zwraca pierwotną. */
  idempotencyKey?: string | undefined;
}

export interface PackageAccepted {
  id: string; status: PackageStatus; recipients: number; encoding: 'gsm' | 'ucs2'; multipart: boolean;
}

/**
 * Identyfikator klienta idzie do Plusa w nawiasach kwadratowych przed przecinkiem
 * oddzielającym treść - nie może zawierać nic, co ten zapis rozbije.
 */
const CLIENT_ID = /^[A-Za-z0-9._-]{1,20}$/;

/**
 * Kodowanie całej rozsyłki: package.aspx przyjmuje jedno kodowanie dla wszystkich treści.
 * Polska treść jednego odbiorcy przełącza więc na UCS-2 każdą treść, także treść wspólną,
 * którą bramka przekazuje do Multiinfo zawsze, gdy jest podana. Limit części trzeba liczyć
 * w tym kodowaniu, inaczej treść GSM na granicy jednej części zajmie w UCS-2 trzy.
 */
export function packageEncoding(texts: ReadonlyArray<string | undefined>, requested: EncodingRequest): 'gsm' | 'unicode' {
  if (requested !== 'auto') return requested === 'unicode' ? 'unicode' : 'gsm';
  return texts.some((t) => t !== undefined && measureText(t, 'auto').encoding === 'ucs2') ? 'unicode' : 'gsm';
}

/**
 * Wspólna droga każdej rozsyłki - z `POST /v1/packages` i z integracji Power Automate: usługa,
 * nadpis, termin, numery, treści, zapis, kolejka. Rozsyłka wchodzi w całości albo wcale.
 */
export function submitPackage(deps: SubmitPackageDeps, auth: AuthContext, input: PackageSubmitInput, now: Date): PackageAccepted {
  const account = deps.accounts.get(auth.accountId);
  if (!account) throw new ApiError(500, 'account_missing', 'Konto przypisane do klucza nie istnieje.');

  const serviceId = String(input.serviceId ?? auth.defaultServiceId ?? '');
  if (!serviceId) throw new ApiError(400, 'service_required', 'Klucz nie ma domyślnej usługi - podaj serviceId.');
  if (!auth.allowedServiceIds.includes(serviceId)) {
    throw new ApiError(403, 'service_not_allowed', `Klucz nie ma dostępu do usługi ${serviceId}.`);
  }

  const orig = resolveOrig(input.orig, auth, account, deps.accounts);

  let startAt: Date | undefined;
  if (input.startAt !== undefined) {
    startAt = new Date(input.startAt);
    if (startAt.getTime() <= now.getTime()) {
      throw new ApiError(400, 'start_at_in_past', 'Termin rozpoczęcia rozsyłki już minął.');
    }
  }

  const maxParts = Math.min(input.maxParts ?? auth.maxParts, auth.maxParts);

  // Jedno kodowanie i jeden znacznik wieloczęściowości na całą rozsyłkę: tak działa package.aspx.
  const forced = packageEncoding([input.defaultText, ...input.recipients.map((r) => r.text)], input.encoding);
  const partsOf = (text: string, where: string): number => {
    try {
      return segmentText(text, measureText(text, forced), maxParts).parts;
    } catch (e) {
      if (e instanceof TooManyPartsError) throw new ApiError(400, 'too_many_parts', `${where}: ${e.message}`);
      throw e;
    }
  };
  let multipart = input.defaultText !== undefined && partsOf(input.defaultText, 'defaultText') > 1;
  const recipients: RecipientInput[] = input.recipients.map((r, index) => {
    let dest: string;
    try {
      dest = normalizePhone(r.to, account.defaultCountryCode);
    } catch (e) {
      if (e instanceof InvalidPhoneError) throw new ApiError(400, 'invalid_phone', `recipients.${index}: ${e.message}`);
      throw e;
    }
    if (r.clientId !== undefined && !CLIENT_ID.test(r.clientId)) {
      throw new ApiError(400, 'invalid_client_id',
        `recipients.${index}: identyfikator klienta może mieć 1-20 znaków z zakresu A-Z, a-z, 0-9, kropka, podkreślenie, myślnik.`);
    }
    const text = r.text ?? input.defaultText;
    if (text === undefined) {
      throw new ApiError(400, 'text_required', `recipients.${index}: brak treści i brak treści domyślnej.`);
    }
    // Treść wspólną policzyło już sprawdzenie przed pętlą.
    if (r.text !== undefined && partsOf(r.text, `recipients.${index}`) > 1) multipart = true;
    return { dest, text: r.text ?? null, clientId: r.clientId ?? null };
  });

  const encoding = forced === 'unicode' ? 'ucs2' : 'gsm';
  const integrationId = input.integrationId ?? null;

  // Skrót z wartości po sprawdzeniu: zapis numeru z kodem kraju i bez niego to ta sama rozsyłka.
  const requestHash = sha256Hex(JSON.stringify({
    serviceId, orig: orig ?? null, startAt: startAt?.toISOString() ?? null, deliveryReport: input.deliveryReport,
    encoding: input.encoding, costCenter: input.costCenter ?? null, defaultText: input.defaultText ?? null, recipients,
  }));
  if (input.idempotencyKey !== undefined) {
    const existing = deps.packages.findByIdempotencyKey(auth.apiKeyId, input.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash || existing.integrationId !== integrationId) {
        throw new ApiError(409, 'idempotency_conflict',
          'Ten klucz idempotencji został już użyty z inną rozsyłką albo przez inną integrację.');
      }
      return { id: existing.id, status: existing.status, recipients: existing.recipientsCount, encoding: existing.encoding, multipart: existing.multipart === 1 };
    }
  }

  const id = shortId('pkg');
  deps.packages.transaction(() => {
    deps.packages.insert({
      id, apiKeyId: auth.apiKeyId, accountId: auth.accountId, serviceId,
      defaultText: input.defaultText ?? null, orig: orig ?? null, costCenter: input.costCenter ?? null,
      startAt: startAt?.toISOString() ?? null, deliveryReport: input.deliveryReport ? 1 : 0,
      encoding, multipart: multipart ? 1 : 0, createdAt: now.toISOString(),
      integrationId, requestedBy: input.requestedBy ?? null,
      idempotencyKey: input.idempotencyKey ?? null, requestHash: input.idempotencyKey === undefined ? null : requestHash,
    }, recipients);
    deps.jobs.enqueue('package.create', { packageId: id }, now);
  });

  return { id, status: 'queued', recipients: recipients.length, encoding, multipart };
}
