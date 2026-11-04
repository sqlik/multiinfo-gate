import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMail, MAIL_BACKOFF_MS, nodemailerMailer, smtpHint } from '../../src/worker/mail.ts';
import type { WorkerDeps } from '../../src/worker/send.ts';
import { openDatabase } from '../../src/store/db.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { M365AccountsRepo } from '../../src/store/m365-accounts.ts';
import { NotificationsRepo } from '../../src/store/notifications.ts';
import { M365AuthError } from '../../src/m365/oauth.ts';

const transports = vi.hoisted(() => ({ options: [] as unknown[], sent: [] as unknown[] }));
vi.mock('nodemailer', () => ({
  createTransport: (options: unknown) => {
    transports.options.push(options);
    return { sendMail: async (m: unknown) => { transports.sent.push(m); }, close: () => {} };
  },
}));

const NOW = new Date('2026-09-02T10:00:00Z');
let jobs: JobsRepo;
let notifications: NotificationsRepo;
let m365Accounts: M365AccountsRepo;
let mailer: ReturnType<typeof vi.fn>;
let deps: WorkerDeps;

beforeEach(() => {
  const db = openDatabase(':memory:');
  const masterKey = randomBytes(32);
  jobs = new JobsRepo(db);
  notifications = new NotificationsRepo(db, masterKey);
  m365Accounts = new M365AccountsRepo(db, masterKey);
  mailer = vi.fn();
  deps = { jobs, notifications, mailer } as unknown as WorkerDeps;
  transports.options.length = 0;
  transports.sent.length = 0;
});

const smtp = () => notifications.saveSmtp({ host: 'smtp.example', port: 465, security: 'tls', user: 'gate', password: 'tajne', fromAddress: 'gate@example', fromName: 'Multiinfo Gate', recipients: ['a@example', 'b@example'], instanceName: 'mi', panelUrl: null }, NOW);
const job = (attempts = 0) => {
  const id = jobs.enqueue('mail', { subject: 'Temat', text: 'Treść' }, NOW);
  return { id, type: 'mail' as const, payload: { subject: 'Temat', text: 'Treść' }, attempts, lastError: null };
};

describe('handleMail', () => {
  it('woła mailer z ustawieniami, hasłem i treścią, po czym kończy zadanie', async () => {
    smtp();
    mailer.mockResolvedValue(undefined);
    await handleMail(job(), deps, NOW);
    expect(mailer).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example', port: 465, security: 'tls', user: 'gate', password: 'tajne', recipients: ['a@example', 'b@example'] }),
      { subject: 'Temat', text: 'Treść' },
    );
    expect(jobs.depth()).toBe(0);
  });
  it('błąd mailera ponawia po 1, 5 i 15 minutach, potem porzuca', async () => {
    smtp();
    mailer.mockRejectedValue(new Error('535 Authentication failed'));
    const j = job();
    await handleMail(j, deps, NOW);
    expect(jobs.claim(NOW, 10)).toEqual([]);
    expect(jobs.claim(new Date(NOW.getTime() + MAIL_BACKOFF_MS[0]), 10).map((x) => x.id)).toEqual([j.id]);
    await handleMail({ ...j, attempts: MAIL_BACKOFF_MS.length }, deps, NOW);
    expect(jobs.depth()).toBe(0);
    expect(mailer).toHaveBeenCalledTimes(2);
  });
  it('adresat z ładunku zadania zastępuje adresatów administratora, nagłówki wątku idą dalej', async () => {
    smtp();
    mailer.mockResolvedValue(undefined);
    const id = jobs.enqueue('mail', { subject: 'Re: Awaria', text: 'SMS wysłany', to: ['jan@przyklad.test'], inReplyTo: '<m1@x>', references: '<m1@x>' }, NOW);
    await handleMail(jobs.claim(NOW, 1)[0]!, deps, NOW);
    expect(mailer.mock.calls[0]![1]).toEqual({ subject: 'Re: Awaria', text: 'SMS wysłany', to: ['jan@przyklad.test'], inReplyTo: '<m1@x>', references: '<m1@x>' });
    expect(jobs.depth()).toBe(0);
    expect(id).toBeGreaterThan(0);
  });
  it('odpowiedź automatyczna niesie znacznik autoReply z ładunku', async () => {
    smtp();
    mailer.mockResolvedValue(undefined);
    jobs.enqueue('mail', { subject: 'Re: a', text: 'b', to: ['x@przyklad.test'], autoReply: true }, NOW);
    await handleMail(jobs.claim(NOW, 1)[0]!, deps, NOW);
    expect(mailer.mock.calls[0]![1]).toEqual({ subject: 'Re: a', text: 'b', to: ['x@przyklad.test'], autoReply: true });
  });
  it('adresat jako napis albo pusta lista: napis idzie jako jeden adresat, pusta lista znaczy administratora', async () => {
    smtp();
    mailer.mockResolvedValue(undefined);
    jobs.enqueue('mail', { subject: 'a', text: 'b', to: 'x@przyklad.test' }, NOW);
    await handleMail(jobs.claim(NOW, 1)[0]!, deps, NOW);
    expect(mailer.mock.calls[0]![1]).toEqual({ subject: 'a', text: 'b', to: ['x@przyklad.test'] });
    jobs.enqueue('mail', { subject: 'a', text: 'b', to: [] }, NOW);
    await handleMail(jobs.claim(NOW, 1)[0]!, deps, NOW);
    expect(mailer.mock.calls[1]![1]).toEqual({ subject: 'a', text: 'b' });
  });
  it('bez SMTP porzuca zadanie bez wywołania mailera', async () => {
    await handleMail(job(), deps, NOW);
    expect(mailer).not.toHaveBeenCalled();
    expect(jobs.depth()).toBe(0);
  });
});

