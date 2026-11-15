import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CODE_VALIDITY, CONNECTION_VALIDITY, connectionState, effectiveExpiry, type ConnectionState } from '../../agents/connections.ts';
import { gatewayBase } from '../../oauth/metadata.ts';
import type { AgentConnectionRow, ConnectionMethod } from '../../store/agent-connections.ts';
import { isAgent, type IntegrationRow } from '../../store/integrations.ts';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import {
  connectionErrorPage, connectionSecretPage, mcpUrlOf, newCodePage, newConnectionPage, NEW_CONNECTION_DEFAULTS,
  type CodeValidity, type ConnectionListItem, type ConnectionValidity, type NewConnectionValues,
} from '../views/agent-connections.ts';

const NAME_MAX = 80;
const METHOD_WORDS: Record<ConnectionMethod, string> = { oauth: 'aplikacja z logowaniem', token: 'aplikacja z kluczem w nagłówku' };

type Body = Record<string, string | undefined> | undefined;

const isCodeValidity = (raw: string | undefined): raw is CodeValidity => raw !== undefined && Object.hasOwn(CODE_VALIDITY, raw);
const isValidity = (raw: string | undefined): raw is ConnectionValidity => raw !== undefined && Object.hasOwn(CONNECTION_VALIDITY, raw);
const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase('pl-PL') === b.trim().toLocaleLowerCase('pl-PL');

/** Połączenia integracji agenta ze stanem i końcem ważności liczonym razem z kluczem, do sekcji „Połączenia”. */
export function connectionItems(deps: Pick<AdminDeps, 'agentConnections' | 'apiKeys'>, integration: IntegrationRow, now: Date): ConnectionListItem[] {
  const keyExpiresAt = deps.apiKeys.get(integration.apiKeyId)?.expiresAt ?? null;
  return deps.agentConnections.listForIntegration(integration.id).map((row) => ({
    row, state: connectionState(row, keyExpiresAt, now), effectiveExpiry: effectiveExpiry(row, keyExpiresAt),
  }));
}

/**
 * Połączenia pracowników z integracją „Agent AI”: dodanie z kodem albo tokenem, nowy kod, nowy token, odwołanie
 * i usunięcie nieużywanego połączenia. Sekret pokazuje wyłącznie odpowiedź na POST, bez przekierowania.
 */
