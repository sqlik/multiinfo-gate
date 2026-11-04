import type { FastifyInstance, FastifyRequest } from 'fastify';
import { M365_SMTP } from '../../m365/oauth.ts';
import { NOTIFICATION_EVENTS, type NotificationEvent } from '../../notifications/rules.ts';
import type { RulePatch, SmtpSecurity } from '../../store/notifications.ts';
import { mailerSettings, smtpHint } from '../../worker/mail.ts';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { EMPTY_SMTP, notificationsPage, smtpValuesOf, type NotificationsPageData, type SmtpFormValues, type NotificationsTab } from '../views/notifications.ts';

type Body = Record<string, string | string[] | undefined>;

const MAX_RECIPIENTS = 20;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

function smtpValues(body: Body): SmtpFormValues {
  const s = (k: string) => String(body[k] ?? '').trim();
  const security = s('security');
  return {
    authMode: s('authMode') === 'm365' ? 'm365' : 'password', m365AccountId: s('m365AccountId'),
    host: s('host'), port: s('port'), security: security === 'tls' || security === 'none' ? security : 'starttls', plainOk: s('plainOk') === '1',
    user: s('user'), fromAddress: s('fromAddress'), fromName: s('fromName'), recipients: String(body.recipients ?? ''),
    instanceName: s('instanceName'), panelUrl: s('panelUrl'),
  };
}

type SmtpChecked =
  | { ok: true; port: number; security: SmtpSecurity; recipients: string[]; panelUrl: string | null }
  | { ok: false; error: string };

function checkSmtp(v: SmtpFormValues): SmtpChecked {
  if (v.host === '') return { ok: false, error: 'Podaj host serwera SMTP.' };
  const port = Number.parseInt(v.port, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return { ok: false, error: 'Port: liczba od 1 do 65535.' };
  if (v.security === 'none' && !v.plainOk) {
    return { ok: false, error: 'Tryb bez szyfrowania wymaga potwierdzenia, że hasło będzie przesyłane jawnie. Zaznacz pole pod wyborem szyfrowania.' };
  }
  if (!EMAIL.test(v.fromAddress)) return { ok: false, error: 'Adres nadawcy musi być adresem e-mail.' };
  const recipients = v.recipients.split(/[\n,;]/).map((r) => r.trim()).filter((r) => r !== '');
  if (recipients.length === 0) return { ok: false, error: 'Podaj przynajmniej jednego odbiorcę.' };
  if (recipients.length > MAX_RECIPIENTS) return { ok: false, error: `Najwyżej ${MAX_RECIPIENTS} odbiorców.` };
  const bad = recipients.find((r) => !EMAIL.test(r));
  if (bad !== undefined) return { ok: false, error: `Odbiorca „${bad}” nie jest adresem e-mail.` };
  let panelUrl: string | null = null;
  if (v.panelUrl !== '') {
    if (!/^https?:\/\/\S+$/.test(v.panelUrl)) return { ok: false, error: 'Adres panelu musi zaczynać się od http:// albo https://.' };
    panelUrl = v.panelUrl.replace(/\/+$/, '');
  }
  return { ok: true, port, security: v.security, recipients, panelUrl };
}

/** Lista liczb z pola „30, 14, 7”; każda 1-3650, bez powtórzeń, malejąco - tak czyta je skaner. */
function parseDays(raw: string): number[] | null {
  const parts = raw.split(/[\s,;]+/).filter((p) => p !== '');
  if (parts.length === 0 || parts.length > 10) return null;
  if (parts.some((p) => !/^\d{1,4}$/.test(p))) return null;
  const days = parts.map((p) => Number.parseInt(p, 10));
  if (days.some((d) => d < 1 || d > 3650)) return null;
  return [...new Set(days)].sort((a, b) => b - a);
}

function intIn(raw: string | undefined, min: number, max: number, fallback: number): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min && n <= max && String(n) === raw.trim() ? n : null;
}

