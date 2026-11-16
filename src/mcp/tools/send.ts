import { ownPackage, sentByAgent } from '../../agents/reads.ts';
import { cancelMessage } from '../../api/cancel-message.ts';
import { cancelPackage } from '../../api/cancel-package.ts';
import { PLACEHOLDER_CODE } from '../../links/codes.ts';
import { linkFieldsSchema, linkRequest } from '../../api/link-fields.ts';
import { PACKAGE_RECIPIENTS_MAX } from '../../api/packages.ts';
import { CANCEL_WINDOW_TEXT } from '../../api/schedule.ts';
import {
  AgentError, prepareGroup, prepareSms, sendDraft, type GroupPreview, type GuardLeft, type Schedule, type SendOutcome, type SmsPreview,
} from '../../integrations/agent.ts';
import { plural } from '../../text/plural.ts';
import { warsawShort } from '../../time/warsaw.ts';
import { z } from '../../zod.ts';
import { asRecord, connOf, type ToolContext, type ToolDef } from '../tools.ts';

const parts = (n: number) => plural(n, 'część', 'części', 'części');
const chars = (n: number) => plural(n, 'znak', 'znaki', 'znaków');
const encodingName = (e: 'gsm' | 'ucs2') => (e === 'gsm' ? 'GSM' : 'Unicode');

function guardLine(guard: GuardLeft, what = 'Ochrona przed burzą'): string {
  const recipients = guard.recipients === null ? '' : ` i wysłać SMS-y do ${plural(guard.recipients, 'odbiorcy', 'odbiorców', 'odbiorców')}`;
  return `${what}: w bieżącym oknie można jeszcze wykonać ${plural(guard.calls, 'wysyłkę', 'wysyłki', 'wysyłek')}${recipients}.`;
}

/** Termin w podglądzie: chwila rozpoczęcia, chwila przekazania i okno anulowania. */
function scheduleLines(schedule: Schedule | null): string[] {
  if (schedule === null) return [];
  return [
    `Termin rozpoczęcia rozsyłki: ${warsawShort(schedule.startAt)} czasu polskiego. Bramka przekaże rozsyłkę do Multiinfo ${warsawShort(schedule.handoverAt)}.`,
    `${CANCEL_WINDOW_TEXT}.`,
  ];
}

/** Ostatnie zdanie podglądu: w aplikacji z widokami wysyła człowiek, bez widoków agent prosi o potwierdzenie. */
function confirmLine(ctx: ToolContext, tool: string, scheduled = false): string {
  return ctx.apps
    ? `Wysyłkę zatwierdza człowiek przyciskiem „${scheduled ? 'Zaplanuj' : 'Wyślij'}” w podglądzie bramki.`
    : `Pokaż użytkownikowi treść, liczbę odbiorców i nadawcę, a po wyraźnym potwierdzeniu wywołaj ${tool} z identyfikatorem szkicu.`;
}

/** Adres krótkiego linku z kodem zastępczym w treści podglądu, z przedrostkiem https:// albo bez niego. */
function placeholderIn(text: string, domain: string | null): string | null {
  if (domain === null) return null;
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:https://)?${escaped}/${PLACEHOLDER_CODE}`).exec(text)?.[0] ?? null;
}

