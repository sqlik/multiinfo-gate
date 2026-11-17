import type { FastifyInstance } from 'fastify';
import { cancelPackage } from '../../api/cancel-package.ts';
import { ApiError } from '../../api/errors.ts';
import { reportCsv } from '../../api/packages.ts';
import { cancelReason } from '../../worker/packages.ts';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { connectionLink, integrationLink, sourceWords } from '../views/deliveries.ts';
import { PACKAGE_FILTERS, packagePage, packagesPage } from '../views/packages.ts';
import { parseOffset } from '../../paging.ts';
import { CSV_BOM } from '../../text/csv.ts';

const PAGE_SIZE = 25;

/** Odnośnik do kampanii krótkich linków; brak dla wysyłki bez skróconych linków. */
export function campaignLink(deps: Pick<AdminDeps, 'campaigns'>, campaignId: number | null): { id: number; name: string } | null {
  if (campaignId === null) return null;
  const campaign = deps.campaigns.get(campaignId);
  return campaign === undefined ? null : { id: campaign.id, name: campaign.name };
}

/** Plik wysyłki z pliku, z której pochodzi rozsyłka, z liczbą jej rozsyłek; brak dla pozostałych rozsyłek. */
function fileOf(deps: Pick<AdminDeps, 'fileSends' | 'packages'>, fileSendId: string | null): { name: string; packages: number } | null {
  if (fileSendId === null) return null;
  const file = deps.fileSends.get(fileSendId);
  return file === undefined ? null : { name: file.name, packages: deps.packages.listByFileSend(fileSendId).length };
}

/** Tylu odbiorców pokazujemy w szczególe; pełna lista jest w CSV. */
const RECIPIENTS_SHOWN = 200;

