import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { M365Service, PanelUser } from '../../m365/service.ts';
import type { M365AccountsRepo } from '../../store/m365-accounts.ts';
import type { Renderer } from '../render.ts';
import { SESSION_COOKIE } from '../session.ts';
import type { AdminDeps } from '../server.ts';
import { clientErrorPage } from '../views/error.ts';
import { m365DetailPage, m365FormPage, m365ListPage, m365ReturnPage, type M365FormValues } from '../views/m365.ts';

/** Ścieżka powrotu z Microsoftu, wpisywana w rejestracji aplikacji. Dostępna bez sesji panelu. */
export const M365_RETURN_PATH = '/m365/powrot';

/** Parametry, które strona pośrednia przenosi do dokończenia logowania. Inne giną. */
const RETURN_PARAMS = ['code', 'state', 'error', 'error_description'] as const;
type ReturnQuery = Partial<Record<typeof RETURN_PARAMS[number], string>>;

/** Nazwa hosta albo adres IPv6 w nawiasach, z opcjonalnym portem. Nic, co zmieniłoby ścieżkę adresu. */
const HOST = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/**
 * Adres przekierowania z adresu, pod którym otwarto panel (spec 5.2): schemat https przy TLS albo
 * nagłówku `X-Forwarded-Proto: https`, w przeciwnym razie http (pętla zwrotna, tunel SSH).
 * `null`, gdy nagłówek Host nie jest poprawną nazwą hosta.
 */
export function redirectUriOf(request: FastifyRequest): string | null {
  const host = (request.headers.host ?? '').toLowerCase();
  if (!HOST.test(host)) return null;
  const https = request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
  return `${https ? 'https' : 'http'}://${host}${M365_RETURN_PATH}`;
}

