import type { FastifyInstance, FastifyRequest } from 'fastify';
import { NOTIFICATION_EVENTS, type NotificationEvent } from '../../notifications/rules.ts';
import type { RulePatch, SmtpSecurity } from '../../store/notifications.ts';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { EMPTY_SMTP, notificationsPage, smtpValuesOf, type NotificationsPageData, type SmtpFormValues } from '../views/notifications.ts';

type Body = Record<string, string | string[] | undefined>;

const MAX_RECIPIENTS = 20;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

function smtpValues(body: Body): SmtpFormValues {
  const s = (k: string) => String(body[k] ?? '').trim();
  const security = s('security');
  return {
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
    return { ok: false, error: 'Tryb bez szyfrowania wymaga potwierdzenia, że hasło pójdzie jawnie - zaznacz pole pod wyborem szyfrowania.' };
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

  const pageBody = (request: FastifyRequest, over: Partial<NotificationsPageData> = {}) => {
    const smtp = deps.notifications.smtp();
    return render.page(request, {
      title: 'Powiadomienia', active: 'powiadomienia',
      body: notificationsPage({ smtp, smtpValues: smtp ? smtpValuesOf(smtp) : EMPTY_SMTP, rules: deps.notifications.rules(), ...over }),
    });
  };

  app.get('/powiadomienia', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return pageBody(request);
  });

  app.post<{ Body: Body }>('/powiadomienia/smtp', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const body = request.body ?? {};
    const v = smtpValues(body);
    const checked = checkSmtp(v);
    if (!checked.ok) {
      reply.code(400);
      return pageBody(request, { smtpValues: v, error: { which: 'smtp', text: checked.error } });
    }
    const password = String(body.password ?? '');
    const had = deps.notifications.smtp() !== null;
    deps.notifications.saveSmtp({
      host: v.host, port: checked.port, security: checked.security, user: v.user === '' ? null : v.user,
      fromAddress: v.fromAddress, fromName: v.fromName === '' ? 'Multiinfo Gate' : v.fromName, recipients: checked.recipients,
      instanceName: v.instanceName, panelUrl: checked.panelUrl,
      // Puste hasło przy pierwszym zapisie to brak hasła; przy kolejnym - bez zmiany.
      ...(password !== '' ? { password } : had ? {} : { password: null }),
    }, now());
    deps.audit.record({
      actor: actorOf(request.adminUserId), action: 'powiadomienia.smtp', target: 'smtp',
      meta: { host: v.host, port: checked.port, tryb: checked.security, nadawca: v.fromAddress, odbiorcy: checked.recipients, haslo_zmienione: password !== '' },
      ip: request.ip,
    });
    render.flash(request, 'ok', 'Ustawienia SMTP zapisane. Wyślij mail testowy, żeby sprawdzić połączenie.');
    return reply.redirect('/powiadomienia', 302);
  });

  app.post('/powiadomienia/smtp/test', async (request, reply) => {
    const settings = deps.notifications.smtp();
    if (!settings) {
      render.flash(request, 'warn', 'Najpierw zapisz ustawienia SMTP.');
      return reply.redirect('/powiadomienia', 302);
    }
    if (!deps.mailer) {
      render.flash(request, 'warn', 'Ta instancja nie ma wysyłki maili.');
      return reply.redirect('/powiadomienia', 302);
    }
    const subject = `Mail testowy z Multiinfo Gate ${settings.instanceName}`.trim();
    const text = `To jest mail testowy z bramki Multiinfo Gate (${settings.instanceName || 'bez nazwy instancji'}).\n`
      + 'Jeśli go czytasz, ustawienia SMTP działają. Powiadomienia według reguł z panelu będą przychodzić na ten adres.\n';
    try {
      await deps.mailer({ ...settings, password: deps.notifications.smtpPassword() }, { subject, text });
      deps.audit.record({ actor: actorOf(request.adminUserId), action: 'powiadomienia.test', target: 'smtp', meta: { wynik: 'ok' }, ip: request.ip });
      render.flash(request, 'ok', `Mail testowy wysłany do: ${settings.recipients.join(', ')}.`);
    } catch (e) {
      // Pełny komunikat serwera - to on mówi, czy zawiniło hasło, port czy certyfikat.
      const reason = e instanceof Error ? e.message : String(e);
      deps.audit.record({ actor: actorOf(request.adminUserId), action: 'powiadomienia.test', target: 'smtp', meta: { wynik: 'blad', powod: reason }, ip: request.ip });
      render.flash(request, 'fail', `Wysyłka nie powiodła się: ${reason}`);
    }
    return reply.redirect('/powiadomienia', 302);
  });

  app.post<{ Body: Body }>('/powiadomienia/reguly', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const body = request.body ?? {};
    const raw: Record<string, string> = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(Array.isArray(v) ? v[0] ?? '' : v ?? '')]));
    const fail = (text: string) => {
      reply.code(400);
      return pageBody(request, { error: { which: 'rules', text }, ruleValues: raw });
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
    return reply.redirect('/powiadomienia', 302);
  });
}