export function registerPackageViewRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  const now = deps.now ?? (() => new Date());
  const actorOf = (userId: number | null): string => {
    if (userId === null) return '(nieznany)';
    return deps.users.findById(userId)?.login ?? String(userId);
  };

  app.get<{ Querystring: { offset?: string; stan?: string } }>('/rozsylki', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const offset = parseOffset(request.query.offset);
    // Nieznany stan nie filtruje listy.
    const status = PACKAGE_FILTERS.find((f) => f.key !== null && f.key === request.query.stan)?.key ?? null;
    // Jeden wiersz ponad stronę, żeby wiedzieć, czy jest następna.
    const rows = deps.packages.list({ limit: PAGE_SIZE + 1, offset, ...(status === null ? {} : { statuses: [status] }) });

    return render.page(request, {
      title: 'Rozsyłki',
      active: 'rozsylki',
      body: packagesPage({
        rows: rows.slice(0, PAGE_SIZE),
        status,
        hasMore: rows.length > PAGE_SIZE,
        offset,
        limit: PAGE_SIZE,
        keyNames: new Map(deps.apiKeys.list().map((k) => [k.id, k.name])),
        accountNames: new Map(deps.accounts.list().map((a) => [a.id, a.name])),
        sources: new Map(rows.map((p) => [p.id, sourceWords(deps, p)])),
      }),
    });
  });

  app.get<{ Params: { id: string } }>('/rozsylki/:id', async (request, reply) => {
    const row = deps.packages.get(request.params.id);
    if (!row) return reply.callNotFound();
    reply.type('text/html; charset=utf-8');

    return render.page(request, {
      title: row.id,
      active: 'rozsylki',
      body: packagePage({
        row,
        accountName: deps.accounts.get(row.accountId)?.name ?? `konto ${row.accountId}`,
        keyName: deps.apiKeys.get(row.apiKeyId)?.name ?? `klucz ${row.apiKeyId}`,
        integration: row.integrationId === null ? null : integrationLink(deps, row.integrationId),
        source: sourceWords(deps, row),
        connection: connectionLink(deps, row.agentConnectionId),
        file: fileOf(deps, row.fileSendId),
        recipients: deps.packages.recipients(row.id, RECIPIENTS_SHOWN),
        shown: RECIPIENTS_SHOWN,
        summary: row.reportStatus === 'ready' ? deps.packages.recipientSummary(row.id) : null,
        campaign: campaignLink(deps, row.campaignId),
        clicks: row.campaignId === null ? null : deps.shortLinks.clicksByPackage(row.id),
      }),
    });
  });

  /** Anulowanie rozsyłki przechowywanej przez bramkę; stan, który na to nie pozwala, kończy się ostrzeżeniem. */
  app.post<{ Params: { id: string } }>('/rozsylki/:id/anuluj', async (request, reply) => {
    const row = deps.packages.get(request.params.id);
    if (!row) return reply.callNotFound();
    if (row.status === 'cancelled') {
      render.flash(request, 'warn', `Rozsyłka ${row.id} jest już anulowana.`);
    } else {
      try {
        cancelPackage(deps, row, now(), { actor: actorOf(request.adminUserId), ip: request.ip });
        render.flash(request, 'ok', `Rozsyłka ${row.id} została anulowana.`);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        render.flash(request, 'warn', e.message);
      }
    }
    return reply.redirect(`/rozsylki/${encodeURIComponent(row.id)}`, 302);
  });

  /**
   * Decyzja administratora po terminie: rozsyłka `overdue` wraca do kolejki bez terminu, a nowe zadanie przekazania
   * powstaje w tej samej transakcji. Ochrona przed burzą policzyła rozsyłkę przy przyjęciu, dlatego nie liczy jej ponownie.
   * Klucz i integrację bramka sprawdza tak jak przy przekazaniu z terminem: klucz, który nie obejmuje już rozsyłki,
   * oznacza anulowanie z powodem, a wyłączona integracja zlecająca wstrzymuje decyzję.
   */
  app.post<{ Params: { id: string } }>('/rozsylki/:id/wyslij-teraz', async (request, reply) => {
    const row = deps.packages.get(request.params.id);
    if (!row) return reply.callNotFound();
    const back = `/rozsylki/${encodeURIComponent(row.id)}`;
    const at = now();
    const actor = actorOf(request.adminUserId);
    if (row.status === 'overdue') {
      const reason = cancelReason(deps, row, at);
      if (reason !== null) {
        try {
          cancelPackage(deps, row, at, { actor, ip: request.ip, reason });
          render.flash(request, 'warn', `Bramka anulowała rozsyłkę ${row.id} zamiast ją wysłać. ${reason}.`);
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          render.flash(request, 'warn', e.message);
        }
        return reply.redirect(back, 302);
      }
      const integration = row.integrationId === null ? undefined : deps.integrations?.get(row.integrationId);
      if (integration?.enabled === 0) {
        render.flash(request, 'warn', `Integracja ${integration.name}, która zleciła rozsyłkę, jest wyłączona. Należy ją włączyć albo anulować rozsyłkę.`);
        return reply.redirect(back, 302);
      }
      // Konto wstrzymane albo wyłączone zatrzymałoby rozsyłkę w stanie `queued`, którego nie można anulować,
      // a SMS z nieaktualną treścią wyszedłby po wznowieniu konta, choćby po kilku dniach.
      const account = deps.accounts.get(row.accountId);
      if (account && (account.pausedReason !== null || account.active === 0)) {
        const [state, action] = account.pausedReason !== null ? ['wstrzymane', 'wznowić'] : ['wyłączone', 'włączyć'];
        render.flash(request, 'warn', `Konto Multiinfo ${account.name}, z którego bramka wysyła rozsyłkę, jest ${state}. Należy je ${action} albo anulować rozsyłkę.`);
        return reply.redirect(back, 302);
      }
    }
    const done = row.status === 'overdue' && deps.packages.transaction(() => {
      if (!deps.packages.sendNow(row.id)) return false;
      // Rozsyłka po terminie nie ma zadania przekazania, a gdyby zostało, nie mogą istnieć dwa.
      deps.jobs.removeFor('package.create', row.id);
      // Znacznik `sendNow` każe workerowi sprawdzić klucz ponownie w chwili przekazania.
      deps.jobs.enqueue('package.create', { packageId: row.id, sendNow: true }, at);
      return true;
    });
    if (!done) {
      render.flash(request, 'warn', 'Przycisk „Wyślij teraz” dotyczy wyłącznie rozsyłki, której termin minął o więcej niż 60 minut.');
      return reply.redirect(back, 302);
    }
    deps.audit.record({
      actor, action: 'rozsylka.wyslanie_teraz', target: `rozsylka:${row.id}`,
      meta: { odbiorcy: row.recipientsCount, termin: row.startAt }, ip: request.ip,
    });
    render.flash(request, 'ok', `Bramka przekaże rozsyłkę ${row.id} do Multiinfo, które rozpocznie wysyłkę natychmiast.`);
    return reply.redirect(back, 302);
  });

  app.get<{ Params: { id: string } }>('/rozsylki/:id/raport.csv', async (request, reply) => {
    const row = deps.packages.get(request.params.id);
    if (!row) return reply.callNotFound();
    if (row.reportStatus !== 'ready') {
      reply.type('text/plain; charset=utf-8');
      return reply.code(409).send('Raport nie jest jeszcze gotowy.');
    }
    reply.type('text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${row.id}.csv"`);
    return `${CSV_BOM}${reportCsv(deps.packages.recipients(row.id))}`;
  });
}
