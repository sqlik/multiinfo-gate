import { statusLabel } from '../../admin/views/status-labels.ts';
import { createDownload } from '../../agents/downloads.ts';
import { deliveryTrace, listSent, packageStatus, type PackageStatusData, type TraceEntry } from '../../agents/reads.ts';
import { AgentError } from '../../integrations/agent.ts';
import { plural } from '../../text/plural.ts';
import { warsawShort } from '../../time/warsaw.ts';
import { z } from '../../zod.ts';
import { asRecord, connOf, pageFields, type ToolDef } from '../tools.ts';

const STATUSES = ['queued', 'sent', 'delivered', 'failed', 'expired', 'cancelled', 'blocked', 'throttled', 'unknown', 'transit'] as const;
const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

/** Stan po polsku; `statusLabel` zostawia stan spoza słownika bez zmian. */
const label = (status: string): string => statusLabel(status as Parameters<typeof statusLabel>[0]);
const counts = (byStatus: Record<string, number>): string =>
  Object.entries(byStatus).map(([status, n]) => `${label(status)} ${n}`).join(', ');

/** Przedział czasu w odczytach: data i godzina bez strefy oznaczają czas polski. */
const timeField = (what: string) => z.string().optional()
  .describe(`${what}, na przykład 2026-11-14 14:00 albo 2026-11-14. Czas bez strefy oznacza czas polski.`);

const listInput = z.object({
  status: z.enum(STATUSES).optional().describe('Stan wiadomości; transit oznacza wiadomości jeszcze w drodze'),
  to: z.string().optional().describe('Numer odbiorcy'),
  from: timeField('Początek przedziału czasu utworzenia'),
  until: timeField('Koniec przedziału czasu utworzenia'),
  draftId: z.string().optional().describe('Identyfikator szkicu, z którego wysłano wiadomości'),
  ...pageFields,
});

export const listMessagesTool: ToolDef = {
  name: 'list_messages',
  title: 'Wysłane wiadomości',
  description: 'Pokazuje wiadomości wysłane przez klucz integracji, także z innych integracji, od najnowszej. '
    + 'Liczby w stanach obejmują wszystkie wiadomości spełniające filtry poza stanem.',
  scopes: ['read_sent'],
  input: listInput,
  annotations: READ,
  run(ctx, raw) {
    const q = raw as z.infer<typeof listInput>;
    const data = listSent(ctx.deps, connOf(ctx), { ...q, offset: q.offset ?? 0, limit: q.limit ?? 25 });
    const lines = [
      data.items.length === 0 ? 'Bramka nie znalazła wiadomości spełniających warunki.' : `Wiadomości na tej stronie: ${data.items.length}.`,
      ...(Object.keys(data.counts).length > 0 ? [`Liczby w stanach: ${counts(data.counts)}.`] : []),
      ...data.items.map((m) => `${m.id} do ${m.to}, ${label(m.status)}, utworzona ${warsawShort(m.createdAt)}, źródło: ${m.source}.`),
      ...(data.hasMore ? ['Kolejne wiadomości pokazuje następna strona z większą wartością offset.'] : []),
    ];
    return { text: lines.join('\n'), structured: asRecord(data) };
  },
};

function traceLines(e: TraceEntry): string[] {
  const head = e.kind === 'message' ? `Wiadomość ${e.id} do ${e.to}: ${e.statusLabel}.` : `Odbiorca ${e.id} rozsyłki ${e.packageId} do ${e.to}: ${e.statusLabel}.`;
  return [
    `${head} Źródło: ${e.source}.`,
    ...e.stages.map((s) => `- ${s.local} ${s.label}${s.detail ? `, ${s.detail}` : ''}`),
    ...(e.operator ? [`Kod operatora ${e.operator.code}: ${e.operator.description}.`] : []),
    ...(e.cancellable ? ['Wiadomość można jeszcze anulować narzędziem cancel_message.'] : []),
  ];
}

const traceInput = z.object({
  id: z.string().optional().describe('Identyfikator wiadomości'),
  to: z.string().optional().describe('Numer odbiorcy, gdy identyfikator nie jest znany'),
  from: timeField('Początek przedziału przy wyszukiwaniu po numerze, domyślnie 7 dni temu'),
  until: timeField('Koniec przedziału przy wyszukiwaniu po numerze, domyślnie teraz'),
});