export function registerNotificationRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  const now = deps.now ?? (() => new Date());
  const actorOf = (userId: number | null): string => {
    if (userId === null) return '(nieznany)';
    return deps.users.findById(userId)?.login ?? String(userId);
  };

  const m365Accounts = () => (deps.m365Accounts?.list() ?? []).map((a) => ({ id: a.id, name: a.name, state: a.state }));
  const m365 = deps.m365Tokens && deps.m365Accounts ? { tokens: deps.m365Tokens, accounts: deps.m365Accounts } : undefined;

  const pageBody = (request: FastifyRequest, tab: NotificationsTab, over: Partial<NotificationsPageData> = {}) => {
    const smtp = deps.notifications.smtp();
    return render.page(request, {
      title: 'Powiadomienia', active: 'powiadomienia',
      body: notificationsPage({ tab, smtp, smtpValues: smtp ? smtpValuesOf(smtp) : EMPTY_SMTP, rules: deps.notifications.rules(), m365Accounts: m365Accounts(), ...over }),
    });
  };

  app.get<{ Querystring: { zakladka?: string } }>('/powiadomienia', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return pageBody(request, request.query.zakladka === 'reguly' ? 'reguly' : 'konfiguracja');
  });

  app.post<{ Body: Body }>('/powiadomienia/smtp', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const body = request.body ?? {};
    const v = smtpValues(body);
    const invalid = (text: string) => {
      reply.code(400);
      return pageBody(request, 'konfiguracja', { smtpValues: v, error: { which: 'smtp', text } });
    };
    const before = deps.notifications.smtp();

    // Microsoft 365: stały serwer Microsoftu, login z konta, bez hasła; adres nadawcy domyślnie adres skrzynki konta (spec 7.1).
    const account = v.authMode === 'm365' && /^\d+$/.test(v.m365AccountId) ? deps.m365Accounts?.get(Number(v.m365AccountId)) : undefined;
    if (v.authMode === 'm365' && !account) return invalid('Wybierz konto Microsoft 365 z listy.');
    const fromAddress = account && v.fromAddress === '' ? account.address ?? '' : v.fromAddress;
    if (account && fromAddress === '') return invalid('Konto nie zawiera jeszcze adresu skrzynki. Podaj adres nadawcy albo zaloguj konto na ekranie Konta Microsoft 365.');
    const server = account
      ? { host: M365_SMTP.host, port: String(M365_SMTP.port), security: M365_SMTP.security, plainOk: false, user: account.address ?? '' }
      : {};
    const checked = checkSmtp({ ...v, ...server, fromAddress });
    if (!checked.ok) return invalid(checked.error);

    const password = account ? '' : String(body.password ?? '');
    const host = account ? M365_SMTP.host : v.host;
    const user = account ? account.address : v.user === '' ? null : v.user;
    deps.notifications.saveSmtp({
      host, port: checked.port, security: checked.security, user,
      fromAddress, fromName: v.fromName === '' ? 'Multiinfo Gate' : v.fromName, recipients: checked.recipients,
      instanceName: v.instanceName, panelUrl: checked.panelUrl, authMode: v.authMode, m365AccountId: account?.id ?? null,
      // Microsoft 365 nie używa hasła, więc zapisane hasło znika. Puste hasło przy pierwszym zapisie to brak hasła, a przy kolejnym - bez zmiany.
      ...(account ? { password: null } : password !== '' ? { password } : before !== null ? {} : { password: null }),
    }, now());
    deps.audit.record({
      actor: actorOf(request.adminUserId), action: 'powiadomienia.smtp', target: 'smtp',
      meta: { sposob: v.authMode, host, port: checked.port, tryb: checked.security, nadawca: fromAddress, odbiorcy: checked.recipients, haslo_zmienione: password !== '' },
      ip: request.ip,
    });
    const previousMode = before?.authMode ?? 'password';
    if (previousMode !== v.authMode) {
      deps.audit.record({
        actor: actorOf(request.adminUserId), action: 'powiadomienia.smtp.sposob', target: 'smtp',
        meta: { z: previousMode, na: v.authMode, ...(account ? { konto: account.name } : {}) }, ip: request.ip,
      });
    }
    render.flash(request, 'ok', 'Ustawienia SMTP zapisane. Połączenie można sprawdzić mailem testowym.');
    return reply.redirect('/powiadomienia', 302);
  });

  app.post('/powiadomienia/smtp/test', async (request, reply) => {
    const settings = deps.notifications.smtp();
    if (!settings) {
      render.flash(request, 'warn', 'Najpierw zapisz ustawienia SMTP.');
      return reply.redirect('/powiadomienia', 302);
    }
    if (!deps.mailer) {
      render.flash(request, 'warn', 'Ta instancja nie obsługuje wysyłki maili.');
      return reply.redirect('/powiadomienia', 302);
    }
    const subject = `Mail testowy z Multiinfo Gate ${settings.instanceName}`.trim();
    const text = `Mail testowy z bramki Multiinfo Gate (${settings.instanceName || 'bez nazwy instancji'}).\n`
      + 'Otrzymanie tej wiadomości potwierdza poprawność ustawień SMTP. Powiadomienia według reguł z panelu będą wysyłane na ten adres.\n';
    try {
      const credentials = await mailerSettings(settings, () => deps.notifications.smtpPassword(), m365, now());
      await deps.mailer(credentials, { subject, text });
      deps.audit.record({ actor: actorOf(request.adminUserId), action: 'powiadomienia.test', target: 'smtp', meta: { wynik: 'ok' }, ip: request.ip });
      render.flash(request, 'ok', `Mail testowy wysłany do: ${settings.recipients.join(', ')}.`);
    } catch (e) {
      // Pełny komunikat serwera - to on mówi, czy zawiniło hasło, port czy certyfikat.
      const reason = e instanceof Error ? e.message : String(e);
      deps.audit.record({ actor: actorOf(request.adminUserId), action: 'powiadomienia.test', target: 'smtp', meta: { wynik: 'blad', powod: reason }, ip: request.ip });
      const hint = settings.authMode === 'm365' ? smtpHint(reason) : null;
      render.flash(request, 'fail', hint ? `Wysyłka nie powiodła się. ${hint}. Odpowiedź serwera: ${reason}` : `Wysyłka nie powiodła się: ${reason}`);
    }
    return reply.redirect('/powiadomienia', 302);
  });

  app.post<{ Body: Body }>('/powiadomienia/reguly', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const body = request.body ?? {};
    const raw: Record<string, string> = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(Array.isArray(v) ? v[0] ?? '' : v ?? '')]));
    const fail = (text: string) => {
      reply.code(400);
      return pageBody(request, 'reguly', { error: { which: 'rules', text }, ruleValues: raw });
    };
    if (deps.notifications.smtp() === null) return fail('Najpierw skonfiguruj SMTP.');

    const patches = new Map<NotificationEvent, RulePatch>();
    for (const event of NOTIFICATION_EVENTS) {
      const current = deps.notifications.rule(event);
      const maxPerHour = intIn(raw[`maxPerHour_${event}`], 1, 100, current.maxPerHour);
      const groupHours = intIn(raw[`groupHours_${event}`], 0, 24, current.groupHours);
      if (maxPerHour === null) return fail(`${event}: „maks. na godzinę” to liczba od 1 do 100.`);
      if (groupHours === null) return fail(`${event}: „grupuj co” to liczba godzin od 0 do 24.`);
      let params: Record<string, unknown> = current.params;
      if (event === 'certificate_expiring') {
        const days = parseDays(raw.days_certificate_expiring ?? '');
        if (days === null) return fail('Certyfikat: podaj dni przed wygaśnięciem jako liczby po przecinku, np. 30, 14, 7, 1.');
        params = { days };
      } else if (event === 'inbound_failure') {
        const afterMinutes = intIn(raw.afterMinutes_inbound_failure, 1, 1440, 15);
        if (afterMinutes === null) return fail('Awaria odbioru: liczba minut od 1 do 1440.');
        params = { afterMinutes };
      } else if (event === 'mailbox_failure') {
        const afterMinutes = intIn(raw.afterMinutes_mailbox_failure, 1, 1440, 15);
        if (afterMinutes === null) return fail('Awaria skrzynki pocztowej: liczba minut od 1 do 1440.');
        params = { afterMinutes };
      } else if (event === 'daily_summary') {
        const hour = intIn(raw.hour_daily_summary, 0, 23, 8);
        if (hour === null) return fail('Podsumowanie dzienne: godzina od 0 do 23.');
        params = { hour };
      }
      patches.set(event, { enabled: raw[`enabled_${event}`] === '1' ? 1 : 0, maxPerHour, groupHours, params });
    }

    const changed: string[] = [];
    for (const [event, patch] of patches) {
      const before = deps.notifications.rule(event);
      if (JSON.stringify({ e: before.enabled, m: before.maxPerHour, g: before.groupHours, p: before.params })
        !== JSON.stringify({ e: patch.enabled, m: patch.maxPerHour, g: patch.groupHours, p: patch.params })) changed.push(event);
      deps.notifications.saveRule(event, patch);
    }
    deps.audit.record({
      actor: actorOf(request.adminUserId), action: 'powiadomienia.reguly', target: 'reguly', meta: { zmienione: changed }, ip: request.ip,
    });
    render.flash(request, 'ok', changed.length === 0 ? 'Reguły bez zmian.' : `Reguły zapisane (${changed.length} zmienione).`);
    return reply.redirect('/powiadomienia?zakladka=reguly', 302);
  });
}