function smsText(ctx: ToolContext, p: SmsPreview): string {
  const sender = p.senders.find((s) => s.value === p.orig)?.label ?? p.orig ?? '-';
  const service = p.services.find((s) => s.id === p.serviceId);
  const lines = [
    `Podgląd SMS-a, szkic ${p.draftId} ważny do ${warsawShort(p.expiresAt)} czasu polskiego. Nic nie zostało wysłane.`,
    `Odbiorcy: ${p.recipients}.` + (p.duplicatesRemoved > 0 ? ` Bramka usunęła powtórzone numery: ${p.duplicatesRemoved}.` : '')
      + (p.route === 'messages' ? ' Bramka wyśle pojedyncze wiadomości z raportem doręczenia każdej.'
        : p.schedule === null ? ' Bramka wyśle rozsyłkę ze wspólną treścią.' : ' Bramka zaplanuje rozsyłkę ze wspólną treścią.'),
    ...scheduleLines(p.schedule),
    `Nadawca: ${sender}. Usługa Multiinfo: ${service && service.label !== service.id ? `${service.label} (${service.id})` : p.serviceId}.`,
    `Treść, ${parts(p.parts)}, ${chars(p.characters)}, kodowanie ${encodingName(p.encoding)}:`,
    p.text,
  ];
  if (p.truncated) lines.push('Treść została skrócona do limitu części integracji.');
  if (p.links !== null) {
    lines.push(p.links.shortened > 0
      ? `Krótkie linki: ${p.links.shortened}, domena ${p.links.domain ?? '-'}, kampania ${p.links.campaign ?? '-'}.`
      : 'Linki w treści nie zostaną skrócone.');
    const marker = p.links.shortened > 0 ? placeholderIn(p.text, p.links.domain) : null;
    if (marker !== null) {
      lines.push(`Adres ${marker} jest znacznikiem miejsca na krótki link, a nie działającym linkiem. `
        + 'Każdy odbiorca otrzyma przy wysyłce link z własnym kodem, dlatego nie przedstawiaj tego adresu użytkownikowi jako linku.');
    }
    if (p.links.notice) lines.push(p.links.notice);
  }
  lines.push(guardLine(p.guard), confirmLine(ctx, 'send_prepared', p.schedule !== null));
  return lines.join('\n');
}

function groupText(ctx: ToolContext, p: GroupPreview): string {
  const others = p.groups.filter((g) => g !== p.group.name);
  return [
    `Podgląd SMS-a do grupy ${p.group.name}, szkic ${p.draftId} ważny do ${warsawShort(p.expiresAt)} czasu polskiego. Nic nie zostało wysłane.`,
    `Odbiorcy: ${p.recipients} z listy grupy. Numery i nazwy odbiorców pokazuje podgląd bramki.`,
    ...(p.schedule === null ? [] : [`Bramka zaplanuje rozsyłkę z odbiorcami grupy z chwili zatwierdzenia, a późniejsze zmiany składu grupy jej nie dotyczą.`]),
    ...scheduleLines(p.schedule),
    `Treść po szablonie grupy, ${parts(p.parts)}, ${chars(p.characters)}, kodowanie ${encodingName(p.encoding)}:`,
    p.text,
    ...(p.truncated ? ['Treść została skrócona do limitu części grupy.'] : []),
    guardLine(p.guard),
    guardLine(p.groupGuard, `Ochrona przed burzą grupy ${p.group.name}`),
    ...(others.length > 0 ? [`Inne grupy dostępne dla połączenia: ${others.join(', ')}.`] : []),
    confirmLine(ctx, 'send_prepared', p.schedule !== null),
  ].join('\n');
}

function outcomeText(ctx: ToolContext, o: SendOutcome): string {
  const repeated = o.repeated ? ' Ten szkic został wysłany wcześniej, dlatego bramka zwraca poprzedni wynik bez ponownej wysyłki.' : '';
  const reads = connOf(ctx).scopes.has('read_sent');
  if (o.kind === 'package' && o.schedule) {
    return `Zaplanowano rozsyłkę ${o.id} do ${plural(o.recipients, 'odbiorcy', 'odbiorców', 'odbiorców')} na ${warsawShort(o.schedule.startAt)} czasu polskiego. `
      + `Bramka przekaże ją do Multiinfo ${warsawShort(o.schedule.handoverAt)}, a do tej chwili rozsyłkę anuluje narzędzie cancel_package.${repeated}`;
  }
  if (o.kind === 'package') {
    return `Przyjęto rozsyłkę ${o.id} do ${plural(o.recipients, 'odbiorcy', 'odbiorców', 'odbiorców')}.${repeated}`
      + (reads ? ' Postęp pokazuje narzędzie package_status.' : '');
  }
  const count = plural(o.ids.length, 'wiadomość', 'wiadomości', 'wiadomości');
  const head = o.kind === 'group' ? `Przyjęto SMS do grupy ${o.group}: ${count}.` : `Przyjęto do wysyłki ${count}.`;
  const ids = o.ids.length === 1 ? ` Identyfikator wiadomości: ${o.ids[0]}.` : '';
  return `${head}${repeated}${ids}` + (reads ? ' Stan doręczeń pokazuje narzędzie list_messages z identyfikatorem szkicu.' : '');
}

