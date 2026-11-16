import { AgentError } from '../../agents/errors.ts';
import { FILE_MEGABYTES_MAX, FILE_ROWS_MAX } from '../../store/agent-files.ts';
import { formatCount } from '../../text/numbers.ts';
import { z } from '../../zod.ts';
import { connOf, type ToolDef } from '../tools.ts';

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