describe('handleMail przez konto Microsoft 365', () => {
  const account = (state: 'connected' | 'needs_login' | 'new' = 'connected'): number => {
    const id = m365Accounts.create({ name: 'Dyżur IT', tenant: 'firma.onmicrosoft.com', clientId: '11111111-2222-3333-4444-555555555555' }, NOW);
    if (state === 'new') return id;
    m365Accounts.connected(id, {
      refreshToken: 'token-odswiezania-0', address: 'alarmy@firma.pl', addressManual: false, loginName: 'alarmy@firma.pl', loginOid: null,
      redirectUri: 'http://localhost:8081/m365/powrot', by: 'janek',
    }, NOW);
    if (state === 'needs_login') m365Accounts.failed(id, { state: 'needs_login', code: '70000', message: 'x' }, NOW);
    return id;
  };
  // Host z bazy celowo obcy: w trybie Microsoft 365 bramka łączy się wyłącznie z smtp.office365.com.
  const smtpM365 = (accountId: number, fromAddress = 'alarmy@firma.pl') => notifications.saveSmtp({
    host: 'evil.example', port: 25, security: 'none', user: 'ktos@evil.example', password: null, fromAddress, fromName: 'Multiinfo Gate',
    recipients: ['admin@firma.pl'], instanceName: 'mi', panelUrl: null, authMode: 'm365', m365AccountId: accountId,
  }, NOW);
  const withM365 = (access: ReturnType<typeof vi.fn>, log?: { info: unknown; warn: unknown; error: unknown }) => {
    deps = { ...deps, m365: { tokens: { access }, accounts: m365Accounts }, ...(log ? { log } : {}) } as unknown as WorkerDeps;
  };

  it('pobiera token tuż przed wysyłką i przekazuje go mailerowi ze stałym serwerem Microsoftu, bez hasła', async () => {
    const id = account();
    smtpM365(id);
    const access = vi.fn().mockResolvedValue({ token: 'token-dostepu-1', address: 'alarmy@firma.pl' });
    withM365(access);
    mailer.mockResolvedValue(undefined);
    await handleMail(job(), deps, NOW);
    expect(access).toHaveBeenCalledWith(id, NOW);
    expect(mailer).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.office365.com', port: 587, security: 'starttls', user: 'alarmy@firma.pl', password: null, accessToken: 'token-dostepu-1' }),
      { subject: 'Temat', text: 'Treść' },
    );
    expect(jobs.depth()).toBe(0);
  });

  it('konto wymagające logowania: mailer i Microsoft niewołane, zadanie ponawiane według MAIL_BACKOFF_MS z wpisem w logu', async () => {
    smtpM365(account('needs_login'));
    const access = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    withM365(access, log);
    const j = job();
    await handleMail(j, deps, NOW);
    expect(mailer).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    expect(jobs.claim(NOW, 10)).toEqual([]);
    expect(jobs.claim(new Date(NOW.getTime() + MAIL_BACKOFF_MS[0]), 10).map((x) => x.id)).toEqual([j.id]);
    expect(log.warn).toHaveBeenCalledWith('mail.ponowienie', expect.objectContaining({ jobId: j.id }));
  });

  // Usunięcia konta używanego przez SMTP nie dopuszcza klucz obcy, dlatego ten przypadek nie występuje.
  it('konto nowe albo brak usług Microsoft 365: bez łączenia, po ostatniej próbie porzucenie', async () => {
    smtpM365(account('new'));
    const access = vi.fn();
    withM365(access);
    await handleMail({ ...job(), attempts: MAIL_BACKOFF_MS.length }, deps, NOW);
    expect(jobs.depth()).toBe(0);
    deps = { ...deps, m365: undefined } as unknown as WorkerDeps;
    smtpM365(account());
    await handleMail(job(), deps, NOW);
    expect(access).not.toHaveBeenCalled();
    expect(mailer).not.toHaveBeenCalled();
  });

  it('odrzucenie odświeżenia tokenu daje ponowienie bez łączenia z serwerem SMTP', async () => {
    smtpM365(account());
    withM365(vi.fn().mockRejectedValue(new M365AuthError('error', null, 'Usługa logowania Microsoft jest niedostępna')));
    const j = job();
    await handleMail(j, deps, NOW);
    expect(mailer).not.toHaveBeenCalled();
    expect(jobs.claim(new Date(NOW.getTime() + MAIL_BACKOFF_MS[0]), 10).map((x) => x.id)).toEqual([j.id]);
  });
});

