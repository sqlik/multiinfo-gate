import { sha256Hex } from '../text/hash.ts';
import { shortId } from '../ids.ts';
import {
  createCodes, linkExpiry, materialize, onceSettings, openCampaign, packageLinksBlock, plainText, prepareLinks, storedLinksBlock,
  type LinkRequest, type LinksResponse, type PreparedText,
} from '../links/shortener.ts';
import type { ApiKeysRepo } from '../store/api-keys.ts';
import type { PackageStatus, RecipientInput } from '../store/packages.ts';
import { measureText, type EncodingRequest } from '../text/measure.ts';
import { InvalidPhoneError, normalizePhone } from '../text/phone.ts';
import { TooManyPartsError, segmentText } from '../text/segment.ts';
import type { AuthContext } from './auth.ts';
import { ApiError } from './errors.ts';
import { resolveOrig } from './orig.ts';
import type { ApiDeps } from './server.ts';

export type SubmitPackageDeps = Pick<ApiDeps, 'accounts' | 'packages' | 'jobs' | 'linkDomains' | 'campaigns' | 'shortLinks'>
  & { apiKeys: Pick<ApiKeysRepo, 'linkSettings'> };

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
  /** Integracja z Power Automate, która zleciła rozsyłkę; brak dla żądań z API. */
  integrationId?: number | undefined;
  /** Zlecający z przepływu Power Automate; brak dla pozostałych źródeł. */
  requestedBy?: string | undefined;
  /** Nagłówek `Idempotency-Key`: powtórzenie tej samej rozsyłki zwraca pierwotną. */
  idempotencyKey?: string | undefined;
  /** Pola skracania z żądania; brak oznacza „pole puste”. */
  links?: LinkRequest | undefined;
  /** Szablony przygotowane i przycięte przez integrację; bez nich szablony powstają z treści. */
  prepared?: { defaultText?: PreparedText; recipients: Array<PreparedText | undefined> } | undefined;
  /** Nazwa kampanii, gdy żądanie jej nie podaje: nazwa integracji; bez niej identyfikator rozsyłki. */
  campaignFallback?: string | undefined;
}