/** Szkic odpowiedzi wysyła wyłącznie `send_reply`, a szkic SMS-a i SMS-a do grupy wyłącznie `send_prepared`. */
export function checkDraftKind(ctx: ToolContext, draftId: string, reply: boolean): void {
  const draft = ctx.deps.drafts.get(draftId, connOf(ctx).connection.id);
  if (draft === undefined || (draft.kind === 'reply') === reply) return;
  throw reply
    ? new AgentError('draft_kind', 'Szkic nie jest odpowiedzią na odebrany SMS. SMS wysyła narzędzie send_prepared.')
    : new AgentError('draft_kind', 'Szkic jest odpowiedzią na odebrany SMS. Odpowiedź wysyła narzędzie send_reply.');
}

/** Opis pola terminu w narzędziach wysyłki. */
const START_AT_DESCRIPTION = 'Termin rozpoczęcia wysyłki, na przykład 2026-11-20 08:00. Czas bez strefy oznacza czas polski, a termin może przypadać najwyżej 30 dni naprzód. '
  + 'Wysyłka z terminem jest zawsze rozsyłką, którą można anulować do chwili przekazania do Multiinfo, zwykle 10 minut przed terminem.';

const smsInput = z.object({
  to: z.array(z.string().describe('Numer telefonu odbiorcy')).optional()
    .describe(`Numery odbiorców, najwyżej ${PACKAGE_RECIPIENTS_MAX} bez powtórzeń. Bramka ujednolica zapis numerów i usuwa powtórzenia.`),
  campaignRecipients: z.object({
    campaign: z.string().min(1).describe('Nazwa kampanii'),
    segment: z.enum(['unopened', 'opened']).describe('Segment odbiorców: unopened bez otwarcia linku, opened z otwarciem'),
  }).optional().describe('Odbiorcy kampanii zamiast numerów. Bramka sama ustala numery, a podgląd podaje ich liczbę.'),
  text: z.string().min(1).describe('Treść SMS-a'),
  serviceId: z.string().optional().describe('Identyfikator usługi Multiinfo z narzędzia connection_status, domyślnie usługa integracji'),
  // Unia z literałem null daje w schemacie anyOf z pojedynczymi typami, czytelny także dla aplikacji z dialektem OpenAPI.
  orig: z.union([z.string(), z.literal(null)]).optional().describe('Nadawca z listy nadawców w connection_status, domyślnie nadawca integracji'),
  encoding: z.enum(['auto', 'gsm', 'unicode']).optional().describe('Kodowanie treści, domyślnie auto'),
  shortenLinks: linkFieldsSchema.shortenLinks.describe('Skracanie linków w treści, domyślnie według ustawień klucza'),
  campaign: linkFieldsSchema.campaign.describe('Nazwa kampanii krótkich linków, domyślnie nazwa integracji'),
  linkDomain: linkFieldsSchema.linkDomain.describe('Domena krótkich linków spośród domen klucza'),
  linkValidityDays: linkFieldsSchema.linkValidityDays.describe('Ważność krótkich linków w dniach, od 1 do 365'),
  startAt: z.string().optional().describe(START_AT_DESCRIPTION),
});

