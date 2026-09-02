import type { FastifyInstance, FastifyRequest } from 'fastify';
import { INTEGRATION_KINDS, type IntegrationKind } from '../../integrations/config.ts';
import { presetById, presetsFor, type Preset } from '../../integrations/presets/index.ts';
import type { IntegrationRow } from '../../store/integrations.ts';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { WINDOW_MS } from '../window.ts';
import {
  chooseKindPage, choosePresetPage, integrationFormPage, integrationsPage, valuesFromPreset,
  type FormContext, type IntegrationsFilter, type IntegrationView, type KeyOption,
} from '../views/integrations.ts';

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
      body: integrationsPage(rows.map((r) => viewOf(r, since)), filter, keyOptions(), created),
    });
  };

  const formContext = (kind: IntegrationKind, preset: Preset, row?: IntegrationRow): FormContext => ({
    kind, preset, keys: keyOptions(), secretNames: row ? deps.integrations.secretNames(row.id) : [], ...(row ? { row } : {}),
  });

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
}