export interface PackageAccepted {
  id: string; status: PackageStatus; recipients: number; encoding: 'gsm' | 'ucs2'; multipart: boolean;
  links?: LinksResponse;
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
 * Wspólna droga każdej rozsyłki - z `POST /v1/packages` i z integracji z Power Automate: usługa,
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
    if (r.text === undefined && input.defaultText === undefined) {
      throw new ApiError(400, 'text_required', `recipients.${index}: brak treści i brak treści domyślnej.`);
    }
    return { dest, text: r.text ?? null, clientId: r.clientId ?? null };
  });
  const integrationId = input.integrationId ?? null;

  // Skrót z wartości po sprawdzeniu: zapis numeru z kodem kraju i bez niego to ta sama rozsyłka.
  const requestHash = sha256Hex(JSON.stringify({
    serviceId, orig: orig ?? null, startAt: startAt?.toISOString() ?? null, deliveryReport: input.deliveryReport,
    encoding: input.encoding, costCenter: input.costCenter ?? null, defaultText: input.defaultText ?? null, recipients,
    ...(input.links === undefined || Object.keys(input.links).length === 0 ? {} : { links: input.links }),
  }));
  const existing = input.idempotencyKey === undefined ? undefined : deps.packages.findByIdempotencyKey(auth.apiKeyId, input.idempotencyKey);
  if (existing && (existing.requestHash !== requestHash || existing.integrationId !== integrationId)) {
    throw new ApiError(409, 'idempotency_conflict', 'Ten klucz idempotencji został już użyty z inną rozsyłką albo przez inną integrację.');
  }

  // Szablony treści: pomiar, kodowanie i limit części dotyczą treści po skróceniu. Powtórzenie przyjętej
  // rozsyłki potrzebuje szablonów tylko do zgłoszeń w bloku `links`, dlatego zmiana domen klucza w międzyczasie
  // nie kończy się błędem.
  const shortener = onceSettings(deps);
  const prepare = (text: string): PreparedText => {
    try {
      return prepareLinks(shortener, auth.apiKeyId, text, input.links ?? {}, {});
    } catch (e) {
      if (existing === undefined || !(e instanceof ApiError)) throw e;
      return plainText(text);
    }
  };
  const defaultTemplate = input.defaultText === undefined ? undefined : input.prepared?.defaultText ?? prepare(input.defaultText);
  const ownTemplates = input.recipients.map((r, index) =>
    r.text === undefined ? undefined : input.prepared?.recipients[index] ?? prepare(r.text));
  // Szablon każdego odbiorcy: własna treść albo treść wspólna. Treść wspólna, której nie używa żaden odbiorca,
  // nie tworzy kampanii i nie trafia do bloku `links`.
  const used = input.recipients.map((_, index) => ownTemplates[index] ?? defaultTemplate!);
  const templates = [...new Set(used)];
  if (existing) {
    const summary = deps.shortLinks.packageSummary(existing.id);
    const campaign = summary && deps.campaigns.get(summary.campaignId);
    const links = storedLinksBlock(templates, summary && {
      count: summary.count, domain: deps.linkDomains.get(summary.domainId)?.domain ?? null,
      campaign: campaign?.name ?? null, expiresAt: summary.expiresAt, linksDisabled: (campaign?.linksDisabledAt ?? null) !== null,
    });
    return {
      id: existing.id, status: existing.status, recipients: existing.recipientsCount, encoding: existing.encoding,
      multipart: existing.multipart === 1, ...(links === undefined ? {} : { links }),
    };
  }

  // Jedno kodowanie i jeden znacznik wieloczęściowości na całą rozsyłkę: tak działa package.aspx.
  const forced = packageEncoding([defaultTemplate?.text, ...ownTemplates.map((t) => t?.text)], input.encoding);
  const partsOf = (text: string, where: string): number => {
    try {
      return segmentText(text, measureText(text, forced), maxParts).parts;
    } catch (e) {
      if (e instanceof TooManyPartsError) throw new ApiError(400, 'too_many_parts', `${where}: ${e.message}`);
      throw e;
    }
  };
  let multipart = defaultTemplate !== undefined && partsOf(defaultTemplate.text, 'defaultText') > 1;
  ownTemplates.forEach((own, index) => {
    if (own !== undefined && partsOf(own.text, `recipients.${index}`) > 1) multipart = true;
  });
  const encoding = forced === 'unicode' ? 'ucs2' : 'gsm';

  const id = shortId('pkg');
  // Kampania powstaje wyłącznie wtedy, gdy co najmniej jeden odbiorca otrzyma krótki link.
  const info = templates.find((t) => t.slots.length > 0)?.info ?? null;
  const campaignName = info === null ? null : info.campaign ?? input.campaignFallback ?? id;
  const linkStart = startAt ?? now;
  const expiresAt = info === null ? null : linkExpiry(linkStart, info.validityDays);
  let codesCount = 0;
  let linksDisabled = false;
  deps.packages.transaction(() => {
    const opened = campaignName === null ? null : openCampaign(deps, auth.apiKeyId, campaignName, now);
    const campaignId = opened?.id ?? null;
    linksDisabled = opened?.linksDisabled ?? false;
    // Treść wspólna z krótkimi linkami staje się treścią indywidualną każdego odbiorcy, a Multiinfo
    // nie otrzymuje treści z kodem zastępczym.
    const stored = recipients.map((r, index): RecipientInput => {
      const template = used[index]!;
      if (campaignId === null || template.slots.length === 0) {
        return { ...r, text: ownTemplates[index] === undefined ? null : template.text };
      }
      const seq = index + 1;
      const codes = createCodes(deps, template, campaignId, auth.apiKeyId,
        { recipientKey: `${id}#${seq}`, messageId: null, packageId: id, seq, dest: r.dest, clientId: r.clientId }, linkStart, now);
      codesCount += codes.length;
      return { ...r, text: materialize(template, codes), links: codes.length };
    });
    const sharedText = defaultTemplate === undefined || defaultTemplate.slots.length > 0 ? null : defaultTemplate.text;
    deps.packages.insert({
      id, apiKeyId: auth.apiKeyId, accountId: auth.accountId, serviceId,
      defaultText: sharedText, orig: orig ?? null, costCenter: input.costCenter ?? null,
      startAt: startAt?.toISOString() ?? null, deliveryReport: input.deliveryReport ? 1 : 0,
      encoding, multipart: multipart ? 1 : 0, createdAt: now.toISOString(),
      integrationId, requestedBy: input.requestedBy ?? null,
      idempotencyKey: input.idempotencyKey ?? null, requestHash: input.idempotencyKey === undefined ? null : requestHash,
      campaignId,
    }, stored);
    if (campaignId !== null) deps.campaigns.addSent(campaignId, stored.filter((r) => (r.links ?? 0) > 0).length);
    deps.jobs.enqueue('package.create', { packageId: id }, now);
  });

  const links = packageLinksBlock(templates, codesCount, campaignName, expiresAt, linksDisabled);
  return { id, status: 'queued', recipients: recipients.length, encoding, multipart, ...(links === undefined ? {} : { links }) };
}
