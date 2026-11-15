import { warsawStamp } from '../../time/warsaw.ts';
import { z } from '../../zod.ts';
import type { ToolDef } from '../tools.ts';

/**
 * Próba wywołania z widoku na potrzeby punktu kontrolnego A: czy aplikacja przekazuje `tools/call` z widoku
 * i czy agent widzi narzędzie widoczne tylko dla widoku. Zadanie 13 usuwa narzędzie.
 */
export const viewProbeTool: ToolDef = {
  name: 'view_probe',
  title: 'Próba wywołania z widoku',
  description: 'Sprawdza, czy widok bramki może wywołać narzędzie przez aplikację AI. Zwraca chwilę wywołania i początek identyfikatora sesji.',
  scopes: 'any',
  input: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  appOnly: true,
  run(ctx) {
    const at = ctx.now.toISOString();
    // Początek identyfikatora wystarcza do rozpoznania sesji po ponownym uruchomieniu bramki.
    const session = ctx.sessionId === null ? null : ctx.sessionId.slice(0, 8);
    return {
      text: `Wywołanie z widoku dotarło do bramki ${warsawStamp(at)} czasu polskiego. `
        + (session === null ? `Protokół ${ctx.protocolVersion} nie używa sesji.` : `Sesja ${session}, protokół ${ctx.protocolVersion}.`),
      structured: { at, session, protocolVersion: ctx.protocolVersion },
    };
  },
};
