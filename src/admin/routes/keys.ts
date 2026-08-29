import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { generateApiKey } from '../../api/keys.ts';
import { PRIVATE_TARGET_MESSAGE, systemResolver, webhookTarget } from '../../net/private-address.ts';
import { endOfWarsawDay } from '../../time/warsaw.ts';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import {
  chooseAccountPage, editKeyPage, keysPage, newKeyPage, valuesOf,
  type AccountChoice, type CreatedKey, type KeyFormValues, type KeysFilter, type KeyView,
} from '../views/keys.ts';

type Body = Record<string, string | string[] | undefined>;

/** Pole formularza z wieloma zaznaczeniami przychodzi raz jako tekst, raz jako tablica. */
function values(field: string | string[] | undefined): string[] {
  if (field === undefined) return [];
  const list = Array.isArray(field) ? field : [field];
  return list.map((x) => String(x).trim()).filter((x) => x.length > 0);
}

const WEBHOOK_URL_ERROR = 'Adres webhooka musi zaczynać się od https:// (albo http:// w sieci wewnętrznej).';

/** Adres pusty wyłącza webhook; inny musi być absolutnym adresem HTTP(S) bez białych znaków. */
function parseWebhookUrl(raw: string): { ok: true; url: string | null } | { ok: false } {
  const url = raw.trim();
  if (url === '') return { ok: true, url: null };
  return /^https?:\/\/\S+$/.test(url) ? { ok: true, url } : { ok: false };
}

/** Sekret generuje bramka: 32 bajty losowe, jak klucz API. Ręcznie wpisany bywa słaby. */
const newWebhookSecret = () => randomBytes(32).toString('base64url');

