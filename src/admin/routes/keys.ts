import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { generateApiKey } from '../../api/keys.ts';
import { LinkDomainError, normalizeDomain } from '../../links/domains.ts';
import type { KeyLinkSettings, LinkMode } from '../../store/api-keys.ts';
import { PRIVATE_TARGET_MESSAGE, systemResolver, webhookTarget } from '../../net/private-address.ts';
import { endOfWarsawDay } from '../../time/warsaw.ts';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import {
  chooseAccountPage, editKeyPage, keysPage, linkValuesOf, NEW_LINK_VALUES, newKeyPage, valuesOf,
  type AccountChoice, type CreatedKey, type KeyFormValues, type KeysFilter, type KeyView, type LinkFormValues, type LinkSection,
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
    integrationsOnly: s('integrationsOnly') === '1',
  };
}

/** Sekcja „Skracanie linków”; `null`, gdy formularz jej nie zawiera - ustawienia zostają wtedy bez zmian. */
function linkFormValues(body: Body): LinkFormValues | null {
  if (body.linkMode === undefined) return null;
  const s = (k: string) => String(body[k] ?? '').trim();
  return {
    mode: s('linkMode'), domainIds: values(body.linkDomainIds), defaultDomainId: s('linkDefaultDomainId'),
    targets: String(body.linkTargets ?? ''), validityDays: s('linkValidityDays'), utm: s('linkUtm') === '1',
  };
}

const LINK_MODES: readonly LinkMode[] = ['off', 'sender', 'always'];
const MAX_TARGETS = 200;
const MODE_REQUIRES = 'Tryb skracania inny niż „Wyłączone” wymaga co najmniej jednej';

/** Walidacja sekcji skracania (spec 5.1): domeny istniejące, domyślna z zaznaczonych, cele jako same domeny. */
function checkLinks(v: LinkFormValues, exists: (id: number) => boolean): { ok: true; settings: KeyLinkSettings } | { ok: false; error: string } {
  if (!LINK_MODES.includes(v.mode as LinkMode)) return { ok: false, error: 'Wybierz tryb skracania linków.' };
  const mode = v.mode as LinkMode;
  const days = /^\d{1,3}$/.test(v.validityDays) ? Number(v.validityDays) : NaN;
  if (!(days >= 1 && days <= 365)) return { ok: false, error: 'Ważność linków musi wynosić od 1 do 365 dni.' };
  const domainIds = [...new Set(v.domainIds.map((id) => (/^\d{1,9}$/.test(id) ? Number(id) : NaN)))];
  if (domainIds.some((id) => Number.isNaN(id) || !exists(id))) {
    return { ok: false, error: 'Wybrana domena skracacza nie istnieje. Odśwież formularz i wybierz domenę ponownie.' };
  }
  let defaultDomainId: number | null = domainIds[0] ?? null;
  if (v.defaultDomainId !== '') {
    defaultDomainId = Number(v.defaultDomainId);
    if (!domainIds.includes(defaultDomainId)) return { ok: false, error: 'Domena domyślna musi być jedną z zaznaczonych.' };
  }
  const targets = new Set<string>();
  for (const line of v.targets.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')) {
    try {
      targets.add(normalizeDomain(line));
    } catch (error) {
      if (!(error instanceof LinkDomainError)) throw error;
      return { ok: false, error: `Dozwolone domeny docelowe zawierają nieprawidłowy wpis „${line}”. ${error.message}.` };
    }
  }
  if (targets.size > MAX_TARGETS) return { ok: false, error: `Lista dozwolonych domen docelowych może zawierać najwyżej ${MAX_TARGETS} wpisów.` };
  if (mode !== 'off' && domainIds.length === 0) return { ok: false, error: `${MODE_REQUIRES} domeny skracacza.` };
  if (mode !== 'off' && targets.size === 0) return { ok: false, error: `${MODE_REQUIRES} dozwolonej domeny docelowej.` };
  return { ok: true, settings: { mode, domainIds, defaultDomainId, targets: [...targets].sort(), validityDays: days, utm: v.utm } };
}

const DEFAULT_LINKS: KeyLinkSettings = { mode: 'off', domainIds: [], defaultDomainId: null, targets: [], validityDays: 90, utm: true };

