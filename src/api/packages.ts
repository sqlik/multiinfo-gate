import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PackageRow, RecipientInput, RecipientRow } from '../store/packages.ts';
import { measureText } from '../text/measure.ts';
import { InvalidPhoneError, normalizePhone } from '../text/phone.ts';
import { TooManyPartsError, segmentText } from '../text/segment.ts';
import { authenticate } from './auth.ts';
import { ApiError } from './errors.ts';
import { resolveOrig } from './orig.ts';
import type { ApiDeps } from './server.ts';

/** Górna granica jednej rozsyłki - powyżej niej ciało żądania i wywołanie package.aspx rosną bez sensu. */
const MAX_RECIPIENTS = 5000;

const recipientSchema = z.object({
  to: z.string(),
  text: z.string().min(1).optional(),
  clientId: z.string().optional(),
});

const bodySchema = z.object({
  serviceId: z.union([z.string(), z.number()]).optional(),
  defaultText: z.string().min(1).optional(),
  recipients: z.array(recipientSchema).min(1).max(MAX_RECIPIENTS),
  orig: z.string().optional(),
  startAt: z.string().datetime().optional(),
  deliveryReport: z.boolean().default(true),
  encoding: z.enum(['auto', 'gsm', 'unicode']).default('auto'),
  costCenter: z.string().optional(),
});

/**
 * Identyfikator klienta idzie do Plusa w nawiasach kwadratowych przed przecinkiem
 * oddzielającym treść - nie może zawierać nic, co ten zapis rozbije.
 */
const CLIENT_ID = /^[A-Za-z0-9._-]{1,20}$/;