export const deliveryTraceTool: ToolDef = {
  name: 'delivery_trace',
  title: 'Przebieg doręczenia',
  description: 'Pokazuje przebieg doręczenia wiadomości według identyfikatora albo numeru odbiorcy: etapy, stan, źródło i kod operatora. '
    + 'Wyszukiwanie po numerze obejmuje wiadomości i odbiorców rozsyłek, najwyżej 20 pozycji od najnowszej.',
  scopes: ['read_sent'],
  input: traceInput,
  annotations: READ,
  view: 'przebieg',
  run(ctx, raw) {
    const q = raw as z.infer<typeof traceInput>;
    const data = deliveryTrace(ctx.deps, connOf(ctx), q, ctx.now);
    const text = data.entries.length === 0 ? 'Bramka nie znalazła wiadomości spełniających warunki.' : data.entries.flatMap(traceLines).join('\n');
    return { text, structured: asRecord(data) };
  },
};

function packageText(p: PackageStatusData): string {
  const lines = [`Rozsyłka ${p.id}: ${p.statusLabel}, ${plural(p.recipients, 'odbiorca', 'odbiorców', 'odbiorców')}, przyjęta ${p.created.local}, źródło: ${p.source}.`];
  if (!p.final && p.remaining !== null) lines.push(`Do wysłania pozostało ${p.remaining} z ${p.recipients}.`);
  if (p.report === null) {
    lines.push(p.final ? 'Raport doręczeń nie jest jeszcze gotowy.' : 'Raport doręczeń będzie dostępny po zakończeniu wysyłania.');
  } else {
    lines.push(`Stany według raportu: ${counts(p.report.byStatus)}.`);
    if (p.report.reasons.length > 0) lines.push('Przyczyny niedoręczeń:', ...p.report.reasons.map((r) => `- ${r.description}: ${r.count}`));
  }
  if (p.hasMore) lines.push('Kolejnych odbiorców pokazuje następna strona z większą wartością offset, a pełną listę plik z narzędzia package_report.');
  return lines.join('\n');
}

const packageInput = z.object({ packageId: z.string().min(1).describe('Identyfikator rozsyłki'), ...pageFields });

export const packageStatusTool: ToolDef = {
  name: 'package_status',
  title: 'Stan rozsyłki',
  description: 'Pokazuje stan rozsyłki: w trakcie wysyłania postęp, a po raporcie liczby w stanach, przyczyny niedoręczeń i doręczenia w kolejnych godzinach. '
    + 'Odbiorców zwraca porcjami.',
  scopes: ['read_sent'],
  input: packageInput,
  annotations: READ,
  view: 'rozsylka',
  run(ctx, raw) {
    const q = raw as z.infer<typeof packageInput>;
    const data = packageStatus(ctx.deps, connOf(ctx), q.packageId, { offset: q.offset ?? 0, limit: q.limit ?? 25 });
    return { text: packageText(data), structured: asRecord(data) };
  },
};

/** Ostrzeżenie przy każdym linku do pliku z numerami. */
export const DOWNLOAD_WARNING = 'Plik zawiera numery telefonów odbiorców. Przekaż link wyłącznie osobie uprawnionej do tych danych.';

const reportInput = z.object({
  packageId: z.string().min(1).describe('Identyfikator rozsyłki'),
  file: z.enum(['report', 'failed']).describe('Plik: report z pełnym raportem albo failed z odbiorcami bez doręczenia'),
});

export const packageReportTool: ToolDef = {
  name: 'package_report',
  title: 'Raport rozsyłki do pobrania',
  description: 'Tworzy link do pliku CSV z raportem rozsyłki albo z listą odbiorców bez doręczenia. Link jest ważny godzinę.',
  scopes: ['read_sent'],
  input: reportInput,
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(ctx, raw) {
    const q = raw as z.infer<typeof reportInput>;
    const conn = connOf(ctx);
    const p = ctx.deps.packages.get(q.packageId);
    if (!p || p.apiKeyId !== conn.key.id) throw new AgentError('package_unknown', `Nie ma rozsyłki ${q.packageId}.`);
    if (p.reportStatus !== 'ready') {
      throw new AgentError('report_not_ready', `Raport rozsyłki ${p.id} nie jest jeszcze gotowy. Stan rozsyłki pokazuje narzędzie package_status.`);
    }
    const link = createDownload(ctx.deps, ctx.base, { apiKeyId: conn.key.id, connectionId: conn.connection.id }, q.file === 'report' ? 'package_report' : 'package_failed', p.id, ctx.now);
    const what = q.file === 'report' ? `raportu rozsyłki ${p.id}` : `listy odbiorców rozsyłki ${p.id} bez doręczenia`;
    return {
      text: `Link do pliku CSV ${what}, ważny do ${warsawShort(link.expiresAt)} czasu polskiego:\n${link.url}\n${DOWNLOAD_WARNING}`,
      structured: { packageId: p.id, file: q.file, ...link },
    };
  },
};
