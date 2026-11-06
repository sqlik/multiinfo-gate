import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { LinkDomainError, LinkDomainService } from '../../links/domains.ts';
import type { PanelUser } from '../../m365/service.ts';
import type { LinkDomainInput } from '../../store/link-domains.ts';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { linkDomainFormPage, linkDomainListPage, type LinkDomainFormValues } from '../views/links.ts';

const idOf = (raw: string): number | null => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

type Body = Record<string, string | undefined>;

const valuesOf = (body: Body | undefined): LinkDomainFormValues => ({
  domain: typeof body?.domain === 'string' ? body.domain : '',
  displayName: typeof body?.displayName === 'string' ? body.displayName : '',
  homeUrl: typeof body?.homeUrl === 'string' ? body.homeUrl : '',
  bareLinks: body?.bareLinks === '1',
});

const inputOf = (v: LinkDomainFormValues): LinkDomainInput => ({
  domain: v.domain, displayName: v.displayName, homeUrl: v.homeUrl, bareLinks: v.bareLinks,
});

/** Element „Skracacz linków”: domeny skracacza z formularzem i sprawdzeniem domeny (spec 4). */
export function registerLinkRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  const now = deps.now ?? (() => new Date());
  const service = new LinkDomainService({
    linkDomains: deps.linkDomains, shortLinks: deps.shortLinks, audit: deps.audit, checks: deps.domainChecks,
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
    ...(deps.domainFetch ? { fetch: deps.domainFetch } : {}),
    ...(deps.allowPrivateLinks ? { allowPrivate: true } : {}),
  });

  const userOf = (request: FastifyRequest): PanelUser => {
    const id = request.adminUserId!;
    return { id, login: deps.users.findById(id)?.login ?? String(id) };
  };

  const html = (reply: FastifyReply) => reply.type('text/html; charset=utf-8');

  const domainOf = (raw: string) => {
    const id = idOf(raw);
    return id === null ? undefined : deps.linkDomains.get(id);
  };

  const formPage = (request: FastifyRequest, opts: Parameters<typeof linkDomainFormPage>[0]) => render.page(request, {
    title: opts.row ? opts.row.domain : 'Nowa domena skracacza',
    active: 'skracacz',
    body: linkDomainFormPage(opts),
  });

  /** Akcja na domenie: błąd usługi trafia do komunikatu na stronie domeny. */
  const act = (request: FastifyRequest, reply: FastifyReply, id: number, fn: () => string, back = `/skracacz/${id}`) => {
    try {
      render.flash(request, 'ok', fn());
      return reply.redirect(back, 303);
    } catch (error) {
      if (!(error instanceof LinkDomainError)) throw error;
      render.flash(request, 'fail', error.message);
      return reply.redirect(`/skracacz/${id}`, 303);
    }
  };

  app.get('/skracacz', async (request, reply) => {
    const views = deps.linkDomains.list().map((row) => ({ row, keys: deps.linkDomains.keysUsing(row.id).length }));
    return html(reply).send(render.page(request, { title: 'Skracacz linków', active: 'skracacz', body: linkDomainListPage(views, deps.linksServer?.problem() ?? null) }));
  });

  app.get('/skracacz/nowa', async (request, reply) => html(reply).send(formPage(request, {
    values: { domain: '', displayName: '', homeUrl: '', bareLinks: false },
  })));

  app.post<{ Body: Body }>('/skracacz', async (request, reply) => {
    const values = valuesOf(request.body);
    try {
      const id = service.create(inputOf(values), userOf(request), now());
      render.flash(request, 'ok', 'Domena zapisana. Sprawdzenie domeny potwierdza, że linki tej domeny trafiają do bramki');
      return reply.redirect(`/skracacz/${id}`, 303);
    } catch (error) {
      if (!(error instanceof LinkDomainError)) throw error;
      return html(reply).code(400).send(formPage(request, { values, error: error.message }));
    }
  });

  app.get<{ Params: { id: string } }>('/skracacz/:id', async (request, reply) => {
    const row = domainOf(request.params.id);
    if (!row) return reply.callNotFound();
    return html(reply).send(formPage(request, {
      row, keys: deps.linkDomains.keysUsing(row.id),
      values: { domain: row.domain, displayName: row.displayName, homeUrl: row.homeUrl ?? '', bareLinks: row.bareLinks === 1 },
    }));
  });

  app.post<{ Params: { id: string }; Body: Body }>('/skracacz/:id', async (request, reply) => {
    const row = domainOf(request.params.id);
    if (!row) return reply.callNotFound();
    const values = valuesOf(request.body);
    try {
      service.update(row.id, inputOf(values), userOf(request), now());
      render.flash(request, 'ok', 'Zmiany zapisane');
      return reply.redirect(`/skracacz/${row.id}`, 303);
    } catch (error) {
      if (!(error instanceof LinkDomainError)) throw error;
      return html(reply).code(400).send(formPage(request, { row, keys: deps.linkDomains.keysUsing(row.id), values, error: error.message }));
    }
  });

  app.post<{ Params: { id: string }; Body: Body }>('/skracacz/:id/sprawdz', async (request, reply) => {
    const row = domainOf(request.params.id);
    if (!row) return reply.callNotFound();
    const result = await service.check(row.id, userOf(request), now());
    if (result.ok && result.untrustedProxy !== undefined) {
      render.flash(request, 'warn', `Domena odpowiada, ale bramka nie ufa serwerowi pośredniczącemu ${result.untrustedProxy}. Szczegóły zawiera strona domeny`);
    } else if (result.ok) render.flash(request, 'ok', `Domena odpowiada: linki domeny ${row.domain} trafiają do tej bramki`);
    else render.flash(request, 'fail', `Sprawdzenie domeny ${row.domain} nie powiodło się. Szczegóły zawiera strona domeny`);
    return reply.redirect(request.body?.back === 'lista' ? '/skracacz' : `/skracacz/${row.id}`, 303);
  });

  app.post<{ Params: { id: string } }>('/skracacz/:id/wylacz', async (request, reply) => {
    const row = domainOf(request.params.id);
    if (!row) return reply.callNotFound();
    return act(request, reply, row.id, () => {
      service.setEnabled(row.id, false, userOf(request), now());
      return 'Domena wyłączona. Linki tej domeny prowadzą do strony „Link wygasł”';
    });
  });

  app.post<{ Params: { id: string } }>('/skracacz/:id/wlacz', async (request, reply) => {
    const row = domainOf(request.params.id);
    if (!row) return reply.callNotFound();
    return act(request, reply, row.id, () => {
      service.setEnabled(row.id, true, userOf(request), now());
      return 'Domena włączona. Linki tej domeny ponownie przekierowują do adresów docelowych';
    });
  });

  app.post<{ Params: { id: string } }>('/skracacz/:id/usun', async (request, reply) => {
    const row = domainOf(request.params.id);
    if (!row) return reply.callNotFound();
    return act(request, reply, row.id, () => {
      service.remove(row.id, userOf(request), now());
      return 'Domena usunięta';
    }, '/skracacz');
  });
}