/** Porównanie ustawień niezależne od kolejności zaznaczonych domen. */
const sameLinks = (a: KeyLinkSettings, b: KeyLinkSettings) =>
  JSON.stringify({ ...a, domainIds: [...a.domainIds].sort((x, y) => x - y) })
  === JSON.stringify({ ...b, domainIds: [...b.domainIds].sort((x, y) => x - y) });

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
    return { ok: false, error: `Nadpis spoza listy konta: ${spozaSlownika.join(', ')}. `
      + 'Najpierw należy dopisać go na ekranie kont, po uruchomieniu przez administratora Polkomtel na wniosek z panelu Multiinfo.' };
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
      return { ok: false, error: 'Data ważności ma nieprawidłowy format.' };
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
    if (target.kind === 'unresolved') return `Nazwa serwera z adresu webhooka nie rozwiązuje się na adres IP: ${target.reason}.`;
    return null;
  };

  const domainExists = (id: number) => deps.linkDomains.get(id) !== undefined;

  /** Domeny do wyboru w formularzu: aktywne oraz przypisane do klucza albo zaznaczone w formularzu. */
  const linkSection = (values: LinkFormValues): LinkSection => {
    const keep = new Set(values.domainIds);
    return { values, domains: deps.linkDomains.list().filter((d) => d.enabled === 1 || keep.has(String(d.id))) };
  };

  /** Wpis `klucz.skracanie` z nazwami domen, bez identyfikatorów z bazy. */
  const recordLinks = (request: FastifyRequest, keyId: number, name: string, s: KeyLinkSettings) => {
    const domainName = (id: number) => deps.linkDomains.get(id)?.domain ?? String(id);
    deps.audit.record({
      actor: actorOf(request.adminUserId), action: 'klucz.skracanie', target: `klucz:${keyId}`,
      meta: {
        nazwa: name, tryb: s.mode, domeny: s.domainIds.map(domainName),
        domyslna: s.defaultDomainId === null ? null : domainName(s.defaultDomainId), cele: s.targets, waznosc: s.validityDays, utm: s.utm,
      },
      ip: request.ip,
    });
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
      title: 'Klucze API', active: 'klucze', body: keysPage(views, now(), filter, created, notice, deps.settings.apiUrl()),
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
    return render.page(request, { title: 'Nowy klucz', active: 'klucze', body: newKeyPage(choice, null, undefined, linkSection(NEW_LINK_VALUES)) });
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
    const lv = linkFormValues(body);
    const checked = check(choice, v, now());
    const links = checked.ok ? checkLinks(lv ?? NEW_LINK_VALUES, domainExists) : null;
    const targetError = checked.ok && links?.ok ? await webhookError(checked.webhookUrl) : null;
    if (!checked.ok || !links?.ok || targetError !== null) {
      reply.code(400);
      const error = !checked.ok ? checked.error : !links!.ok ? links!.error : targetError!;
      return render.page(request, {
        title: 'Nowy klucz', active: 'klucze', body: newKeyPage(choice, error, v, linkSection(lv ?? NEW_LINK_VALUES)),
      });
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
      integrationsOnly: v.integrationsOnly ? 1 : 0,
    });
    if (!sameLinks(links.settings, DEFAULT_LINKS)) deps.apiKeys.setLinkSettings(id, links.settings);
    // Nowy subskrybent może zapalić odbiór usługi - odbiornik uzgadnia pętle od razu, nie za 10 s.
    deps.receiver?.refresh({ retryAccount: choice.row.id });

    // W dzienniku zostaje prefiks i adres, nigdy klucz ani sekret - wpisów nie da się później usunąć.
    deps.audit.record({
      actor: actorOf(request.adminUserId),
      action: 'klucz.utworzenie',
      target: `klucz:${id}`,
      meta: {
        nazwa: v.name, konto: choice.row.name, prefiks: generated.prefix, uslugi: v.serviceIds, nadpisy: v.origs,
        webhook: checked.webhookUrl, wazny_do: checked.expiresAt, odbior: v.inboundSubscribed, tylko_integracje: v.integrationsOnly,
      },
      ip: request.ip,
    });
    if (!sameLinks(links.settings, DEFAULT_LINKS)) recordLinks(request, id, v.name, links.settings);

    // Odpowiadamy stroną, a nie przekierowaniem: klucz nie może trafić do adresu,
    // bo adresy lądują w historii przeglądarki i w logach pośredników.
    return listBody(request, { name: v.name, key: generated.key, webhookSecret, integrationsOnly: v.integrationsOnly });
  });

  app.get<{ Params: { id: string } }>('/klucze/:id/edytuj', async (request, reply) => {
    const key = deps.apiKeys.get(Number(request.params.id));
    if (!key || key.revokedAt !== null) return reply.callNotFound();
    const choice = choiceOf(key.accountId);
    if (!choice) return reply.callNotFound();
    reply.type('text/html; charset=utf-8');
    return render.page(request, {
      title: `Klucz ${key.name}`, active: 'klucze',
      body: editKeyPage(choice, key, null, undefined, deps.integrations.listForKey(key.id), linkSection(linkValuesOf(deps.apiKeys.linkSettings(key.id)))),
    });
  });

  app.post<{ Params: { id: string }; Body: Body }>('/klucze/:id/edytuj', async (request, reply) => {
    const key = deps.apiKeys.get(Number(request.params.id));
    if (!key || key.revokedAt !== null) return reply.callNotFound();
    const choice = choiceOf(key.accountId);
    if (!choice) return reply.callNotFound();
    reply.type('text/html; charset=utf-8');

    const body = request.body ?? {};
    const v = formValues(body);
    const linksBefore = deps.apiKeys.linkSettings(key.id);
    const lv = linkFormValues(body) ?? linkValuesOf(linksBefore);
    const checked = check(choice, v, now());
    const links = checkLinks(lv, domainExists);
    const targetError = checked.ok && links.ok ? await webhookError(checked.webhookUrl) : null;
    // Kanał SMS powiadomień wysyła z nadpisem tego klucza: edycja, która go zabiera, zatrzymałaby kanał bez ostrzeżenia.
    const sms = deps.notifications.smsSettings();
    const smsError = checked.ok && sms?.enabled && sms.apiKeyId === key.id && sms.orig !== null
      && !v.origs.includes(sms.orig) && checked.defaultOrig !== sms.orig
      ? `Kanał powiadomień SMS wysyła z nadpisem ${sms.orig} tego klucza. Najpierw wybierz w kanale inny nadpis albo wyłącz kanał, a następnie usuń nadpis z klucza.`
      : null;
    if (!checked.ok || !links.ok || targetError !== null || smsError !== null) {
      reply.code(400);
      const error = !checked.ok ? checked.error : !links.ok ? links.error : (targetError ?? smsError!);
      return render.page(request, {
        title: `Klucz ${key.name}`, active: 'klucze',
        body: editKeyPage(choice, key, error, v, deps.integrations.listForKey(key.id), linkSection(lv)),
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
      integrationsOnly: v.integrationsOnly ? 1 : 0,
    });
    const linksChanged = !sameLinks(links.settings, linksBefore);
    if (linksChanged) deps.apiKeys.setLinkSettings(key.id, links.settings);
    deps.receiver?.refresh({ retryAccount: key.accountId });
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
    if (linksChanged) recordLinks(request, key.id, v.name, links.settings);

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

    // Włączona integracja na odwołanym kluczu psułaby się po cichu przy pierwszym zdarzeniu.
    const live = deps.integrations.listForKey(id).filter((i) => i.enabled === 1);
    if (live.length > 0) {
      render.flash(request, 'warn', `Klucz ${key.name} ma włączone integracje (${live.map((i) => i.name).join(', ')}). `
        + 'Najpierw wyłącz te integracje albo przenieś je na inny klucz, potem odwołaj klucz.');
      return reply.redirect('/klucze', 302);
    }
    // Kanał SMS powiadomień na odwołanym kluczu przestałby wysyłać bez ostrzeżenia (spec 8.1).
    const sms = deps.notifications.smsSettings();
    if (sms?.enabled && sms.apiKeyId === id) {
      render.flash(request, 'warn', `Klucz ${key.name} jest używany przez kanał powiadomień SMS. `
        + 'Najpierw wskaż w kanale inny klucz albo wyłącz kanał, potem odwołaj klucz.');
      return reply.redirect('/klucze', 302);
    }

    deps.apiKeys.revoke(id);
    // Odwołany subskrybent może gasić odbiór usługi.
    deps.receiver?.refresh({ retryAccount: key.accountId });
    deps.audit.record({
      actor: actorOf(request.adminUserId),
      action: 'klucz.odwolanie',
      target: `klucz:${id}`,
      meta: { nazwa: key.name, prefiks: key.keyPrefix },
      ip: request.ip,
    });
    render.flash(request, 'ok', `Klucz ${key.name} odwołany. Żądania z tym kluczem otrzymują od teraz odpowiedź 401.`);
    return reply.redirect('/klucze', 302);
  });
}