const shortId = () => `pkg_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

/** Nagłówek CSV; średnik jako separator, bo tak otwierają go polskie arkusze. */
const CSV_HEADER = 'numer;identyfikator_klienta;id_multiinfo;status;status_multiinfo;czas';

/** Wartość CSV: cudzysłów tylko, gdy trzeba - pola numeryczne i statusy zostają gołe. */
function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Raport rozsyłki w postaci CSV - ten sam plik z API i z panelu. */
export function reportCsv(rows: RecipientRow[]): string {
  const lines = rows.map((r) =>
    [r.dest, r.clientId, r.miId, r.status, r.miStatus, r.statusChangedAt].map(csvCell).join(';'));
  return `${[CSV_HEADER, ...lines].join('\r\n')}\r\n`;
}

const reportRow = (r: RecipientRow) => ({
  to: r.dest, clientId: r.clientId, miId: r.miId, status: r.status, miStatus: r.miStatus, changedAt: r.statusChangedAt,
});

/** Klient prosi o CSV parametrem `format` albo nagłówkiem Accept; domyślnie JSON. */
function wantsCsv(query: Record<string, string>, accept: string | undefined): boolean {
  return query.format === 'csv' || (query.format === undefined && (accept ?? '').includes('text/csv'));
}

export function registerPackageRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const now = deps.now ?? (() => new Date());

  app.post('/v1/packages', async (request, reply) => {
    const auth = authenticate(request.headers.authorization, deps.apiKeys);

    if (!deps.rateLimiter.check(auth.apiKeyId, auth.ratePerMin)) {
      throw new ApiError(429, 'rate_limited', `Przekroczono limit ${auth.ratePerMin} żądań na minutę.`);
    }

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_body',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    const input = parsed.data;

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
      if (startAt.getTime() <= now().getTime()) {
        throw new ApiError(400, 'start_at_in_past', 'Termin rozpoczęcia rozsyłki już minął.');
      }
    }

    // Jedno kodowanie i jeden znacznik wieloczęściowości na całą rozsyłkę: tak działa package.aspx.
    let ucs2 = false;
    let multipart = false;
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
      const measurement = measureText(text, input.encoding);
      let segmentation;
      try {
        segmentation = segmentText(text, measurement, auth.maxParts);
      } catch (e) {
        if (e instanceof TooManyPartsError) throw new ApiError(400, 'too_many_parts', `recipients.${index}: ${e.message}`);
        throw e;
      }
      if (measurement.encoding === 'ucs2') ucs2 = true;
      if (segmentation.parts > 1) multipart = true;
      return { dest, text: r.text ?? null, clientId: r.clientId ?? null };
    });

    const encoding = ucs2 && input.encoding !== 'gsm' ? 'ucs2' : 'gsm';
    const id = shortId();
    const at = now();
    deps.packages.insert({
      id, apiKeyId: auth.apiKeyId, accountId: auth.accountId, serviceId,
      defaultText: input.defaultText ?? null, orig: orig ?? null, costCenter: input.costCenter ?? null,
      startAt: startAt?.toISOString() ?? null, deliveryReport: input.deliveryReport ? 1 : 0,
      encoding, multipart: multipart ? 1 : 0, createdAt: at.toISOString(),
    }, recipients);
    deps.jobs.enqueue('package.create', { packageId: id }, at);

    reply.code(202);
    return { id, status: 'queued', recipients: recipients.length, encoding, multipart };
  });

  app.get<{ Params: { id: string } }>('/v1/packages/:id', async (request) => {
    const auth = authenticate(request.headers.authorization, deps.apiKeys);
    const pkg = deps.packages.get(request.params.id);
    // Brak rozsyłki i cudza rozsyłka dają tę samą odpowiedź - nie potwierdzamy istnienia.
    if (!pkg || pkg.apiKeyId !== auth.apiKeyId) {
      throw new ApiError(404, 'package_not_found', 'Nie ma rozsyłki o tym identyfikatorze.');
    }
    return present(pkg, pkg.reportStatus === 'ready' ? deps.packages.recipientSummary(pkg.id) : null);
  });

  const owned = (id: string, authorization: string | undefined): PackageRow => {
    const auth = authenticate(authorization, deps.apiKeys);
    const pkg = deps.packages.get(id);
    if (!pkg || pkg.apiKeyId !== auth.apiKeyId) {
      throw new ApiError(404, 'package_not_found', 'Nie ma rozsyłki o tym identyfikatorze.');
    }
    return pkg;
  };

  /** Zamówienie raportu - także ponowne, gdy poprzedni wygasł albo się nie udał. */
  app.post<{ Params: { id: string } }>('/v1/packages/:id/report', async (request, reply) => {
    const pkg = owned(request.params.id, request.headers.authorization);
    if (pkg.status !== 'completed') {
      throw new ApiError(409, 'package_not_completed', `Raport jest dostępny po zakończeniu rozsyłki; stan: ${pkg.status}.`);
    }
    deps.packages.setReport(pkg.id, { status: 'pending' });
    deps.jobs.enqueue('package.report', { packageId: pkg.id }, now());
    reply.code(202);
    return { id: pkg.id, report: { status: 'pending' } };
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/v1/packages/:id/report',
    async (request, reply) => {
      const pkg = owned(request.params.id, request.headers.authorization);
      if (pkg.reportStatus !== 'ready') {
        return reply.code(409).send({
          error: { code: 'report_not_ready', message: `Raport nie jest gotowy; stan: ${pkg.reportStatus}.` },
          report: { status: pkg.reportStatus },
        });
      }
      const rows = deps.packages.recipients(pkg.id);
      if (wantsCsv(request.query, request.headers.accept)) {
        reply.type('text/csv; charset=utf-8');
        reply.header('content-disposition', `attachment; filename="${pkg.id}.csv"`);
        return reportCsv(rows);
      }
      return { id: pkg.id, report: { status: 'ready', expiresAt: pkg.reportExpiresAt }, rows: rows.map(reportRow) };
    },
  );
}

/** Kształt rozsyłki widziany z zewnątrz. Podsumowanie odbiorców tylko po wczytaniu raportu. */
function present(p: PackageRow, summary: { delivered: number; failed: number; other: number } | null) {
  return {
    id: p.id,
    status: p.status,
    recipients: p.recipientsCount,
    remaining: p.remainingCount,
    encoding: p.encoding,
    multipart: p.multipart === 1,
    serviceId: p.serviceId,
    orig: p.orig,
    startAt: p.startAt,
    createdAt: p.createdAt,
    completedAt: p.completedAt,
    providerCode: p.providerCode,
    error: p.error,
    report: { status: p.reportStatus, expiresAt: p.reportExpiresAt },
    summary,
  };
}
