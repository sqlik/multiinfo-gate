import { AgentError } from '../../agents/errors.ts';
import { linkRequest } from '../../api/link-fields.ts';
import {
  FILE_COLUMNS_NOTICE, columnList, fileSummary, prepareFileSms, sendFileDraft, type ExcludedReason, type FilePreview, type FileSendOutcome,
} from '../../integrations/agent-file.ts';
import { FILE_MEGABYTES_MAX, FILE_ROWS_MAX } from '../../store/agent-files.ts';
import { formatCount } from '../../text/numbers.ts';
import { plural } from '../../text/plural.ts';
import { warsawShort } from '../../time/warsaw.ts';
import { z } from '../../zod.ts';
import { asRecord, connOf, type ToolContext, type ToolDef } from '../tools.ts';
import { confirmLine, guardLine, scheduleLines, sendInput, smsInput } from './send.ts';

/** Wiadomość widoku do rozmowy po przekazaniu pliku: stały tekst bramki, bez nazw i wartości z pliku. */
export const FILE_LOADED_MESSAGE = 'Plik z odbiorcami jest wczytany w widoku bramki. Przygotuj treść SMS-a z polami pliku.';

/** Formaty plików, które czyta widok. */
export const FILE_FORMATS = ['csv', 'txt', 'xlsx'] as const;

const VIEWS_REQUIRED = 'Przesyłanie pliku działa wyłącznie w widoku bramki, który wyświetlają aplikacje z widokami, na przykład claude.ai i ChatGPT.';

export const openFileSendTool: ToolDef = {
  name: 'open_file_send',
  title: 'Rozsyłka z pliku',
  description: 'Otwiera w widoku bramki pole wyboru pliku z odbiorcami, z którego bramka przygotuje rozsyłkę. '
    + 'Pracownik wybiera plik CSV, TXT albo XLSX na swoim komputerze, a wartości z pliku nie trafiają do agenta. Narzędzie niczego nie wysyła.',
  scopes: ['send'],
  input: z.object({}),
  annotations: { readOnlyHint: true, openWorldHint: false },
  view: 'plik',
  run(ctx) {
    connOf(ctx);
    if (!ctx.apps) {
      return {
        text: 'Rozsyłka z pliku działa wyłącznie w aplikacjach, które wyświetlają widoki bramki, na przykład w claude.ai i ChatGPT. '
          + 'Ta aplikacja nie wyświetla widoków bramki, dlatego nie może odczytać pliku z odbiorcami. Przekaż tę informację użytkownikowi.',
        structured: { views: false },
      };
    }
    return {
      text: [
        'Widok bramki wyświetla pole wyboru pliku z odbiorcami.',
        `Pracownik wybiera plik CSV, TXT albo XLSX do ${formatCount(FILE_ROWS_MAX)} wierszy danych i ${FILE_MEGABYTES_MAX} MB, `
          + 'a widok przekazuje wiersze do bramki, dzięki czemu wartości z pliku nie trafiają do rozmowy.',
        'Po przekazaniu pliku widok wyśle do rozmowy prośbę o przygotowanie treści SMS-a.',
      ].join('\n'),
      structured: { views: true, limits: { rows: FILE_ROWS_MAX, megabytes: FILE_MEGABYTES_MAX, formats: [...FILE_FORMATS] } },
    };
  },
};

const uploadInput = z.object({
  fileId: z.string().min(1).optional().describe('Identyfikator szkicu pliku z wyniku pierwszej porcji'),
  name: z.string().min(1).optional().describe('Nazwa pliku, wyłącznie w pierwszej porcji'),
  columns: z.array(z.string().min(1)).min(1).optional().describe('Nazwy kolumn w kolejności z pliku, wyłącznie w pierwszej porcji'),
  phoneColumn: z.number().int().min(0).optional().describe('Kolumna z numerem telefonu liczona od 0, wyłącznie w pierwszej porcji'),
  totalRows: z.number().int().min(1).optional().describe('Liczba wierszy danych w pliku, wyłącznie w pierwszej porcji'),
  offset: z.number().int().min(0).describe('Liczba wierszy przyjętych przez bramkę przed tą porcją'),
  rows: z.array(z.object({
    line: z.number().int().min(1).describe('Numer wiersza w pliku'),
    cells: z.array(z.string()).describe('Wartości komórek sformatowane przez widok'),
  })).describe('Wiersze porcji w kolejności z pliku'),
  done: z.boolean().optional().describe('Ostatnia porcja pliku'),
});