export const prepareSmsTool: ToolDef = {
  name: 'prepare_sms',
  title: 'Przygotuj SMS',
  description: 'Przygotowuje SMS z jedną treścią do listy numerów albo do odbiorców kampanii i zwraca podgląd. '
    + 'Narzędzie niczego nie wysyła, a szkic jest ważny 30 minut. Do 500 odbiorców bramka wysyła pojedyncze wiadomości, a powyżej 500 rozsyłkę ze wspólną treścią.',
  scopes: ['send'],
  input: smsInput,
  annotations: { readOnlyHint: true, openWorldHint: false },
  view: 'wysylka',
  run(ctx, raw) {
    const input = raw as z.infer<typeof smsInput>;
    const { confirm, preview, recipients } = prepareSms(ctx.deps, connOf(ctx), {
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.campaignRecipients !== undefined ? { campaignRecipients: input.campaignRecipients } : {}),
      text: input.text,
      ...(input.serviceId !== undefined ? { serviceId: input.serviceId } : {}),
      ...(input.orig !== undefined ? { orig: input.orig } : {}),
      ...(input.encoding !== undefined ? { encoding: input.encoding } : {}),
      links: linkRequest(input),
      ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
    }, ctx.now, { apps: ctx.apps });
    // Numery trafiają wyłącznie do widoku przez _meta, dlatego tylko w sesji z widokami: bez widoku nikt ich nie zobaczy,
    // a lista rozsyłki obejmuje do 5000 numerów.
    return { text: smsText(ctx, preview), structured: asRecord(preview), ...(ctx.apps ? { meta: { ...(confirm === null ? {} : { confirm }), recipients } } : {}) };
  },
};

const groupInput = z.object({
  group: z.string().min(1).describe('Nazwa albo prefiks grupy SMS, na przykład SERWIS'),
  text: z.string().min(1).describe('Treść SMS-a przed szablonem grupy'),
  startAt: z.string().optional().describe(START_AT_DESCRIPTION),
});

export const prepareGroupSmsTool: ToolDef = {
  name: 'prepare_group_sms',
  title: 'Przygotuj SMS do grupy',
  description: 'Przygotowuje SMS do grupy SMS według jej ustawień i zwraca podgląd z liczbą odbiorców. '
    + 'Narzędzie niczego nie wysyła, a szkic jest ważny 30 minut. Numery i nazwy odbiorców widzi wyłącznie podgląd bramki.',
  scopes: ['send_group'],
  input: groupInput,
  annotations: { readOnlyHint: true, openWorldHint: false },
  view: 'grupa',
  run(ctx, raw) {
    const input = raw as z.infer<typeof groupInput>;
    const { confirm, preview, recipients } = prepareGroup(ctx.deps, connOf(ctx), {
      group: input.group, text: input.text, ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
    }, ctx.now, { apps: ctx.apps });
    return {
      text: groupText(ctx, preview), structured: asRecord(preview),
      // Numery i nazwy trafiają wyłącznie do widoku przez _meta, którego agenci claude.ai i ChatGPT nie widzą. Bez widoku
      // nikt ich nie zobaczy, dlatego sesja bez widoków ich nie otrzymuje.
      ...(ctx.apps ? { meta: { recipients: recipients.map((r) => ({ phone: r.phone, name: r.name })), ...(confirm === null ? {} : { confirm }) } } : {}),
    };
  },
};

const sendInput = z.object({
  draftId: z.string().min(1).describe('Identyfikator szkicu z podglądu'),
  confirm: z.string().optional().describe('Klucz potwierdzenia z podglądu w widoku bramki'),
});

