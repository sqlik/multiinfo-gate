import { cancelMessage } from '../../api/cancel-message.ts';
import { linkFieldsSchema, linkRequest } from '../../api/link-fields.ts';
import { PACKAGE_RECIPIENTS_MAX } from '../../api/packages.ts';
import {
  AgentError, prepareGroup, prepareSms, sendDraft, type GroupPreview, type GuardLeft, type SendOutcome, type SmsPreview,
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
  return `${what}: w bieżącym oknie można jeszcze wykonać ${plural(guard.calls, 'wywołanie wysyłające', 'wywołania wysyłające', 'wywołań wysyłających')}${recipients}.`;
}

/** Ostatnie zdanie podglądu: w aplikacji z widokami wysyła człowiek, bez widoków agent prosi o potwierdzenie. */
function confirmLine(ctx: ToolContext, tool: string): string {
  return ctx.apps
    ? 'Wysyłkę zatwierdza człowiek przyciskiem „Wyślij” w podglądzie bramki.'
    : `Pokaż użytkownikowi treść, liczbę odbiorców i nadawcę, a po wyraźnym potwierdzeniu wywołaj ${tool} z identyfikatorem szkicu.`;
}

function smsText(ctx: ToolContext, p: SmsPreview): string {
  const sender = p.senders.find((s) => s.value === p.orig)?.label ?? p.orig ?? '-';
  const service = p.services.find((s) => s.id === p.serviceId);
  const lines = [
    `Podgląd SMS-a, szkic ${p.draftId} ważny do ${warsawShort(p.expiresAt)} czasu polskiego. Nic nie zostało wysłane.`,
    `Odbiorcy: ${p.recipients}.` + (p.duplicatesRemoved > 0 ? ` Bramka usunęła powtórzone numery: ${p.duplicatesRemoved}.` : '')
      + (p.route === 'messages' ? ' Bramka wyśle pojedyncze wiadomości z raportem doręczenia każdej.' : ' Bramka wyśle rozsyłkę ze wspólną treścią.'),
    `Nadawca: ${sender}. Usługa Multiinfo: ${service && service.label !== service.id ? `${service.label} (${service.id})` : p.serviceId}.`,
    `Treść, ${parts(p.parts)}, ${chars(p.characters)}, kodowanie ${encodingName(p.encoding)}:`,
    p.text,
  ];
  if (p.truncated) lines.push('Treść została skrócona do limitu części integracji.');
  if (p.links !== null) {
    lines.push(p.links.shortened > 0
      ? `Krótkie linki: ${p.links.shortened}, domena ${p.links.domain ?? '-'}, kampania ${p.links.campaign ?? '-'}.`
      : 'Linki w treści nie zostaną skrócone.');
    if (p.links.notice) lines.push(p.links.notice);
  }
  lines.push(guardLine(p.guard), confirmLine(ctx, 'send_prepared'));
  return lines.join('\n');
}

function groupText(ctx: ToolContext, p: GroupPreview): string {
  const others = p.groups.filter((g) => g !== p.group.name);
  return [
    `Podgląd SMS-a do grupy ${p.group.name}, szkic ${p.draftId} ważny do ${warsawShort(p.expiresAt)} czasu polskiego. Nic nie zostało wysłane.`,
    `Odbiorcy: ${p.recipients} z listy grupy. Numery i nazwy odbiorców pokazuje podgląd bramki.`,
    `Treść po szablonie grupy, ${parts(p.parts)}, ${chars(p.characters)}, kodowanie ${encodingName(p.encoding)}:`,
    p.text,
    ...(p.truncated ? ['Treść została skrócona do limitu części grupy.'] : []),
    guardLine(p.guard),
    guardLine(p.groupGuard, `Ochrona przed burzą grupy ${p.group.name}`),
    ...(others.length > 0 ? [`Inne grupy dostępne dla połączenia: ${others.join(', ')}.`] : []),
    confirmLine(ctx, 'send_prepared'),
  ].join('\n');
}

function outcomeText(ctx: ToolContext, o: SendOutcome): string {
  const repeated = o.repeated ? ' Ten szkic został wysłany wcześniej, dlatego bramka zwraca poprzedni wynik bez ponownej wysyłki.' : '';
  const reads = connOf(ctx).scopes.has('read_sent');
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
    }, ctx.now, { apps: ctx.apps });
    // Numery trafiają wyłącznie do widoku przez _meta, dlatego tylko w sesji z widokami: bez widoku nikt ich nie zobaczy,
    // a lista rozsyłki obejmuje do 5000 numerów.
    return { text: smsText(ctx, preview), structured: asRecord(preview), ...(ctx.apps ? { meta: { ...(confirm === null ? {} : { confirm }), recipients } } : {}) };
  },
};

const groupInput = z.object({
  group: z.string().min(1).describe('Nazwa albo prefiks grupy SMS, na przykład SERWIS'),
  text: z.string().min(1).describe('Treść SMS-a przed szablonem grupy'),
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
    const { confirm, preview, recipients } = prepareGroup(ctx.deps, connOf(ctx), input, ctx.now, { apps: ctx.apps });
    return {
      text: groupText(ctx, preview), structured: asRecord(preview),
      // Numery i nazwy trafiają do widoku przez _meta, którego agenci claude.ai i ChatGPT nie widzą (punkt kontrolny A).
      meta: { recipients: recipients.map((r) => ({ phone: r.phone, name: r.name })), ...(confirm === null ? {} : { confirm }) },
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
  description: 'Anuluje wiadomość, której Multiinfo nie przekazało jeszcze do sieci operatora, na przykład oczekującą w kolejce bramki albo wstrzymaną limitem. '
    + 'Multiinfo przekazuje wiadomość do sieci zwykle kilka sekund po wysyłce. '
    + 'Wiadomości przekazanej do sieci nie można anulować, a przebieg doręczenia informuje, czy anulowanie jest jeszcze możliwe.',
  scopes: ['send'],
  input: cancelInput,
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async run(ctx, raw) {
    const { id } = raw as z.infer<typeof cancelInput>;
    const result = await cancelMessage(ctx.deps, connOf(ctx).key.id, id, ctx.now);
    return { text: `Wiadomość ${result.id} została anulowana.`, structured: asRecord(result) };
  },
};