export const uploadFileRowsTool: ToolDef = {
  name: 'upload_file_rows',
  title: 'Przekaż wiersze pliku',
  description: 'Przyjmuje od widoku bramki porcję wierszy pliku z odbiorcami. Narzędzie wywołuje wyłącznie widok, a agent nie przekazuje nim danych.',
  scopes: ['send'],
  input: uploadInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  appOnly: true,
  run(ctx, raw) {
    const input = raw as z.infer<typeof uploadInput>;
    // Bez widoku wiersze musiałby przekazać agent, a wartości z pliku nie mogą trafić do modelu.
    if (!ctx.apps) throw new AgentError('views_required', VIEWS_REQUIRED);
    const connectionId = connOf(ctx).connection.id;
    const files = ctx.deps.files;
    let fileId = input.fileId;
    if (fileId === undefined) {
      const { name, columns, phoneColumn, totalRows } = input;
      if (name === undefined || columns === undefined || phoneColumn === undefined || totalRows === undefined) {
        throw new AgentError('file_header_missing', 'Pierwsza porcja pliku musi zawierać nazwę pliku, nazwy kolumn, kolumnę numeru i liczbę wierszy.');
      }
      if (input.offset !== 0) throw new AgentError('upload_gap', 'Pierwsza porcja pliku musi zaczynać się od pierwszego wiersza.');
      fileId = files.create({ connectionId, name, columns, phoneColumn, totalRows, now: ctx.now });
    } else {
      const file = files.get(fileId, connectionId);
      if (!file) throw new AgentError('file_unknown', 'Szkic pliku nie istnieje. Wybierz plik w widoku bramki ponownie.');
      if (Date.parse(file.expiresAt) < ctx.now.getTime()) throw new AgentError('file_expired', 'Szkic pliku wygasł. Wybierz plik w widoku bramki ponownie.');
    }
    files.append(fileId, input.offset, input.rows);
    if (input.done === true) files.complete(fileId);
    const file = files.get(fileId, connectionId)!;
    // Wynik zawiera wyłącznie liczby: wartości i nazwa pliku zostają w bramce.
    return {
      text: file.complete
        ? `Bramka przyjęła wszystkie wiersze pliku: ${formatCount(file.receivedRows)} z ${formatCount(file.totalRows)}. Plik jest gotowy do przygotowania wysyłki.`
        : `Bramka przyjęła ${formatCount(file.receivedRows)} z ${formatCount(file.totalRows)} wierszy pliku.`,
      structured: { fileId, received: file.receivedRows, total: file.totalRows, complete: file.complete },
    };
  },
};

/** Rozsyłka z pliku bez widoków: wiersze pliku zna wyłącznie widok, a wysyłkę zatwierdza wyłącznie przycisk w widoku. */
const FILE_VIEWS_REQUIRED = 'Rozsyłka z pliku działa wyłącznie w aplikacjach, które wyświetlają widoki bramki, na przykład w claude.ai i ChatGPT.';

const rows = (n: number): string => plural(n, 'wiersz', 'wiersze', 'wierszy').replace(/^\d+/, formatCount(n));
const recipientsOf = (n: number): string => plural(n, 'odbiorcy', 'odbiorców', 'odbiorców').replace(/^\d+/, formatCount(n));
const packagesIn = (n: number): string => plural(n, 'rozsyłce', 'rozsyłkach', 'rozsyłkach');