export function registerAgentConnectionRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  const now = deps.now ?? (() => new Date());
  const actorOf = (request: FastifyRequest): string => {
    const id = request.adminUserId;
    if (id === null) return '(nieznany)';
    return deps.users.findById(id)?.login ?? String(id);
  };
  const keyExpiry = (integration: IntegrationRow) => deps.apiKeys.get(integration.apiKeyId)?.expiresAt ?? null;
  const target = (integration: IntegrationRow, connection: { name: string }) => `${integration.name} / ${connection.name}`;
  const page = (request: FastifyRequest, reply: FastifyReply, title: string, body: string) => {
    reply.type('text/html; charset=utf-8');
    return render.page(request, { title, active: 'integracje', body });
  };

  /** Integracja agenta z adresu; inna integracja albo brak dają 404. */
  const agentOr404 = (raw: string, reply: FastifyReply): IntegrationRow | null => {
    const row = deps.integrations.get(Number(raw));
    if (!row || !isAgent(row)) {
      reply.callNotFound();
      return null;
    }
    return row;
  };
  /** Połączenie tej integracji; połączenie innej integracji pod tym adresem daje 404. */
  const connectionOr404 = (integration: IntegrationRow, raw: string, reply: FastifyReply): AgentConnectionRow | null => {
    const connection = deps.agentConnections.get(Number(raw));
    if (!connection || connection.integrationId !== integration.id) {
      reply.callNotFound();
      return null;
    }
    return connection;
  };
  const conflict = (request: FastifyRequest, reply: FastifyReply, integration: IntegrationRow, error: unknown) => {
    reply.code(409);
    return page(request, reply, integration.name, connectionErrorPage(integration, error instanceof Error ? error.message : String(error)));
  };
  const secretPage = (request: FastifyRequest, reply: FastifyReply, integration: IntegrationRow, id: number, secret: string, secretExpiresAt: string | null) => {
    const connection = deps.agentConnections.get(id)!;
    const apiUrl = deps.settings.apiUrl();
    return page(request, reply, connection.name, connectionSecretPage({
      integration, connection, secret, secretExpiresAt, effectiveExpiry: effectiveExpiry(connection, keyExpiry(integration)),
      mcpUrl: mcpUrlOf(gatewayBase(apiUrl)), apiUrl,
    }));
  };

  const formPage = (request: FastifyRequest, reply: FastifyReply, integration: IntegrationRow, values: NewConnectionValues, error?: string) =>
    page(request, reply, 'Dodaj połączenie', newConnectionPage({ integration, values, keyExpiresAt: keyExpiry(integration), ...(error ? { error } : {}) }));

  app.get<{ Params: { id: string } }>('/integracje/:id/polaczenia/nowe', async (request, reply) => {
    const integration = agentOr404(request.params.id, reply);
    if (!integration) return;
    return formPage(request, reply, integration, NEW_CONNECTION_DEFAULTS);
  });

  // Odświeżenie strony z sekretem metodą GET nie pokazuje go ponownie.
  app.get<{ Params: { id: string } }>('/integracje/:id/polaczenia', async (request, reply) => {
    const integration = agentOr404(request.params.id, reply);
    if (!integration) return;
    return reply.redirect(`/integracje/${integration.id}#polaczenia`, 302);
  });

  app.post<{ Params: { id: string }; Body: Body }>('/integracje/:id/polaczenia', async (request, reply) => {
    const integration = agentOr404(request.params.id, reply);
    if (!integration) return;
    const body = request.body ?? {};
    const name = (body.name ?? '').trim();
    const values: NewConnectionValues = {
      name,
      method: body.method === 'token' ? 'token' : 'oauth',
      codeValidity: isCodeValidity(body.codeValidity) ? body.codeValidity : NEW_CONNECTION_DEFAULTS.codeValidity,
      validity: isValidity(body.validity) ? body.validity : NEW_CONNECTION_DEFAULTS.validity,
    };
    const at = now();
    const keyExpiresAt = keyExpiry(integration);
    // Nazwa odwołanego albo wygasłego połączenia wraca do użytku: takie połączenie zastępuje się nowym.
    const taken = deps.agentConnections.listForIntegration(integration.id)
      .some((c) => sameName(c.name, name) && !(['revoked', 'expired'] as ConnectionState[]).includes(connectionState(c, keyExpiresAt, at)));
    const error = name === '' ? 'Podaj nazwę połączenia, na przykład imię i nazwisko pracownika.'
      : name.length > NAME_MAX ? `Nazwa połączenia może mieć najwyżej ${NAME_MAX} znaków.`
        : body.method !== 'oauth' && body.method !== 'token' ? 'Wybierz sposób połączenia.'
          : !isCodeValidity(body.codeValidity) ? 'Wybierz ważność kodu z listy.'
            : !isValidity(body.validity) ? 'Wybierz ważność połączenia z listy.'
              : taken ? 'Integracja zawiera już połączenie o tej nazwie. Podaj inną nazwę albo odwołaj dotychczasowe połączenie.'
                : null;
    if (error !== null) {
      reply.code(400);
      return formPage(request, reply, integration, values, error);
    }

    const created = deps.connectionService.create(integration.id, values, actorOf(request), at);
    deps.audit.record({
      actor: actorOf(request), action: 'agent.polaczenie_utworzenie', target: target(integration, values),
      meta: {
        sposob: METHOD_WORDS[values.method], waznosc: values.validity,
        ...(values.method === 'oauth' ? { waznosc_kodu: values.codeValidity } : {}),
      },
      ip: request.ip,
    });
    return secretPage(request, reply, integration, created.id, created.secret, created.secretExpiresAt);
  });

  app.get<{ Params: { id: string; cid: string } }>('/integracje/:id/polaczenia/:cid/kod', async (request, reply) => {
    const integration = agentOr404(request.params.id, reply);
    if (!integration) return;
    const connection = connectionOr404(integration, request.params.cid, reply);
    if (!connection) return;
    const state = connectionState(connection, keyExpiry(integration), now());
    if (connection.method !== 'oauth' || state === 'revoked' || state === 'expired') return reply.redirect(`/integracje/${integration.id}#polaczenia`, 302);
    return page(request, reply, connection.name, newCodePage({ integration, connection, state }));
  });

  app.post<{ Params: { id: string; cid: string }; Body: Body }>('/integracje/:id/polaczenia/:cid/kod', async (request, reply) => {
    const integration = agentOr404(request.params.id, reply);
    if (!integration) return;
    const connection = connectionOr404(integration, request.params.cid, reply);
    if (!connection) return;
    const validity = request.body?.codeValidity;
    if (!isCodeValidity(validity)) {
      reply.code(400);
      return page(request, reply, connection.name, newCodePage({ integration, connection, state: connectionState(connection, keyExpiry(integration), now()) }));
    }
    let code: { code: string; expiresAt: string };
    try {
      if (connectionState(connection, keyExpiry(integration), now()) === 'expired') {
        throw new Error('Ważność połączenia minęła, dlatego nowy kod nie przywróci dostępu. Dodaj nowe połączenie.');
      }
      code = deps.connectionService.newCode(connection.id, validity, now());
    } catch (e) {
      return conflict(request, reply, integration, e);
    }
    deps.audit.record({ actor: actorOf(request), action: 'agent.nowy_kod', target: target(integration, connection), meta: { waznosc_kodu: validity }, ip: request.ip });
    return secretPage(request, reply, integration, connection.id, code.code, code.expiresAt);
  });

  app.post<{ Params: { id: string; cid: string } }>('/integracje/:id/polaczenia/:cid/token', async (request, reply) => {
    const integration = agentOr404(request.params.id, reply);
    if (!integration) return;
    const connection = connectionOr404(integration, request.params.cid, reply);
    if (!connection) return;
    let token: string;
    try {
      if (connectionState(connection, keyExpiry(integration), now()) === 'expired') {
        throw new Error('Ważność połączenia minęła, dlatego nowy token nie przywróci dostępu. Dodaj nowe połączenie.');
      }
      token = deps.connectionService.newToken(connection.id).token;
    } catch (e) {
      return conflict(request, reply, integration, e);
    }
    deps.audit.record({ actor: actorOf(request), action: 'agent.nowy_token', target: target(integration, connection), ip: request.ip });
    return secretPage(request, reply, integration, connection.id, token, null);
  });

  app.post<{ Params: { id: string; cid: string } }>('/integracje/:id/polaczenia/:cid/odwolaj', async (request, reply) => {
    const integration = agentOr404(request.params.id, reply);
    if (!integration) return;
    const connection = connectionOr404(integration, request.params.cid, reply);
    if (!connection) return;
    if (connection.revokedAt === null) {
      deps.connectionService.revoke(connection.id, now());
      deps.audit.record({
        actor: actorOf(request), action: 'agent.odwolanie', target: target(integration, connection),
        meta: { powod: 'odwołanie w panelu', aplikacja: connection.clientName ?? (connection.method === 'token' ? 'klucz w nagłówku' : '-') }, ip: request.ip,
      });
      render.flash(request, 'ok', `Połączenie ${connection.name} odwołane. Aplikacja utraciła dostęp do bramki.`);
    }
    return reply.redirect(`/integracje/${integration.id}#polaczenia`, 302);
  });

  app.post<{ Params: { id: string; cid: string } }>('/integracje/:id/polaczenia/:cid/usun', async (request, reply) => {
    const integration = agentOr404(request.params.id, reply);
    if (!integration) return;
    const connection = connectionOr404(integration, request.params.cid, reply);
    if (!connection) return;
    try {
      deps.connectionService.remove(connection.id, now());
    } catch (e) {
      return conflict(request, reply, integration, e);
    }
    deps.audit.record({ actor: actorOf(request), action: 'agent.polaczenie_usuniecie', target: target(integration, connection), ip: request.ip });
    render.flash(request, 'ok', `Połączenie ${connection.name} usunięte.`);
    return reply.redirect(`/integracje/${integration.id}#polaczenia`, 302);
  });
}