function positiveInt(raw: string, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function formValues(body: Body): KeyFormValues {
  const s = (k: string) => String(body[k] ?? '').trim();
  return {
    name: s('name'), serviceIds: values(body.serviceIds), defaultServiceId: s('defaultServiceId'),
    origs: values(body.origs), defaultOrig: s('defaultOrig'), maxParts: s('maxParts'), ratePerMin: s('ratePerMin'),
    webhookUrl: s('webhookUrl'), expiresOn: s('expiresOn'), noExpiry: s('noExpiry') === '1',
    inboundSubscribed: s('inboundSubscribed') === '1',
  };
}

/** Wynik walidacji pól wspólnych; `error` zamiast wyjątku, bo trasa rysuje formularz z komunikatem. */
type Checked =
  | { ok: true; defaultServiceId: string; defaultOrig: string | null; maxParts: number; ratePerMin: number;
      webhookUrl: string | null; expiresAt: string | null }
  | { ok: false; error: string };

function check(choice: AccountChoice, v: KeyFormValues, today: Date): Checked {
  if (v.name === '') return { ok: false, error: 'Podaj nazwę klucza.' };
  if (v.serviceIds.length === 0) return { ok: false, error: 'Zaznacz przynajmniej jedno ID usługi.' };
  const obce = v.serviceIds.filter((id) => !choice.serviceIds.includes(id));
  if (obce.length > 0) return { ok: false, error: `Konto ${choice.row.name} nie ma dostępu do ID usługi: ${obce.join(', ')}.` };
  const defaultServiceId = v.defaultServiceId === '' ? v.serviceIds[0]! : v.defaultServiceId;
  if (!v.serviceIds.includes(defaultServiceId)) return { ok: false, error: 'Domyślne ID usługi musi być jednym z zaznaczonych.' };
  const spozaSlownika = v.origs.filter((o) => !choice.origs.includes(o));
  if (spozaSlownika.length > 0) {
    return { ok: false, error: `Nadpis spoza słownika konta: ${spozaSlownika.join(', ')}. `
      + 'Najpierw dopisz go na ekranie kont - po uruchomieniu przez Polkomtel na wniosek z panelu Multiinfo.' };
  }
  if (v.defaultOrig !== '' && !v.origs.includes(v.defaultOrig)) {
    return { ok: false, error: 'Domyślny nadpis klucza musi być jednym z zaznaczonych.' };
  }
  const webhook = parseWebhookUrl(v.webhookUrl);
  if (!webhook.ok) return { ok: false, error: WEBHOOK_URL_ERROR };
  if (v.inboundSubscribed && webhook.url === null) {
    return { ok: false, error: 'Odbiór wiadomości przychodzących wymaga adresu webhooka.' };
  }
  let expiresAt: string | null;
  if (v.noExpiry) expiresAt = null;
  else if (v.expiresOn === '') return { ok: false, error: 'Podaj datę ważności albo zaznacz „Nie wygasa”.' };
  else {
    try {
      expiresAt = endOfWarsawDay(v.expiresOn);
    } catch {
      return { ok: false, error: 'Data ważności ma zły format.' };
    }
    if (Date.parse(expiresAt) <= today.getTime()) return { ok: false, error: 'Data ważności nie może być w przeszłości.' };
  }
  return {
    ok: true, defaultServiceId, defaultOrig: v.defaultOrig === '' ? null : v.defaultOrig,
    maxParts: positiveInt(v.maxParts, 5, 9), ratePerMin: positiveInt(v.ratePerMin, 60, 6000),
    webhookUrl: webhook.url, expiresAt,
  };
}

export function registerKeyRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  const now = deps.now ?? (() => new Date());

  const actorOf = (userId: number | null): string => {
    if (userId === null) return '(nieznany)';
    return deps.users.findById(userId)?.login ?? String(userId);
  };

  /**
   * Adres webhooka sprawdzany przy zapisie: cel w sieci wewnętrznej bez zgody w środowisku
   * i nazwa bez adresu wracają jako błąd formularza, zamiast psuć się po cichu przy dostawie.
   */
  const webhookError = async (url: string | null): Promise<string | null> => {
    if (url === null) return null;
    const target = await webhookTarget(url, deps.resolve ?? systemResolver);
    if (target.kind === 'private' && !deps.allowPrivateWebhooks) {
      return `${PRIVATE_TARGET_MESSAGE} (${target.address}).`;
    }
    if (target.kind === 'unresolved') return `Nazwa z adresu webhooka nie rozwiązuje się: ${target.reason}.`;
    return null;
  };

  const choiceOf = (accountId: number): AccountChoice | null => {
    const row = deps.accounts.get(accountId);
    if (!row) return null;
    return { row, serviceIds: deps.accounts.serviceIds(accountId), origs: deps.accounts.origs(accountId) };
  };

  const listBody = (
    request: FastifyRequest, created: CreatedKey | null = null, notice: string | null = null,
    filter: KeysFilter = 'czynne',
  ) => {
    const names = new Map(deps.accounts.list().map((a) => [a.id, a.name]));
    const views: KeyView[] = deps.apiKeys.list().map((row) => ({
      row,
      accountName: names.get(row.accountId) ?? `konto ${row.accountId}`,
    }));
    return render.page(request, {
      title: 'Klucze API', active: 'klucze', body: keysPage(views, now(), filter, created, notice),
    });
  };

  app.get<{ Querystring: { status?: string } }>('/klucze', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return listBody(request, null, null, request.query.status === 'odwolane' ? 'odwolane' : 'czynne');
  });

  app.get<{ Querystring: { accountId?: string } }>('/klucze/nowy', async (request, reply) => {
    const raw = request.query.accountId;
    if (raw === undefined) {
      reply.type('text/html; charset=utf-8');
      return render.page(request, {
        title: 'Nowy klucz', active: 'klucze',
        body: chooseAccountPage(deps.accounts.list()),
      });
    }

    const choice = choiceOf(Number(raw));
    // Typ odpowiedzi dopiero po sprawdzeniu - domyślna odpowiedź 404 jest JSON-em, nie stroną.
    if (!choice) return reply.callNotFound();
    reply.type('text/html; charset=utf-8');
    return render.page(request, { title: 'Nowy klucz', active: 'klucze', body: newKeyPage(choice) });
  });

  app.post<{ Body: Body }>('/klucze', async (request, reply) => {
    reply.type('text/html; charset=utf-8');

    const body = request.body ?? {};
    const accountId = Number(body.accountId);
    const choice = choiceOf(accountId);
    if (!choice) {
      reply.code(400);
      return listBody(request, null, 'Wskazane konto nie istnieje.');
    }

    const v = formValues(body);
    const checked = check(choice, v, now());
    const targetError = checked.ok ? await webhookError(checked.webhookUrl) : null;
    if (!checked.ok || targetError !== null) {
      reply.code(400);
      const error = checked.ok ? targetError! : checked.error;
      return render.page(request, { title: 'Nowy klucz', active: 'klucze', body: newKeyPage(choice, error, v) });
    }
    const webhookSecret = checked.webhookUrl === null ? null : newWebhookSecret();

    const generated = generateApiKey();
    const id = deps.apiKeys.insert({
      accountId,
      name: v.name,
      keyHash: generated.hash,
      keyPrefix: generated.prefix,
      defaultServiceId: checked.defaultServiceId,
      defaultOrig: checked.defaultOrig,
      maxParts: checked.maxParts,
      ratePerMin: checked.ratePerMin,
      webhookUrl: checked.webhookUrl,
      webhookSecret,
      serviceIds: v.serviceIds,
      origs: v.origs,
      expiresAt: checked.expiresAt,
      inboundSubscribed: v.inboundSubscribed ? 1 : 0,
    });
    // Nowy subskrybent może zapalić odbiór usługi - odbiornik uzgadnia pętle od razu, nie za 10 s.
    deps.receiver?.refresh({ retryStopped: true });

    // W dzienniku zostaje prefiks i adres, nigdy klucz ani sekret - wpisów nie da się później usunąć.
    deps.audit.record({
      actor: actorOf(request.adminUserId),
      action: 'klucz.utworzenie',
      target: `klucz:${id}`,
      meta: {
        nazwa: v.name, konto: choice.row.name, prefiks: generated.prefix, uslugi: v.serviceIds, nadpisy: v.origs,
        webhook: checked.webhookUrl, wazny_do: checked.expiresAt, odbior: v.inboundSubscribed,
      },
      ip: request.ip,
    });

    // Odpowiadamy stroną, a nie przekierowaniem: klucz nie może trafić do adresu,
    // bo adresy lądują w historii przeglądarki i w logach pośredników.
    return listBody(request, { name: v.name, key: generated.key, webhookSecret });
  });

  app.get<{ Params: { id: string } }>('/klucze/:id/edytuj', async (request, reply) => {
    const key = deps.apiKeys.get(Number(request.params.id));
    if (!key || key.revokedAt !== null) return reply.callNotFound();
    const choice = choiceOf(key.accountId);
    if (!choice) return reply.callNotFound();
    reply.type('text/html; charset=utf-8');
    return render.page(request, { title: `Klucz ${key.name}`, active: 'klucze', body: editKeyPage(choice, key) });
  });

  app.post<{ Params: { id: string }; Body: Body }>('/klucze/:id/edytuj', async (request, reply) => {
    const key = deps.apiKeys.get(Number(request.params.id));
    if (!key || key.revokedAt !== null) return reply.callNotFound();
    const choice = choiceOf(key.accountId);
    if (!choice) return reply.callNotFound();
    reply.type('text/html; charset=utf-8');

    const body = request.body ?? {};
    const v = formValues(body);
    const checked = check(choice, v, now());
    const targetError = checked.ok ? await webhookError(checked.webhookUrl) : null;
    if (!checked.ok || targetError !== null) {
      reply.code(400);
      const error = checked.ok ? targetError! : checked.error;
      return render.page(request, {
        title: `Klucz ${key.name}`, active: 'klucze', body: editKeyPage(choice, key, error, v),
      });
    }

    // Sekret: podany jawnie -> zapis; adres zmieniony bez sekretu -> nowy, pokazany raz;
    // adres bez zmian i bez sekretu -> bez zmiany; brak adresu -> kasujemy.
    const typedSecret = String(body.webhookSecret ?? '').trim();
    let webhookSecret: string | null | undefined;
    let revealed: string | null = null;
    if (checked.webhookUrl === null) webhookSecret = null;
    else if (typedSecret !== '') webhookSecret = typedSecret;
    else if (checked.webhookUrl !== key.webhookUrl) {
      revealed = newWebhookSecret();
      webhookSecret = revealed;
    }

    const before = valuesOf(key);
    deps.apiKeys.update(key.id, {
      name: v.name, defaultServiceId: checked.defaultServiceId, defaultOrig: checked.defaultOrig,
      maxParts: checked.maxParts, ratePerMin: checked.ratePerMin, webhookUrl: checked.webhookUrl,
      ...(webhookSecret === undefined ? {} : { webhookSecret }),
      expiresAt: checked.expiresAt, serviceIds: v.serviceIds, origs: v.origs,
      inboundSubscribed: v.inboundSubscribed ? 1 : 0,
    });
    deps.receiver?.refresh({ retryStopped: true });
    const after = valuesOf(deps.apiKeys.get(key.id)!);
    const changed: string[] = (Object.keys(after) as Array<keyof KeyFormValues>)
      .filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]))
      .map((k) => (k === 'expiresOn' || k === 'noExpiry' ? 'expiresAt' : k));
    if (webhookSecret !== undefined) changed.push('webhookSecret');

    // W dzienniku nazwy pól, nigdy sekret.
    deps.audit.record({
      actor: actorOf(request.adminUserId), action: 'klucz.edycja', target: `klucz:${key.id}`,
      meta: { nazwa: v.name, prefiks: key.keyPrefix, pola: [...new Set(changed)] }, ip: request.ip,
    });

    if (revealed !== null) {
      // Nowy sekret nie może trafić do adresu, więc odpowiadamy stroną, jak przy tworzeniu klucza.
      return listBody(request, { name: v.name, key: null, webhookSecret: revealed });
    }
    render.flash(request, 'ok', `Klucz ${v.name} zapisany.`);
    return reply.redirect('/klucze', 302);
  });

  app.post<{ Params: { id: string } }>('/klucze/:id/odwolaj', async (request, reply) => {
    const id = Number(request.params.id);
    const key = deps.apiKeys.get(id);
    if (!key) return reply.callNotFound();

    deps.apiKeys.revoke(id);
    // Odwołany subskrybent może gasić odbiór usługi.
    deps.receiver?.refresh({ retryStopped: true });
    deps.audit.record({
      actor: actorOf(request.adminUserId),
      action: 'klucz.odwolanie',
      target: `klucz:${id}`,
      meta: { nazwa: key.name, prefiks: key.keyPrefix },
      ip: request.ip,
    });
    render.flash(request, 'ok', `Klucz ${key.name} odwołany. Żądania z tym kluczem dostają od teraz 401.`);
    return reply.redirect('/klucze', 302);
  });
}
