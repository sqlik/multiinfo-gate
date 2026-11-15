import type { ToolDef } from '../../src/mcp/tools.ts';
import { z } from '../../src/zod.ts';

/** Narzędzia próbne rejestru: przygotowanie z widokiem i zakresem send oraz wysyłka tylko dla widoku. */
export const prepareSms: ToolDef = {
  name: 'prepare_sms', title: 'Przygotuj SMS', description: 'Sprawdza treść i numery, a następnie zapisuje szkic do podglądu.', scopes: ['send'],
  input: z.object({ text: z.string().min(1).describe('Treść SMS-a') }), annotations: { readOnlyHint: false, openWorldHint: false }, view: 'co-moge',
  run: (_ctx, input) => ({ text: `Szkic: ${(input as { text: string }).text}`, structured: { draft: 'drf_1' } }),
};
export const sendPrepared: ToolDef = {
  name: 'send_prepared', title: 'Wyślij przygotowany SMS', description: 'Wysyła szkic po zatwierdzeniu w widoku.', scopes: ['send', 'send_group'],
  input: z.object({ draftId: z.string() }), annotations: { destructiveHint: true }, appOnly: true, run: () => ({ text: 'Wysłano.' }),
};