/** Wyłącznie znane parametry i wyłącznie pojedyncze napisy; powtórzony parametr przychodzi jako tablica i odpada. */
function pickReturn(query: unknown): ReturnQuery {
  const q = (query ?? {}) as Record<string, unknown>;
  const out: ReturnQuery = {};
  for (const key of RETURN_PARAMS) {
    const v = q[key];
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

const idOf = (raw: string): number | null => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

const valuesOf = (body: Record<string, unknown> | undefined): M365FormValues => ({
  name: typeof body?.name === 'string' ? body.name : '',
  tenant: typeof body?.tenant === 'string' ? body.tenant : '',
  clientId: typeof body?.clientId === 'string' ? body.clientId : '',
});

type Body = Record<string, string | undefined>;

export function registerM365Routes(
  app: FastifyInstance,
  deps: AdminDeps & { m365: M365Service; m365Accounts: M365AccountsRepo },
  render: Renderer,
): void {
  const now = deps.now ?? (() => new Date());
  const service = deps.m365;

  const userOf = (request: FastifyRequest): PanelUser => {
    const id = request.adminUserId!;
    const token = request.cookies[SESSION_COOKIE] ?? '';
    const session = createHash('sha256').update(token).digest('base64url');
    return { id, login: deps.users.findById(id)?.login ?? String(id), session };
  };

  const viewOf = (id: number) => {
    const row = deps.m365Accounts.get(id);
    return row ? { row, users: service.users(id) } : null;
  };

  const html = (reply: FastifyReply) => reply.type('text/html; charset=utf-8');

  /** Logowanie w Microsoft: nowe logowanie w toku i przekierowanie 303 na stronę Microsoftu. */
  const startLogin = (request: FastifyRequest, reply: FastifyReply, id: number) => {
    const redirectUri = redirectUriOf(request);
    if (redirectUri === null) return html(reply).code(400).send(clientErrorPage(400));
    const { url } = service.startLogin(id, redirectUri, userOf(request), now());
    return reply.redirect(url, 303);
  };

  const formPage = (request: FastifyRequest, opts: Parameters<typeof m365FormPage>[0]) => render.page(request, {
    title: opts.mode === 'new' ? 'Nowe konto Microsoft 365' : `Edycja konta ${opts.values.name}`,
    active: 'microsoft-365',
    body: m365FormPage(opts),
  });

  app.get('/microsoft-365', async (request, reply) => {
    const views = deps.m365Accounts.list().map((row) => ({ row, users: service.users(row.id) }));
    return html(reply).send(render.page(request, { title: 'Konta Microsoft 365', active: 'microsoft-365', body: m365ListPage(views) }));
  });

  app.get('/microsoft-365/nowe', async (request, reply) => html(reply).send(formPage(request, {
    mode: 'new', values: { name: '', tenant: '', clientId: '' }, redirectUri: redirectUriOf(request),
  })));

  app.post<{ Body: Body }>('/microsoft-365', async (request, reply) => {
    const values = valuesOf(request.body);
    const login = request.body?.action === 'zaloguj';
    if (login && redirectUriOf(request) === null) return html(reply).code(400).send(clientErrorPage(400));
    const r = service.create(values, userOf(request), now());
    if (!r.ok) {
      return html(reply).code(400).send(formPage(request, { mode: 'new', values, redirectUri: redirectUriOf(request), error: r.error }));
    }
    if (login) return startLogin(request, reply, r.id);
    render.flash(request, 'ok', 'Konto zapisane. Połączenie z Microsoft 365 wymaga logowania przyciskiem „Zaloguj w Microsoft”.');
    return reply.redirect(`/microsoft-365/${r.id}`, 303);
  });

  app.get<{ Params: { id: string } }>('/microsoft-365/:id', async (request, reply) => {
    const id = idOf(request.params.id);
    const view = id === null ? null : viewOf(id);
    if (!view) return reply.callNotFound();
    return html(reply).send(render.page(request, {
      title: view.row.name, active: 'microsoft-365', body: m365DetailPage(view, { redirectUri: redirectUriOf(request) }),
    }));
  });

  app.get<{ Params: { id: string } }>('/microsoft-365/:id/edycja', async (request, reply) => {
    const id = idOf(request.params.id);
    const row = id === null ? undefined : deps.m365Accounts.get(id);
    if (!row) return reply.callNotFound();
    return html(reply).send(formPage(request, {
      mode: 'edit', id: row.id, values: { name: row.name, tenant: row.tenant, clientId: row.clientId }, redirectUri: redirectUriOf(request),
    }));
  });

  app.post<{ Params: { id: string }; Body: Body }>('/microsoft-365/:id', async (request, reply) => {
    const id = idOf(request.params.id);
    if (id === null || !deps.m365Accounts.get(id)) return reply.callNotFound();
    const values = valuesOf(request.body);
    const login = request.body?.action === 'zaloguj';
    if (login && redirectUriOf(request) === null) return html(reply).code(400).send(clientErrorPage(400));
    const r = service.update(id, values, userOf(request), now());
    if (!r.ok) {
      return html(reply).code(400).send(formPage(request, { mode: 'edit', id, values, redirectUri: redirectUriOf(request), error: r.error }));
    }
    if (login) return startLogin(request, reply, id);
    render.flash(request, 'ok', 'Zmiany zapisane');
    return reply.redirect(`/microsoft-365/${id}`, 303);
  });

  app.post<{ Params: { id: string } }>('/microsoft-365/:id/zaloguj', async (request, reply) => {
    const id = idOf(request.params.id);
    if (id === null || !deps.m365Accounts.get(id)) return reply.callNotFound();
    return startLogin(request, reply, id);
  });

  app.post<{ Params: { id: string }; Body: Body }>('/microsoft-365/:id/adres', async (request, reply) => {
    const id = idOf(request.params.id);
    if (id === null || !deps.m365Accounts.get(id)) return reply.callNotFound();
    const r = service.setAddress(id, request.body?.address ?? '', userOf(request), now());
    if (r.ok) render.flash(request, 'ok', 'Adres skrzynki zapisany');
    else render.flash(request, 'fail', r.error);
    return reply.redirect(`/microsoft-365/${id}`, 303);
  });

  app.post<{ Params: { id: string } }>('/microsoft-365/:id/rozlacz', async (request, reply) => {
    const id = idOf(request.params.id);
    if (id === null || !deps.m365Accounts.get(id)) return reply.callNotFound();
    service.disconnect(id, userOf(request), now());
    render.flash(request, 'ok',
      'Konto rozłączone, a token usunięty z bramki. Zgodę aplikacji po stronie Microsoftu cofa się w centrum administracyjnym Microsoft Entra.');
    return reply.redirect(`/microsoft-365/${id}`, 303);
  });

  app.post<{ Params: { id: string } }>('/microsoft-365/:id/usun', async (request, reply) => {
    const id = idOf(request.params.id);
    if (id === null || !deps.m365Accounts.get(id)) return reply.callNotFound();
    const r = service.remove(id, userOf(request), now());
    if (r.ok) {
      render.flash(request, 'ok', 'Konto Microsoft 365 usunięte');
      return reply.redirect('/microsoft-365', 303);
    }
    const names = r.users.map((u) => (u.kind === 'integration' ? `integracja ${u.name}` : 'wysyłka maili powiadomień'));
    render.flash(request, 'fail', `${r.error}: ${names.join(', ')}.`);
    return reply.redirect(`/microsoft-365/${id}`, 303);
  });

  // Bez sesji: Microsoft przekierowuje tu przeglądarkę, a ciasteczko SameSite=Strict nie przychodzi.
  // Strona przenosi wyłącznie parametry logowania do /m365/dokoncz, już w obrębie panelu.
  app.get(M365_RETURN_PATH, async (request, reply) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(pickReturn(request.query))) params.set(k, v);
    const target = `/m365/dokoncz?${params.toString()}`;
    return html(reply)
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .send(m365ReturnPage(target));
  });

  app.get('/m365/dokoncz', async (request, reply) => {
    const r = await service.finishLogin(pickReturn(request.query), userOf(request), now());
    if (!r.ok) {
      render.flash(request, 'fail', r.error);
      return reply.redirect(r.accountId === null ? '/microsoft-365' : `/microsoft-365/${r.accountId}`, 303);
    }
    if (r.switched) {
      render.flash(request, 'warn',
        `Zalogowano kontem ${r.login ?? r.address}, innym niż poprzednio, dlatego adres skrzynki zmieniono na ${r.address}`);
    } else {
      render.flash(request, 'ok', `Połączono jako ${r.address}`);
    }
    return reply.redirect(`/microsoft-365/${r.accountId}`, 303);
  });
}