describe('handleMail - niewysłany mail z powiadomieniem', () => {
  let notify: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    notify = vi.fn();
    deps = { ...deps, notifier: { notify } } as unknown as WorkerDeps;
    mailer.mockRejectedValue(new Error('421 Service not available'));
  });
  const last = (payload: Record<string, unknown>) => {
    jobs.enqueue('mail', payload, NOW);
    const claimed = jobs.claim(NOW, 1)[0]!;
    return { ...claimed, attempts: MAIL_BACKOFF_MS.length };
  };

  it('porzucony mail do administratora zgłasza mail_undeliverable', async () => {
    smtp();
    await handleMail(last({ subject: '[Multiinfo Gate mi] Błąd integracji', text: 'x' }), deps, NOW);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('mail_undeliverable', 'smtp', expect.stringContaining('Błąd integracji'), NOW);
  });

  it('ponowienie nie zgłasza niczego', async () => {
    smtp();
    await handleMail(job(), deps, NOW);
    expect(notify).not.toHaveBeenCalled();
  });

  it('porzucone potwierdzenie zwrotne do nadawcy maila nie zgłasza niczego', async () => {
    smtp();
    await handleMail(last({ subject: 'Re: Awaria', text: 'SMS wysłany', to: ['jan@przyklad.test'] }), deps, NOW);
    expect(notify).not.toHaveBeenCalled();
  });

  it('SMTP przez konto Microsoft 365 wymagające logowania albo nowe: przyczynę zgłasza m365_disconnected', async () => {
    const create = () => m365Accounts.create({ name: 'Dyżur IT', tenant: 'firma.onmicrosoft.com', clientId: '11111111-2222-3333-4444-555555555555' }, NOW);
    const save = (id: number) => notifications.saveSmtp({
      host: 'smtp.office365.com', port: 587, security: 'starttls', user: null, password: null, fromAddress: 'alarmy@firma.pl', fromName: 'Multiinfo Gate',
      recipients: ['admin@firma.pl'], instanceName: 'mi', panelUrl: null, authMode: 'm365', m365AccountId: id,
    }, NOW);
    deps = { ...deps, m365: { tokens: { access: vi.fn() }, accounts: m365Accounts } } as unknown as WorkerDeps;
    const id = create();
    m365Accounts.connected(id, {
      refreshToken: 'token-odswiezania-0', address: 'alarmy@firma.pl', addressManual: false, loginName: 'alarmy@firma.pl', loginOid: null,
      redirectUri: 'http://localhost:8081/m365/powrot', by: 'janek',
    }, NOW);
    m365Accounts.failed(id, { state: 'needs_login', code: '70000', message: 'x' }, NOW);
    save(id);
    await handleMail(last({ subject: 'a', text: 'b' }), deps, NOW);
    save(create());
    await handleMail(last({ subject: 'a', text: 'b' }), deps, NOW);
    expect(notify).not.toHaveBeenCalled();
  });

  it('SMTP przez sprawne konto Microsoft 365: odmowa serwera zgłasza mail_undeliverable', async () => {
    const id = m365Accounts.create({ name: 'Dyżur IT', tenant: 'firma.onmicrosoft.com', clientId: '11111111-2222-3333-4444-555555555555' }, NOW);
    m365Accounts.connected(id, {
      refreshToken: 'token-odswiezania-0', address: 'alarmy@firma.pl', addressManual: false, loginName: 'alarmy@firma.pl', loginOid: null,
      redirectUri: 'http://localhost:8081/m365/powrot', by: 'janek',
    }, NOW);
    notifications.saveSmtp({
      host: 'smtp.office365.com', port: 587, security: 'starttls', user: null, password: null, fromAddress: 'alarmy@firma.pl', fromName: 'Multiinfo Gate',
      recipients: ['admin@firma.pl'], instanceName: 'mi', panelUrl: null, authMode: 'm365', m365AccountId: id,
    }, NOW);
    deps = { ...deps, m365: { tokens: { access: vi.fn().mockResolvedValue({ token: 't', address: 'alarmy@firma.pl' }) }, accounts: m365Accounts } } as unknown as WorkerDeps;
    await handleMail(last({ subject: 'a', text: 'b' }), deps, NOW);
    expect(notify).toHaveBeenCalledWith('mail_undeliverable', 'smtp', expect.any(String), NOW);
  });
});

