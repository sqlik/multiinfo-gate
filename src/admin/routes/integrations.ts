import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { matches } from '../../integrations/conditions.ts';
import { INTEGRATION_KINDS, type InboundConfig, type IntegrationKind, type OutboundConfig } from '../../integrations/config.ts';
import { previewInbound } from '../../integrations/pipeline.ts';
import { presetById, presetsFor, type Preset } from '../../integrations/presets/index.ts';
import { PRIVATE_TARGET_MESSAGE, systemResolver, webhookTarget } from '../../net/private-address.ts';
import type { IntegrationRow } from '../../store/integrations.ts';
import { buildOutboundContext, previewOutbound } from '../../worker/integrations.ts';
import { formToConfig, formValues, type ExistingSecrets } from '../integration-form.ts';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { WINDOW_MS } from '../window.ts';
import {
  chooseKindPage, choosePresetPage, integrationDetailPage, integrationFormPage, integrationsPage, valuesFromPreset, valuesOf,
  type CreatedHook, type FormContext, type FormPreview, type IntegrationFormValues, type IntegrationsFilter, type IntegrationView,
  type KeyOption,
} from '../views/integrations.ts';

type Body = Record<string, string | string[] | undefined>;

/** To, co zostaje po walidacji formularza: konfiguracja, komplet sekretów do zapisu i czy sekrety się zmieniły. */
interface SavedForm {
  config: IntegrationRow['config']; secrets: Record<string, string>; secretsChanged: boolean;
  keyId: number; accountId: number; v: IntegrationFormValues;
}

const isKind = (raw: string | undefined): raw is IntegrationKind => (INTEGRATION_KINDS as string[]).includes(raw ?? '');