export const fileSummaryTool: ToolDef = {
  name: 'file_summary',
  title: 'Opis pliku z odbiorcami',
  description: 'Podaje nazwy kolumn, kolumnę numeru telefonu i liczbę wierszy pliku z odbiorcami wczytanego w widoku bramki. '
    + 'Narzędzie nie zwraca żadnych wartości z pliku. Na tej podstawie przygotuj treść SMS-a z polami narzędziem prepare_file_sms.',
  scopes: ['send'],
  input: z.object({}),
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(ctx) {
    const summary = fileSummary(ctx.deps, connOf(ctx), ctx.now);
    const invalid = summary.invalidPhones === 0 ? ''
      : ` Wiersze z błędnym numerem telefonu: ${formatCount(summary.invalidPhones)}. Bramka pominie je przy wysyłce.`;
    return {
      text: [
        `Plik z odbiorcami jest wczytany w bramce i zawiera ${rows(summary.rows)} danych.${invalid}`,
        `Kolumny pliku: ${columnList(summary.columns)}.`,
        `Kolumna numeru telefonu: ${columnList([summary.phoneColumn])}.`,
        'Pole w treści SMS-a zapisz jako nazwę kolumny w nawiasach klamrowych, na przykład {Nazwa kolumny}. '
          + 'Bramka wstawi w to miejsce wartość z każdego wiersza pliku, a wartości widzi wyłącznie pracownik w podglądzie bramki.',
        'Treść przygotuj narzędziem prepare_file_sms.',
      ].join('\n'),
      structured: { ...summary, notice: FILE_COLUMNS_NOTICE },
    };
  },
};

const REASON_LABELS: Record<ExcludedReason, string> = {
  columns: 'wiersz niezgodny z nagłówkiem',
  invalid_phone: 'błędny numer telefonu',
  invalid_client_id: 'błędny identyfikator klienta',
  empty_field: 'puste pole użyte w treści',
  too_many_parts: 'treść ponad limit części integracji',
};

/** Podgląd dla agenta: wyłącznie liczby, nazwy kolumn użytych w treści, usługa, nadawca i termin. */
function fileText(ctx: ToolContext, p: FilePreview): string {
  const sender = p.senders.find((s) => s.value === p.orig)?.label ?? p.orig ?? '-';
  const service = p.services.find((s) => s.id === p.serviceId);
  const excluded = (Object.entries(p.excluded) as Array<[ExcludedReason, number]>).filter(([, n]) => n > 0);
  const total = excluded.reduce((sum, [, n]) => sum + n, 0);
  const lines = [
    `Podgląd wysyłki z pliku, szkic ${p.draftId} ważny do ${warsawShort(p.expiresAt)} czasu polskiego. Nic nie zostało wysłane.`,
    `Odbiorcy: ${formatCount(p.recipients)}. Części SMS-ów łącznie: ${formatCount(p.parts)}. `
      + `SMS-y w kodowaniu GSM: ${formatCount(p.encodings.gsm)}, w kodowaniu Unicode: ${formatCount(p.encodings.ucs2)}.`
      + (p.packages > 0 ? ` Bramka ${p.schedule === null ? 'wyśle' : 'zaplanuje'} ${plural(p.packages, 'rozsyłkę', 'rozsyłki', 'rozsyłek')}.` : ''),
    p.fields.length > 0 ? `Pola w treści: ${columnList(p.fields)}.` : 'Treść nie zawiera pól, dlatego każdy odbiorca otrzyma tę samą treść.',
    ...(total > 0 ? [`Wiersze wyłączone z wysyłki: ${formatCount(total)}. Przyczyny: ${excluded.map(([r, n]) => `${REASON_LABELS[r]} ${formatCount(n)}`).join(', ')}.`] : []),
    ...(p.duplicates > 0 ? [`Wiersze z tym samym numerem i tą samą treścią: ${formatCount(p.duplicates)}. Bramka wyśle każdą taką wiadomość raz.`] : []),
    ...(p.sameNumberDifferentText > 0
      ? [`Numery z różnymi treściami: ${formatCount(p.sameNumberDifferentText)}. Każdy z nich otrzyma wszystkie przeznaczone dla niego SMS-y.`] : []),
    ...(p.truncated > 0 ? [`Wiadomości skrócone do limitu części integracji: ${formatCount(p.truncated)}.`] : []),
    ...scheduleLines(p.schedule),
    `Nadawca: ${sender}. Usługa Multiinfo: ${service && service.label !== service.id ? `${service.label} (${service.id})` : p.serviceId}.`,
    'Gotowe wiadomości i listę wierszy wyłączonych pokazuje wyłącznie podgląd bramki.',
  ];
  if (p.blocked !== null) lines.push(p.blocked, 'Przycisk wysyłki w podglądzie bramki jest nieaktywny.');
  else lines.push(guardLine(p.guard), confirmLine(ctx, 'send_file_sms', p.schedule !== null));
  return lines.join('\n');
}