describe('nodemailerMailer', () => {
  const base = {
    host: 'smtp.example', port: 465, security: 'tls' as const, user: 'gate', fromAddress: 'gate@example', fromName: 'Multiinfo Gate',
    recipients: ['a@example'], instanceName: 'mi', panelUrl: null, authMode: 'password' as const, m365AccountId: null, updatedAt: '',
  };
  it('z tokenem loguje się mechanizmem OAuth2 zamiast hasła', async () => {
    await nodemailerMailer({ ...base, host: 'smtp.office365.com', port: 587, security: 'starttls', user: 'alarmy@firma.pl', password: null, accessToken: 'token-dostepu-1' }, { subject: 'a', text: 'b' });
    expect(transports.options[0]).toMatchObject({ host: 'smtp.office365.com', port: 587, requireTLS: true, auth: { type: 'OAuth2', user: 'alarmy@firma.pl', accessToken: 'token-dostepu-1' } });
  });
  it('bez tokenu loguje się hasłem jak dotychczas', async () => {
    await nodemailerMailer({ ...base, password: 'tajne' }, { subject: 'a', text: 'b' });
    expect(transports.options[0]).toMatchObject({ auth: { user: 'gate', pass: 'tajne' } });
  });
});

describe('smtpHint', () => {
  it('5.7.139: opcja „SMTP z uwierzytelnianiem” wyłączona', () => {
    expect(smtpHint('535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Mailbox')).toContain('opcja „SMTP z uwierzytelnianiem” jest wyłączona');
  });
  it('5.2.252 albo SendAsDenied: brak uprawnienia „Wyślij jako”', () => {
    expect(smtpHint('554 5.2.252 SendAsDenied; alarmy@firma.pl not allowed to send as biuro@firma.pl')).toContain('Wyślij jako');
    expect(smtpHint('SendAsDenied')).toContain('Wyślij jako');
  });
  it('5.7.3: token odrzucony, ponowne logowanie konta', () => {
    expect(smtpHint('535 5.7.3 Authentication unsuccessful')).toContain('ponownie');
  });
  it('inne odpowiedzi bez podpowiedzi, także kody podobne do znanych', () => {
    expect(smtpHint('535 5.7.8 Authentication credentials invalid')).toBeNull();
    expect(smtpHint('550 5.7.30 Rejected')).toBeNull();
    expect(smtpHint('')).toBeNull();
  });
});