export function registerIntegrationRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  const now = deps.now ?? (() => new Date());

  const presetNames = new Map(presetsFor('webhook_in').concat(presetsFor('webhook_out')).map((p) => [p.id, p.name]));

  /** Czynne klucze z usługami i nadpisami - do wyboru w formularzu i do filtra listy. */
  const keyOptions = (): KeyOption[] => {
    const accounts = new Map(deps.accounts.list().map((a) => [a.id, a.name]));
    return deps.apiKeys.list().filter((k) => k.revokedAt === null).map((k) => ({
      id: k.id, name: k.name, accountName: accounts.get(k.accountId) ?? `konto ${k.accountId}`,
      serviceIds: k.allowedServiceIds, origs: k.allowedOrigs,
    }));
  };

  const viewOf = (row: IntegrationRow, since: Date): IntegrationView => {
    const key = deps.apiKeys.get(row.apiKeyId);
    const account = key ? deps.accounts.get(key.accountId) : undefined;
    return {
      row, keyName: key?.name ?? `klucz ${row.apiKeyId}`, accountName: account?.name ?? '',
      presetName: presetNames.get(row.preset) ?? row.preset,
      counts: deps.integrationEvents.countsSince(row.id, since),
      lastEvent: deps.integrationEvents.latest(row.id) ?? null,
    };
  };

  const listBody = (request: FastifyRequest, filter: IntegrationsFilter, created: { name: string; hookId: string } | null = null) => {
    const since = new Date(now().getTime() - WINDOW_MS);
    const rows = deps.integrations.list()
      .filter((r) => filter.kind === null || r.kind === (filter.kind === 'in' ? 'webhook_in' : 'webhook_out'))
      .filter((r) => filter.keyId === null || r.apiKeyId === filter.keyId);
    return render.page(request, {
      title: 'Integracje', active: 'integracje',
      body: integrationsPage(rows.map((r) => viewOf(r, since)), filter, keyOptions(), created, deps.settings.apiUrl()),
    });
  };

  const formContext = (kind: IntegrationKind, preset: Preset, row?: IntegrationRow): FormContext => ({
    kind, preset, keys: keyOptions(), secretNames: row ? deps.integrations.secretNames(row.id) : [], ...(row ? { row } : {}),
    apiUrl: deps.settings.apiUrl(),
  });

  const actorOf = (userId: number | null): string => {
    if (userId === null) return '(nieznany)';
    return deps.users.findById(userId)?.login ?? String(userId);
  };

  /** Ustawienie z wiersza; usunięte z listy ustawień wraca jako „Własne”, żeby formularz zawsze się narysował. */
  const presetOf = (row: IntegrationRow): Preset => {
    const preset = presetById(row.preset);
    return preset && preset.kinds.includes(row.kind) ? preset : presetById('custom')!;
  };

  /** Sekrety już zapisane i odniesienia nagłówków - do przeniesienia sekretu bez wpisywania go ponownie. */
  const existingSecrets = (row?: IntegrationRow): ExistingSecrets => {
    if (!row) return { names: [], headerRefs: {} };
    const headerRefs: Record<string, string> = {};
    if (row.kind === 'webhook_out') {
      for (const h of (row.config as OutboundConfig).headers) if (h.valueRef !== undefined) headerRefs[h.name] = h.valueRef;
    }
    return { names: deps.integrations.secretNames(row.id), headerRefs };
  };

  /**
   * Adres wychodzącej sprawdzany przy zapisie jak adres webhooka klucza: cel w sieci wewnętrznej bez
   * zgody w środowisku i nazwa bez adresu wracają jako błąd formularza, nie psują się po cichu przy dostawie.
   */
  const targetError = async (config: IntegrationRow['config'], kind: IntegrationKind): Promise<string | null> => {
    if (kind !== 'webhook_out') return null;
    const target = await webhookTarget((config as OutboundConfig).url, deps.resolve ?? systemResolver);
    if (target.kind === 'private' && !deps.allowPrivateWebhooks) return `${PRIVATE_TARGET_MESSAGE} (${target.address}).`;
    if (target.kind === 'unresolved') return `Nazwa z adresu nie rozwiązuje się: ${target.reason}.`;
    return null;
  };

  /** Klucz, usługa i nadpis z formularza: klucz czynny, usługa i nadpis z jego listy albo puste (domyślne klucza). */
  const keyCheck = (v: IntegrationFormValues, fixedKeyId?: number): { ok: true; keyId: number; accountId: number } | { ok: false; error: string } => {
    const keyId = fixedKeyId ?? Number.parseInt(v.apiKeyId, 10);
    const key = deps.apiKeys.get(keyId);
    if (!key || key.revokedAt !== null) return { ok: false, error: 'Wskaż czynny klucz API.' };
    if (v.serviceId !== '' && !key.allowedServiceIds.includes(v.serviceId)) {
      return { ok: false, error: `Klucz ${key.name} nie ma dostępu do ID usługi ${v.serviceId}.` };
    }
    if (v.orig !== '' && !key.allowedOrigs.includes(v.orig)) return { ok: false, error: `Klucz ${key.name} nie ma nadpisu ${v.orig}.` };
    return { ok: true, keyId: key.id, accountId: key.accountId };
  };

  const countryCodeOf = (accountId: number): string => deps.accounts.get(accountId)?.defaultCountryCode ?? '48';

  /** Podgląd „Sprawdź szablon” z próbki; błąd JSON-a próbki to błąd formularza, nie podglądu. */
  const preview = (kind: IntegrationKind, config: IntegrationRow['config'], v: IntegrationFormValues, secretNames: string[], countryCode: string):
    { ok: true; preview: FormPreview } | { ok: false; error: string } => {
    let sample: unknown;
    try {
      sample = JSON.parse(v.sample === '' ? '{}' : v.sample);
    } catch (e) {
      return { ok: false, error: `Próbka nie jest poprawnym JSON-em: ${e instanceof Error ? e.message : String(e)}` };
    }
    const at = now();
    if (kind === 'webhook_in') {
      const p = previewInbound(deps.engine, config as InboundConfig, sample, countryCode, at);
      return { ok: true, preview: { matches: p.matches, recipients: p.recipients, text: p.text, parts: p.parts, error: p.error, threadRecipient: p.threadRecipient } };
    }
    const out = config as OutboundConfig;
    const event = typeof sample === 'object' && sample !== null ? sample as Record<string, unknown> : {};
    const rendered = previewOutbound(deps.engine, out, secretNames, event, at);
    let ok = false;
    try {
      ok = matches(out.condition, buildOutboundContext(out.events[0] ?? 'message.received', event, { name: 'podgląd' }, at), deps.engine);
    } catch (e) {
      return { ok: true, preview: { matches: false, error: e instanceof Error ? e.message : String(e) } };
    }
    return { ok: true, preview: { matches: ok, headers: rendered.headers, body: rendered.body, error: rendered.error } };
  };

  /** Wspólna droga POST tworzenia i edycji: walidacja, ewentualny podgląd, potem zapis przez `save`. */
  const handleForm = async (
    request: FastifyRequest, reply: FastifyReply, kind: IntegrationKind, preset: Preset, row: IntegrationRow | undefined,
    save: (saved: SavedForm) => Promise<string> | string,
  ) => {
    reply.type('text/html; charset=utf-8');
    const body = (request.body ?? {}) as Body;
    const v = formValues(body);
    const ctx = formContext(kind, preset, row);
    const title = row ? row.name : 'Nowa integracja';
    const fail = (error: string, code = 400) => {
      reply.code(code);
      return render.page(request, { title, active: 'integracje', body: integrationFormPage(ctx, v, { error }) });
    };

    const key = keyCheck(v, row?.apiKeyId);
    if (!key.ok) return fail(key.error);
    const existing = existingSecrets(row);
    const built = formToConfig(kind, v, deps.engine, existing);
    if (!built.ok) return fail(built.error);
    const target = await targetError(built.config, kind);
    if (target !== null) return fail(target);

    if (String(body.action ?? '') === 'sprawdz') {
      const secretNames = [...new Set([...existing.names, ...Object.keys(built.secrets), ...Object.keys(built.carried)])];
      const result = preview(kind, built.config, v, secretNames, countryCodeOf(key.accountId));
      if (!result.ok) return fail(result.error);
      return render.page(request, { title, active: 'integracje', body: integrationFormPage(ctx, v, { preview: result.preview }) });
    }

    // Sekrety przenoszone: wartości z bazy pod nowymi odniesieniami; stare, nieużyte, znikają.
    const old = row ? deps.integrations.secrets(row.id) : {};
    const secrets: Record<string, string> = { ...built.secrets };
    for (const [ref, oldRef] of Object.entries(built.carried)) if (old[oldRef] !== undefined) secrets[ref] = old[oldRef];
    const secretsChanged = Object.keys(built.secrets).length > 0 || existing.names.some((n) => !Object.values(built.carried).includes(n));
    try {
      return await save({ config: built.config, secrets, secretsChanged, keyId: key.keyId, accountId: key.accountId, v });
    } catch (e) {
      // Nazwa jest unikalna w obrębie klucza - to jedyny błąd bazy, który jest błędem użytkownika.
      if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return fail(`Integracja o tej nazwie już istnieje przy tym kluczu: ${v.name}.`);
      throw e;
    }
  };

  /** Pola konfiguracji, które zmieniły się między dwiema wersjami - do dziennika audytu, bez wartości. */
  const changedFields = (before: IntegrationRow, after: IntegrationRow): string[] => {
    const out: string[] = [];
    const scalar: Array<keyof IntegrationRow> = ['name', 'serviceId', 'orig', 'enabled', 'storePayloads'];
    for (const k of scalar) if (before[k] !== after[k]) out.push(k);
    const a = before.config as Record<string, unknown>;
    const b = after.config as Record<string, unknown>;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
    return out;
  };

  const rowOr404 = (raw: string, reply: FastifyReply): IntegrationRow | null => {
    const row = deps.integrations.get(Number(raw));
    if (!row) {
      reply.callNotFound();
      return null;
    }
    return row;
  };

  app.get<{ Querystring: { rodzaj?: string; klucz?: string } }>('/integracje', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const kind = request.query.rodzaj === 'in' || request.query.rodzaj === 'out' ? request.query.rodzaj : null;
    const keyId = Number.parseInt(request.query.klucz ?? '', 10) || null;
    return listBody(request, { kind, keyId });
  });

  app.get<{ Querystring: { rodzaj?: string; ustawienie?: string } }>('/integracje/nowa', async (request, reply) => {
    const { rodzaj, ustawienie } = request.query;
    // Typ odpowiedzi dopiero po sprawdzeniu - domyślna odpowiedź 404 jest JSON-em, nie stroną.
    if (rodzaj === undefined) {
      reply.type('text/html; charset=utf-8');
      return render.page(request, { title: 'Nowa integracja', active: 'integracje', body: chooseKindPage() });
    }
    if (!isKind(rodzaj)) return reply.callNotFound();
    if (ustawienie === undefined) {
      reply.type('text/html; charset=utf-8');
      return render.page(request, { title: 'Nowa integracja', active: 'integracje', body: choosePresetPage(rodzaj, presetsFor(rodzaj)) });
    }
    const preset = presetById(ustawienie);
    if (!preset || !preset.kinds.includes(rodzaj)) return reply.callNotFound();
    reply.type('text/html; charset=utf-8');
    return render.page(request, {
      title: 'Nowa integracja', active: 'integracje',
      body: integrationFormPage(formContext(rodzaj, preset), valuesFromPreset(rodzaj, preset)),
    });
  });

  app.post<{ Body: Body }>('/integracje', async (request, reply) => {
    const body = request.body ?? {};
    const kind = String(body.kind ?? '');
    const preset = presetById(String(body.preset ?? ''));
    if (!isKind(kind) || !preset || !preset.kinds.includes(kind)) return reply.callNotFound();

    return handleForm(request, reply, kind, preset, undefined, ({ config, secrets, keyId, accountId, v }) => {
      const id = deps.integrations.insert({
        name: v.name, kind, apiKeyId: keyId, serviceId: v.serviceId || null, orig: v.orig || null, preset: preset.id,
        enabled: v.enabled ? 1 : 0, config, secrets, storePayloads: v.storePayloads ? 1 : 0, createdAt: now(),
      });
      // Wychodząca na message.received zapala odbiór usługi - odbiornik uzgadnia pętle od razu.
      deps.receiver?.refresh({ retryAccount: accountId });
      deps.audit.record({
        actor: actorOf(request.adminUserId), action: 'integracja.utworzenie', target: `integracja:${id}`,
        meta: { nazwa: v.name, rodzaj: kind, ustawienie: preset.id, klucz: keyId, wlaczona: v.enabled, sekrety: Object.keys(secrets) },
        ip: request.ip,
      });
      const row = deps.integrations.get(id)!;
      if (row.hookId !== null) {
        // Adres wejściowy pokazany raz, stroną - nie w adresie przekierowania.
        return listBody(request, { kind: null, keyId: null }, { name: row.name, hookId: row.hookId });
      }
      render.flash(request, 'ok', `Integracja ${v.name} utworzona.`);
      reply.redirect('/integracje', 302);
      return '';
    });
  });

  app.get<{ Params: { id: string } }>('/integracje/:id', async (request, reply) => {
    const row = rowOr404(request.params.id, reply);
    if (!row) return;
    reply.type('text/html; charset=utf-8');
    const since = new Date(now().getTime() - WINDOW_MS);
    const events = deps.integrationEvents.list(row.id, row.config.eventLogLimit).map((e) => ({
      row: e,
      // „Ponów” tylko przy dostawie, która wciąż jest nieudana - ponowiona już czeka w kolejce.
      retryable: e.deliveryId !== null && deps.deliveries.get(e.deliveryId)?.status === 'failed',
    }));
    return render.page(request, {
      title: row.name, active: 'integracje',
      body: integrationDetailPage({ view: viewOf(row, since), events, apiUrl: deps.settings.apiUrl() }),
    });
  });

  app.get<{ Params: { id: string }; Querystring: { probka?: string } }>('/integracje/:id/edytuj', async (request, reply) => {
    const row = rowOr404(request.params.id, reply);
    if (!row) return;
    reply.type('text/html; charset=utf-8');
    // Próbka: wskazany wpis dziennika, a bez niego ostatni przechowany ładunek.
    const fromEvent = request.query.probka === undefined ? undefined : deps.integrationEvents.get(Number(request.query.probka));
    const sample = fromEvent && fromEvent.integrationId === row.id && fromEvent.payload !== null
      ? fromEvent.payload : deps.integrationEvents.latestPayload(row.id);
    return render.page(request, {
      title: row.name, active: 'integracje',
      body: integrationFormPage(formContext(row.kind, presetOf(row), row), valuesOf(row, prettySample(sample))),
    });
  });

  app.post<{ Params: { id: string }; Body: Body }>('/integracje/:id/edytuj', async (request, reply) => {
    const row = rowOr404(request.params.id, reply);
    if (!row) return;
    return handleForm(request, reply, row.kind, presetOf(row), row, ({ config, secrets, secretsChanged, accountId, v }) => {
      // Cały zestaw sekretów od nowa: nieużyte odniesienia kasujemy pustą wartością.
      const patch: Record<string, string> = Object.fromEntries(deps.integrations.secretNames(row.id).map((n) => [n, '']));
      Object.assign(patch, secrets);
      deps.integrations.update(row.id, {
        name: v.name, serviceId: v.serviceId || null, orig: v.orig || null, preset: row.preset, enabled: v.enabled ? 1 : 0,
        config, storePayloads: v.storePayloads ? 1 : 0, secrets: patch,
      }, now());
      deps.receiver?.refresh({ retryAccount: accountId });
      const after = deps.integrations.get(row.id)!;
      const fields = changedFields(row, after);
      if (secretsChanged) fields.push('secrets');
      deps.audit.record({
        actor: actorOf(request.adminUserId), action: 'integracja.edycja', target: `integracja:${row.id}`,
        meta: { nazwa: v.name, pola: [...new Set(fields)] }, ip: request.ip,
      });
      render.flash(request, 'ok', `Integracja ${v.name} zapisana.`);
      reply.redirect(`/integracje/${row.id}`, 302);
      return '';
    });
  });

  app.post<{ Params: { id: string } }>('/integracje/:id/nowy-adres', async (request, reply) => {
    const row = rowOr404(request.params.id, reply);
    if (!row) return;
    if (row.kind !== 'webhook_in') return reply.callNotFound();
    const hookId = deps.integrations.regenerateHook(row.id, now());
    deps.audit.record({
      actor: actorOf(request.adminUserId), action: 'integracja.nowy_adres', target: `integracja:${row.id}`,
      meta: { nazwa: row.name }, ip: request.ip,
    });
    reply.type('text/html; charset=utf-8');
    // Nowy adres widać raz, na stronie edycji - stary już nie działa.
    const fresh = deps.integrations.get(row.id)!;
    return render.page(request, {
      title: row.name, active: 'integracje',
      body: integrationFormPage(formContext(fresh.kind, presetOf(fresh), fresh), valuesOf(fresh, prettySample(deps.integrationEvents.latestPayload(fresh.id))),
        { created: { name: fresh.name, hookId } satisfies CreatedHook }),
    });
  });

  const setEnabled = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, enabled: boolean) => {
    const row = rowOr404(request.params.id, reply);
    if (!row) return;
    deps.integrations.setEnabled(row.id, enabled, now());
    const key = deps.apiKeys.get(row.apiKeyId);
    deps.receiver?.refresh(key ? { retryAccount: key.accountId } : {});
    deps.audit.record({
      actor: actorOf(request.adminUserId), action: enabled ? 'integracja.wlaczenie' : 'integracja.wylaczenie',
      target: `integracja:${row.id}`, meta: { nazwa: row.name }, ip: request.ip,
    });
    render.flash(request, 'ok', `Integracja ${row.name} ${enabled ? 'włączona' : 'wyłączona'}.`);
    return reply.redirect(`/integracje/${row.id}`, 302);
  };
  app.post<{ Params: { id: string } }>('/integracje/:id/wlacz', async (request, reply) => setEnabled(request, reply, true));
  app.post<{ Params: { id: string } }>('/integracje/:id/wylacz', async (request, reply) => setEnabled(request, reply, false));

  app.post<{ Params: { id: string } }>('/integracje/:id/usun', async (request, reply) => {
    const row = rowOr404(request.params.id, reply);
    if (!row) return;
    const key = deps.apiKeys.get(row.apiKeyId);
    // Dziennik i strażnicy znikają kaskadą; wiadomości i odebrane tracą tylko odniesienie.
    deps.integrations.remove(row.id);
    deps.receiver?.refresh(key ? { retryAccount: key.accountId } : {});
    deps.audit.record({
      actor: actorOf(request.adminUserId), action: 'integracja.usuniecie', target: `integracja:${row.id}`,
      meta: { nazwa: row.name, rodzaj: row.kind, ustawienie: row.preset }, ip: request.ip,
    });
    render.flash(request, 'ok', `Integracja ${row.name} usunięta.`);
    return reply.redirect('/integracje', 302);
  });
}

/** Przechowany ładunek to zwarty JSON; w polu próbki czytelniej z wcięciami. */
function prettySample(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