const fileSmsInput = smsInput.pick({
  serviceId: true, orig: true, encoding: true, shortenLinks: true, campaign: true, linkDomain: true, linkValidityDays: true, startAt: true,
}).extend({
  text: z.string().min(1).describe('Treść SMS-a z polami w postaci {Nazwa kolumny}, na przykład {Kontrahent}. Bramka wstawi wartość z każdego wiersza pliku.'),
  clientIdColumn: z.string().min(1).optional()
    .describe('Nazwa kolumny z identyfikatorem klienta, który bramka przekaże do raportu rozsyłki. Identyfikator może zawierać do 20 znaków: litery bez polskich znaków, cyfry, kropki, podkreślenia i myślniki.'),
});

export const prepareFileSmsTool: ToolDef = {
  name: 'prepare_file_sms',
  title: 'Przygotuj rozsyłkę z pliku',
  description: 'Przygotowuje SMS-y do odbiorców z pliku wczytanego w widoku bramki i zwraca podgląd z liczbami. '
    + 'Treść może zawierać pola w postaci {Nazwa kolumny}, a bramka wstawia w nie wartości z każdego wiersza. '
    + 'Narzędzie niczego nie wysyła, a szkic jest ważny 30 minut. Wysyłkę zatwierdza człowiek przyciskiem w podglądzie bramki.',
  scopes: ['send'],
  input: fileSmsInput,
  annotations: { readOnlyHint: true, openWorldHint: false },
  view: 'plik',
  run(ctx, raw) {
    if (!ctx.apps) throw new AgentError('views_required', FILE_VIEWS_REQUIRED);
    const input = raw as z.infer<typeof fileSmsInput>;
    const { preview, meta, confirm } = prepareFileSms(ctx.deps, connOf(ctx), {
      text: input.text,
      ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
      ...(input.serviceId !== undefined ? { serviceId: input.serviceId } : {}),
      ...(input.orig !== undefined ? { orig: input.orig } : {}),
      ...(input.encoding !== undefined ? { encoding: input.encoding } : {}),
      links: linkRequest(input),
      ...(input.clientIdColumn !== undefined ? { clientIdColumn: input.clientIdColumn } : {}),
    }, ctx.now, { apps: ctx.apps });
    // Gotowe wiadomości, numery i wiersze wyłączone trafiają wyłącznie do widoku przez _meta, którego agent nie widzi.
    return {
      text: fileText(ctx, preview), structured: { ...asRecord(preview), notice: FILE_COLUMNS_NOTICE },
      meta: { ...(confirm === null ? {} : { confirm }), ...meta },
    };
  },
};

function fileOutcomeText(o: FileSendOutcome): string {
  const repeated = o.repeated ? ' Ten szkic został wysłany wcześniej, dlatego bramka zwraca poprzedni wynik bez ponownej wysyłki.' : '';
  const head = `wysyłkę z pliku ${o.id} do ${recipientsOf(o.recipients)} w ${packagesIn(o.packages.length)}`;
  if (o.schedule !== null) {
    return `Zaplanowano ${head} na ${warsawShort(o.schedule.startAt)} czasu polskiego. `
      + `Bramka przekaże rozsyłki do Multiinfo ${warsawShort(o.schedule.handoverAt)}, a do tej chwili każdą z nich anuluje narzędzie cancel_package.${repeated}`;
  }
  return `Przyjęto ${head}.${repeated}`;
}

export const sendFileSmsTool: ToolDef = {
  name: 'send_file_sms',
  title: 'Wyślij rozsyłkę z pliku',
  description: 'Wysyła rozsyłkę z pliku dokładnie w postaci z podglądu bramki. Narzędzie wywołuje wyłącznie przycisk w widoku bramki z kluczem potwierdzenia. '
    + 'Ponowne wywołanie z tym samym szkicem zwraca poprzedni wynik bez ponownej wysyłki.',
  scopes: ['send'],
  input: sendInput,
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  appOnly: true,
  run(ctx, raw) {
    if (!ctx.apps) throw new AgentError('views_required', FILE_VIEWS_REQUIRED);
    const input = raw as z.infer<typeof sendInput>;
    const outcome = sendFileDraft(ctx.deps, connOf(ctx), input.draftId, ctx.now, input.confirm);
    return { text: fileOutcomeText(outcome), structured: { draftId: input.draftId, ...outcome } };
  },
};