export const sendPreparedTool: ToolDef = {
  name: 'send_prepared',
  title: 'Wyślij przygotowany SMS',
  description: 'Wysyła SMS albo SMS do grupy dokładnie w postaci z podglądu. '
    + 'Bez widoku bramki wywołaj je dopiero po wyraźnym potwierdzeniu użytkownika. Ponowne wywołanie z tym samym szkicem zwraca poprzedni wynik bez ponownej wysyłki.',
  scopes: ['send', 'send_group'],
  input: sendInput,
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  appOnly: true,
  run(ctx, raw) {
    const input = raw as z.infer<typeof sendInput>;
    checkDraftKind(ctx, input.draftId, false);
    const outcome = sendDraft(ctx.deps, connOf(ctx), input.draftId, ctx.now, input.confirm);
    return { text: outcomeText(ctx, outcome), structured: { draftId: input.draftId, ...outcome } };
  },
};

const cancelInput = z.object({ id: z.string().min(1).describe('Identyfikator wiadomości') });

export const cancelMessageTool: ToolDef = {
  name: 'cancel_message',
  title: 'Anuluj wiadomość',
  description: 'Anuluje wiadomość wysłaną przez tę integrację, której Multiinfo nie przekazało jeszcze do sieci operatora, na przykład oczekującą w kolejce bramki albo wstrzymaną limitem. '
    + 'Multiinfo przekazuje wiadomość do sieci zwykle kilka sekund po wysyłce. Wiadomości z innych źródeł anuluje administrator w panelu bramki. '
    + 'Wiadomości przekazanej do sieci nie można anulować, a przebieg doręczenia informuje, czy anulowanie jest jeszcze możliwe.',
  scopes: ['send'],
  input: cancelInput,
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async run(ctx, raw) {
    const { id } = raw as z.infer<typeof cancelInput>;
    const conn = connOf(ctx);
    const message = ctx.deps.messages.get(id);
    // Agent anuluje wyłącznie własne wysyłki: przemycone polecenie nie może zatrzymać alarmu z innej integracji klucza.
    if (message && message.apiKeyId === conn.key.id && message.system !== 1 && !sentByAgent(ctx.deps, conn, message)) {
      throw new AgentError('not_own',
        `Agent anuluje wyłącznie wiadomości wysłane przez integrację ${conn.integration.name}. Pozostałe wiadomości anuluje administrator w panelu bramki.`);
    }
    const result = await cancelMessage(ctx.deps, conn.key.id, id, ctx.now, `agent ${conn.integration.name} · ${conn.connection.name}`);
    return { text: `Wiadomość ${result.id} została anulowana.`, structured: asRecord(result) };
  },
};

const cancelPackageInput = z.object({ id: z.string().min(1).describe('Identyfikator rozsyłki') });

export const cancelPackageTool: ToolDef = {
  name: 'cancel_package',
  title: 'Anuluj rozsyłkę',
  description: 'Anuluje rozsyłkę z terminem wysłaną przez tę integrację, którą bramka przechowuje do chwili przekazania do Multiinfo, zwykle 10 minut przed terminem. '
    + 'Rozsyłki z innych źródeł anuluje administrator w panelu bramki. Rozsyłki przekazanej do Multiinfo nie można anulować.',
  scopes: ['send', 'send_group'],
  input: cancelPackageInput,
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  run(ctx, raw) {
    const { id } = raw as z.infer<typeof cancelPackageInput>;
    const conn = connOf(ctx);
    const pkg = ctx.deps.packages.get(id);
    if (!pkg || pkg.apiKeyId !== conn.key.id) throw new AgentError('package_unknown', `Nie znaleziono rozsyłki ${id}.`);
    // Agent anuluje wyłącznie własne rozsyłki: przemycone polecenie nie może zatrzymać rozsyłki z innej integracji klucza.
    if (!ownPackage(ctx.deps, conn, pkg)) {
      throw new AgentError('not_own',
        `Agent anuluje wyłącznie rozsyłki wysłane przez integrację ${conn.integration.name}. Pozostałe rozsyłki anuluje administrator w panelu bramki.`);
    }
    const result = cancelPackage(ctx.deps, pkg, ctx.now, { actor: `agent ${conn.integration.name} · ${conn.connection.name}` });
    return { text: `Rozsyłka ${result.id} została anulowana.`, structured: asRecord(result) };
  },
};
