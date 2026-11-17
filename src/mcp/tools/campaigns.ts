import { createDownload } from '../../agents/downloads.ts';
import { campaignResults, type CampaignResultsData } from '../../agents/reads.ts';
import { AgentError } from '../../integrations/agent.ts';
import { warsawShort } from '../../time/warsaw.ts';
import { z } from '../../zod.ts';
import { asRecord, connOf, pageFields, type ToolDef } from '../tools.ts';
import { DOWNLOAD_WARNING } from './read.ts';

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

const listInput = z.object(pageFields);

export const listCampaignsTool: ToolDef = {
  name: 'list_campaigns',
  title: 'Kampanie',
  description: 'Pokazuje kampanie krótkich linków klucza integracji od ostatnio używanej: liczbę wysłanych, otwarcia i kliknięcia. '
    + 'Szczegóły kampanii pokazuje narzędzie campaign_results.',
  scopes: ['campaigns'],
  input: listInput,
  annotations: READ,
  run(ctx, raw) {
    const q = raw as z.infer<typeof listInput>;
    const { rows, hasMore } = ctx.deps.campaigns.list({ apiKeyId: connOf(ctx).key.id, offset: q.offset ?? 0, limit: q.limit ?? 25, order: 'recent' });
    const items = rows.map((c) => ({
      name: c.name, sent: c.sent, opens: c.opens, clicks: c.clicks, firstSentAt: c.firstSentAt, lastSentAt: c.lastSentAt, detailsPurged: c.detailsPurgedAt !== null,
    }));
    const lines = [
      items.length === 0 ? 'Klucz integracji nie obejmuje żadnej kampanii.' : `Kampanie na tej stronie: ${items.length}.`,
      ...items.map((c) => `${c.name}: wysłano ${c.sent}, otwarcia ${c.opens}, kliknięcia ${c.clicks}, ostatnia wysyłka ${warsawShort(c.lastSentAt)}.`),
      ...(hasMore ? ['Kolejne kampanie pokazuje następna strona z większą wartością offset.'] : []),
    ];
    return { text: lines.join('\n'), structured: { items, hasMore } };
  },
};

function resultsText(d: CampaignResultsData): string {
  const lines = [
    `Kampania ${d.name}: wysłano ${d.sent}, doręczono ${d.delivered}, otwarcia ${d.opens}, kliknięcia ${d.clicks}.`
      + (d.bots > 0 ? ` Bramka pominęła w liczbach kliknięcia automatów: ${d.bots}.` : ''),
    `Pierwsza wysyłka ${d.first.local}, ostatnia ${d.last.local}.`,
  ];
  if (d.detailsPurged) {
    lines.push('Szczegóły kampanii zostały usunięte po okresie przechowywania, dlatego zostały wyłącznie liczby i kliknięcia w kolejnych godzinach.');
  } else {
    if (d.opensByDay.length > 0) lines.push('Otwarcia w kolejnych dniach:', ...d.opensByDay.map((o) => `- ${o.day}: ${o.opens}`));
    if (d.unopened) lines.push(`Odbiorcy bez otwarcia: ${d.unopened.total}.`);
  }
  if (d.hiddenItems) {
    lines.push('Kampania obejmuje wysyłkę z pliku, dlatego numery odbiorców i adresy linków widzi wyłącznie pracownik w widoku bramki.');
  } else if (d.targets.length > 0) lines.push('Kliknięcia według celu linku:', ...d.targets.map((t) => `- ${t.target}: ${t.clicks}`));
  return lines.join('\n');
}

/**
 * Wynik dla agenta i `_meta` dla widoku. Kampania z wysyłką z pliku oddaje odbiorców bez otwarcia i cele linków
 * wyłącznie widokowi, ponieważ pochodzą z pliku pracownika.
 */
function split(d: CampaignResultsData): { structured: Record<string, unknown>; meta?: Record<string, unknown> } {
  if (!d.hiddenItems) return { structured: asRecord(d) };
  return {
    structured: asRecord({ ...d, targets: [], unopened: d.unopened && { ...d.unopened, items: [] } }),
    meta: { targets: d.targets, unopened: d.unopened?.items ?? [] },
  };
}

const resultsInput = z.object({
  name: z.string().min(1).describe('Nazwa kampanii'),
  ...pageFields,
  csv: z.enum(['opened', 'unopened']).optional().describe('Link do pliku CSV odbiorców: opened z otwarciem albo unopened bez otwarcia'),
});

export const campaignResultsTool: ToolDef = {
  name: 'campaign_results',
  title: 'Wyniki kampanii',
  description: 'Pokazuje wyniki kampanii: doręczenia, otwarcia dzień po dniu, kliknięcia w kolejnych godzinach, cele linków i odbiorców bez otwarcia porcjami. '
    + 'Na życzenie tworzy link do pliku CSV odbiorców ważny godzinę.',
  scopes: ['campaigns'],
  input: resultsInput,
  annotations: { readOnlyHint: true, openWorldHint: false },
  view: 'kampania',
  run(ctx, raw) {
    const q = raw as z.infer<typeof resultsInput>;
    const conn = connOf(ctx);
    const data = campaignResults(ctx.deps, conn, q.name, { offset: q.offset ?? 0, limit: q.limit ?? 25 });
    const { structured, meta } = split(data);
    if (q.csv === undefined) return { text: resultsText(data), structured, ...(meta ? { meta } : {}) };
    if (data.detailsPurged) {
      throw new AgentError('campaign_purged', 'Szczegóły kampanii zostały usunięte po okresie przechowywania, dlatego listy odbiorców nie można odtworzyć.');
    }
    const id = ctx.deps.campaigns.byName(conn.key.id, q.name)!.id;
    const download = createDownload(ctx.deps, ctx.base, { apiKeyId: conn.key.id, connectionId: conn.connection.id }, q.csv === 'opened' ? 'campaign_opened' : 'campaign_unopened', String(id), ctx.now);
    const what = q.csv === 'opened' ? 'odbiorców z otwarciem' : 'odbiorców bez otwarcia';
    return {
      text: `${resultsText(data)}\nLink do pliku CSV ${what}, ważny do ${warsawShort(download.expiresAt)} czasu polskiego:\n${download.url}\n${DOWNLOAD_WARNING}`,
      structured: { ...structured, download: { file: q.csv, ...download } }, ...(meta ? { meta } : {}),
    };
  },
};
