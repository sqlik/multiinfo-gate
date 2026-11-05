import { randomBytes } from 'node:crypto';
import type { InstallKind } from '../config/install.ts';
import { problemUrl } from '../docs-links.ts';
import { silentLogger, type Logger } from '../log.ts';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { AccountsRepo } from '../store/accounts.ts';
import type { AdminUsersRepo } from '../store/admin-users.ts';
import type { ApiKeysRepo } from '../store/api-keys.ts';
import type { AuditRepo } from '../store/audit.ts';
import { registerHealthRoute, type InboundHealth } from '../api/health.ts';
import { healthDetailsAllowed, secureContext } from './secure-context.ts';
import { pendingRelease } from '../releases/check.ts';
import type { JobsRepo } from '../store/jobs.ts';
import type { MessageEventsRepo } from '../store/message-events.ts';
import type { MessagesRepo } from '../store/messages.ts';
import type { PackagesRepo } from '../store/packages.ts';
import type { InboundMessagesRepo } from '../store/inbound-messages.ts';
import type { InboundServicesRepo } from '../store/inbound-services.ts';
import type { IntegrationEventsRepo } from '../store/integration-events.ts';
import type { IntegrationGuardsRepo } from '../store/integration-guards.ts';
import type { MailInRepo } from '../store/mail-in.ts';
import type { MailboxConnect } from '../integrations/mail/client.ts';
import type { IntegrationsRepo } from '../store/integrations.ts';
import type { NotificationsRepo } from '../store/notifications.ts';
import type { SettingsRepo } from '../store/settings.ts';
import type { M365AccountsRepo } from '../store/m365-accounts.ts';
import type { M365Service } from '../m365/service.ts';
import type { M365Tokens } from '../m365/tokens.ts';
import type { TemplateEngine } from '../integrations/templates.ts';
import type { AdminNotifier } from '../notifications/rules.ts';
import type { Mailer } from '../worker/mail.ts';
import type { WebhookDeliveriesRepo } from '../store/webhook-deliveries.ts';
import type { CampaignsRepo } from '../store/campaigns.ts';
import type { LinkDomainsRepo } from '../store/link-domains.ts';
import type { ShortLinksRepo } from '../store/short-links.ts';
import type { DomainChecks } from '../links/domain-checks.ts';
import type { Resolver } from '../net/private-address.ts';
import type { ClientPool } from '../worker/clients.ts';
import { FlashStore } from './flash.ts';
import { registerAccountRoutes } from './routes/accounts.ts';
import { registerAuditRoutes } from './routes/audit.ts';
import { M365_RETURN_PATH, registerM365Routes } from './routes/m365.ts';
import { registerKeyRoutes } from './routes/keys.ts';
import { registerUserRoutes } from './routes/users.ts';
import { registerDeliveryRoutes } from './routes/deliveries.ts';
import { registerInboundViewRoutes } from './routes/inbound.ts';
import { registerIntegrationRoutes } from './routes/integrations.ts';
import { registerLinkRoutes } from './routes/links.ts';
import { registerMessageViewRoutes } from './routes/messages.ts';
import { registerNotificationRoutes } from './routes/notifications.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerOverviewRoutes } from './routes/overview.ts';
import { registerPackageViewRoutes } from './routes/packages.ts';
import { qrSvg } from './qr.ts';
import { createRenderer } from './render.ts';
import { LoginThrottle } from './throttle.ts';
import { WINDOW_MS } from './window.ts';
import { clientErrorPage, errorPage, notFoundPage } from './views/error.ts';
import { loginPage, totpPage } from './views/login.ts';
import { recoveryCodesPage, totpSetupPage } from './views/totp-setup.ts';
import {
  generateRecoveryCodes, generateTotpSecret, hashPassword, SESSION_COOKIE, SessionStore, totpKeyuri, verifyPassword,
  verifyTotp,
} from './session.ts';

export interface AdminDeps {
  accounts: AccountsRepo;
  apiKeys: ApiKeysRepo;
  messages: MessagesRepo;
  events: MessageEventsRepo;
  jobs: JobsRepo;
  users: AdminUsersRepo;
  audit: AuditRepo;
  deliveries: WebhookDeliveriesRepo;
  packages: PackagesRepo;
  inbound: InboundMessagesRepo;
  inboundServices: InboundServicesRepo;
  integrations: IntegrationsRepo;
  integrationEvents: IntegrationEventsRepo;
  guards: IntegrationGuardsRepo;
  /** Skracacz: domeny, kampanie i kody; SMS testowy kanału powiadomień przekazuje je do wspólnej drogi wysyłki. */
  linkDomains: LinkDomainsRepo;
  campaigns: CampaignsRepo;
  shortLinks: ShortLinksRepo;
  /** Tokeny sprawdzenia domeny skracacza, wspólne z serwerem przekierowań, który na nie odpowiada. */
  domainChecks: DomainChecks;
  /** Rozwiązywanie nazw i pobranie tokenu przy sprawdzeniu domeny; testy podstawiają atrapy. */
  domainLookup?: (host: string) => Promise<unknown>;
  domainFetch?: typeof fetch;
  /** Stan skrzynek pocztowych: formularz skrzynki, lista, szczegóły, kafelek przeglądu. */
  mailIn?: MailInRepo;
  /** Połączenie ze skrzynką do „Sprawdź połączenie”; testy podstawiają podróbkę. */
  mailboxConnect: MailboxConnect;
  /** Silnik szablonów do „Sprawdź szablon” i walidacji przy zapisie. */
  engine: TemplateEngine;
  notifications: NotificationsRepo;
  /** Ustawienia instancji: adres bramki widziany przez aplikacje. */
  settings: SettingsRepo;
  /** Powiadomienia administratora; bez niego panel ich nie zgłasza. */
  notifier?: AdminNotifier;
  /** Wysyłka maila testowego z ekranu „Powiadomienia”; testy podstawiają atrapę. */
  mailer?: Mailer;
  /** Odbiornik: panel każe mu uzgodnić pętle po zmianie klucza albo konta. */
  receiver?: { refresh(opts?: { retryAccount?: number }): void };
  /** Stan odbiornika do /healthz; bez niego pole nie występuje. */
  inboundHealth?: () => InboundHealth;
  /** MIG_TRUSTED_PROXIES: odwrotne proxy, od których /healthz panelu przyjmuje żądanie HTTPS ze szczegółami. */
  trustedProxies?: string[];
  clients: ClientPool;
  sessions: SessionStore;
  masterKey: Buffer;
  now?: () => Date;
  /** Rozwiązywanie nazw przy sprawdzaniu adresu webhooka; testy podstawiają atrapę. */
  resolve?: Resolver;
  /** MIG_WEBHOOK_ALLOW_PRIVATE: zgoda na adresy webhooków w sieci wewnętrznej. */
  allowPrivateWebhooks?: boolean;
  /** MIG_MAIL_ALLOW_PRIVATE: zgoda na serwer IMAP w sieci wewnętrznej. */
  allowPrivateMail?: boolean;
  /** Dziennik błędów panelu (`panel.wyjatek`); bez niego wpisy przepadają. */
  log?: Logger;
  /** Wariant instalacji do poleceń na stronach pomocy; brak = oba warianty. */
  install?: InstallKind | null;
  /** Wersja Node, na której działa bramka; domyślnie `process.version`, testy podstawiają inną. */
  nodeVersion?: string;
  /** Usługi kont Microsoft 365; bez nich panel nie udostępnia ekranu kont i powrotu z logowania. */
  m365?: M365Service;
  m365Accounts?: M365AccountsRepo;
  /** Token dostępu do „Sprawdź połączenie” skrzynki Microsoft 365; testy podstawiają dostawcę z atrapą. */
  m365Tokens?: Pick<M365Tokens, 'access'>;
}

declare module 'fastify' {
  interface FastifyRequest {
    adminUserId: number | null;
  }
}

const STAGE_COOKIE = 'mig_stage';

/** Drugi etap logowania musi nastąpić szybko - inaczej zaczyna się od nowa. */
const STAGE_TTL_MS = 5 * 60_000;

/**
 * Tyle błędnych kodów unieważnia etap pośredni. Kod ma milion wartości, a okno
 * tolerancji zegara przepuszcza trzy z nich - bez limitu wystarczyłoby zgadywać.
 */
const STAGE_MAX_FAILURES = 5;

/**
 * Ścieżki dostępne bez sesji: ekran logowania i pliki, z których się składa, oraz strona pośrednia
 * powrotu z Microsoftu, która niczego nie zapisuje i przenosi parametry do trasy wymagającej sesji.
 */
function isPublicPath(path: string): boolean {
  return path === '/zaloguj' || path.startsWith('/zaloguj/') || path === '/healthz' || path === M365_RETURN_PATH
    || path === '/style.css' || path === '/panel.js' || path.startsWith('/fonts/');
}

/** Nazwa wystawcy w adresie `otpauth://` - pod nią konto pokaże się w aplikacji. */
const TOTP_ISSUER = 'Multiinfo Gate';

/**
 * Ścieżki dostępne dla sesji bez drugiego składnika: sam ekran jego włączania,
 * wyjście z panelu i zasoby, z których ekran się składa.
 */
function isSetupPath(path: string): boolean {
  return path === '/drugi-skladnik' || path === '/wyloguj'
    || path === '/style.css' || path === '/panel.js' || path.startsWith('/fonts/');
}

/**
 * Ta sama odpowiedź na nieznany login i na złe hasło. Rozróżnienie zdradzałoby,
 * które konta istnieją, a panel jest dostępny dla całej sieci firmowej.
 */
const BAD_CREDENTIALS = 'Nieprawidłowy login lub hasło.';

const TOO_MANY_ATTEMPTS = 'Zbyt wiele nieudanych prób logowania z tego adresu. Spróbuj ponownie za 15 minut.';

/**
 * Ciasteczko sesji ma znacznik Secure, więc przeglądarka odrzuci je bez HTTPS - poza adresami
 * lokalnymi, które traktuje jako bezpieczne. Logowanie po zwykłym HTTP pod adresem sieciowym
 * kończyłoby się po cichu pętlą do ekranu logowania; lepiej powiedzieć to wprost i nie próbować.
 */
const INSECURE_CONTEXT = 'Panel bez HTTPS działa wyłącznie pod adresem 127.0.0.1 albo localhost (tunel SSH). '
  + 'Ciasteczko sesji wymaga HTTPS albo adresu lokalnego, dlatego logowanie z tego adresu nie jest możliwe.';

const TOO_MANY_CODES = 'Zbyt wiele błędnych kodów. Zaloguj się ponownie.';

const publicPath = fileURLToPath(new URL('./public', import.meta.url));

const cookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  secure: true,
  path: '/',
} as const;

interface Stage { userId: number; at: number; failures: number }

/** Liczby kont Microsoft 365 do /healthz panelu, bez nazw i adresów. */
const m365Health = (repo: M365AccountsRepo) => () => {
  const all = repo.list();
  return { accounts: all.length, needsLogin: all.filter((a) => a.state === 'needs_login').length };
};

export function buildAdminServer(deps: AdminDeps): FastifyInstance {
  const app = Fastify({
    logger: false, bodyLimit: 2 * 1024 * 1024,
    // Zepsuty adres (np. błędne kodowanie procentowe) omija setErrorHandler - też strona, nie JSON.
    frameworkErrors: (_error, _request, reply) => {
      (reply as FastifyReply).code(400).header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(clientErrorPage(400));
    },
  });
  const now = deps.now ?? (() => new Date());

  // Etap pośredni żyje w pamięci procesu i nigdy nie daje dostępu do panelu:
  // wpuszcza wyłącznie do formularza kodu jednorazowego.
  const stages = new Map<string, Stage>();

  // Propozycje sekretu drugiego składnika, jedna na konto, do chwili potwierdzenia kodem.
  const proposals = new Map<number, string>();

  const throttle = new LoginThrottle(() => now().getTime());

  // Skrót zastępczy dla nieznanego loginu: sprawdzenie hasła ma kosztować tyle samo,
  // co dla istniejącego konta. Pusty skrót argon2 odrzuciłby natychmiast i czas
  // odpowiedzi zdradzałby, które loginy istnieją.
  const decoyHash = hashPassword(randomBytes(32).toString('base64url'));

  const readStage = (request: FastifyRequest): { token: string; stage: Stage } | null => {
    const token = request.cookies[STAGE_COOKIE];
    if (!token) return null;
    const stage = stages.get(token);
    if (!stage) return null;
    if (now().getTime() - stage.at > STAGE_TTL_MS) {
      stages.delete(token);
      return null;
    }
    return { token, stage };
  };

  app.register(fastifyCookie);
  app.register(fastifyFormbody);
  app.register(fastifyStatic, { root: publicPath, prefix: '/', index: false });
  app.register(fastifyMultipart, { limits: { fileSize: 512 * 1024, files: 1 } });

  app.decorateRequest('adminUserId', null);

  // Błąd wewnętrzny trafia do dziennika z identyfikatorem, a przeglądarka dostaje stronę z tym
  // identyfikatorem. Domyślna odpowiedź Fastify pokazywała treść wyjątku w JSON-ie i nic nie zapisywała.
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8');
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(status).send(clientErrorPage(status));
    }
    const id = randomBytes(4).toString('hex');
    (deps.log ?? silentLogger).error('panel.wyjatek', {
      id, method: request.method, url: request.url.split('?')[0], docs: problemUrl('blad-wewnetrzny'), error,
    });
    return reply.code(500).send(errorPage(id, deps.install ?? null));
  });

  // Niezalogowanych nieznana ścieżka i tak prowadzi do logowania (hak onRequest niżej).
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(notFoundPage());
  });

  // Szczegółowy stan dla monitoringu, bez sesji, ale tylko z pętli zwrotnej albo od zaufanego proxy z HTTPS.
  // Z sieci zostaje sam status, bo nazwy kont i daty certyfikatów nie są dla każdego, kto widzi port panelu
  // (np. LXC na eth0), a nagłówki Host i X-Forwarded-Proto ustawia sam klient.
  registerHealthRoute(
    app,
    {
      accounts: deps.accounts, queueDepth: () => deps.jobs.depth(), now, detailsAllowed: healthDetailsAllowed(deps.trustedProxies ?? []),
      release: () => pendingRelease(deps.settings),
      ...(deps.inboundHealth ? { inbound: deps.inboundHealth } : {}),
      integrations: () => ({
        enabled: deps.integrations.countEnabled(), troubled24h: deps.integrations.countTroubled(new Date(now().getTime() - WINDOW_MS)),
      }),
      ...(deps.m365Accounts ? { m365: m365Health(deps.m365Accounts) } : {}),
    },
    'admin',
  );

  app.addHook('onRequest', async (request, reply) => {
    // SameSite=Strict nie odróżnia sąsiednich subdomen tej samej domeny. Przeglądarka podaje pochodzenie żądania
    // w Sec-Fetch-Site: formularz panelu wysyła same-origin, a żądanie z innej strony, także z subdomeny, odpada.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const site = request.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') {
        return reply.code(403).header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(clientErrorPage(403));
      }
    }
    const path = request.url.split('?')[0] ?? '';
    if (isPublicPath(path)) return;

    // Strony panelu niosą dane konta, a formularz skrzynki po akcji także wpisane hasło: nic do pamięci podręcznej.
    reply.header('Cache-Control', 'no-store');
    const token = request.cookies[SESSION_COOKIE];
    const userId = token ? deps.sessions.get(token) : null;
    if (userId === null) {
      return reply.redirect('/zaloguj', 302);
    }
    request.adminUserId = userId;

    // Konto bez drugiego składnika widzi wyłącznie ekran jego włączania. Sesja już
    // istnieje, bo sekret da się zapisać dopiero po sprawdzeniu hasła.
    if (!isSetupPath(path) && deps.users.findById(userId)?.totpEnabled === 0) {
      return reply.redirect('/drugi-skladnik', 302);
    }
  });

  /** Podpowiedź o pierwszym koncie tylko przy pustej tabeli kont. */
  const firstAccount = () => (deps.users.count() === 0 ? { install: deps.install ?? null } : null);

  app.get('/zaloguj', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return (loginPage(secureContext(request) ? null : INSECURE_CONTEXT, firstAccount()));
  });

  app.post<{ Body: { login?: string; haslo?: string } }>('/zaloguj', async (request, reply) => {
    const login = (request.body?.login ?? '').trim();
    const password = request.body?.haslo ?? '';
    reply.type('text/html; charset=utf-8');

    if (!secureContext(request)) {
      reply.code(400);
      return (loginPage(INSECURE_CONTEXT));
    }

    if (!throttle.allowed(request.ip)) {
      deps.audit.record({ actor: login || '(pusty)', action: 'logowanie_zablokowane', ip: request.ip });
      reply.code(429);
      return (loginPage(TOO_MANY_ATTEMPTS));
    }

    const user = deps.users.findByLogin(login);
    // Hasło sprawdzamy nawet dla nieznanego loginu - inaczej różnica w czasie odpowiedzi
    // sama powiedziałaby, że konto istnieje.
    const ok = await verifyPassword(user ? user.passwordHash : await decoyHash, password);

    if (!user || !ok) {
      throttle.fail(request.ip);
      deps.audit.record({ actor: login || '(pusty)', action: 'logowanie_nieudane', ip: request.ip });
      reply.code(401);
      return (loginPage(BAD_CREDENTIALS, firstAccount()));
    }

    if (user.totpEnabled === 0) {
      // Konto bez drugiego składnika wpuszczamy, bo dopiero z panelu da się go włączyć.
      // Zdarzenie zostaje w dzienniku, żeby braku nie dało się przeoczyć.
      deps.audit.record({ actor: user.login, action: 'logowanie_bez_totp', ip: request.ip });
      return finishLogin(reply, user.id, request.ip);
    }

    const stageToken = randomBytes(32).toString('base64url');
    stages.set(stageToken, { userId: user.id, at: now().getTime(), failures: 0 });
    reply.setCookie(STAGE_COOKIE, stageToken, cookieOptions);
    return (totpPage());
  });

  app.post<{ Body: { kod?: string } }>('/zaloguj/kod', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    if (!throttle.allowed(request.ip)) {
      reply.code(429);
      return (loginPage(TOO_MANY_ATTEMPTS));
    }

    const found = readStage(request);
    if (!found) {
      reply.code(401);
      return (loginPage('Logowanie trwało zbyt długo. Zaloguj się ponownie.'));
    }
    const { token, stage } = found;

    const code = (request.body?.kod ?? '').trim();
    const user = deps.users.findById(stage.userId);
    // W dzienniku login, nie numer konta - po numerze nikt nie rozpozna osoby.
    const actor = user?.login ?? String(stage.userId);
    const secret = deps.users.totpSecret(stage.userId);
    const accepted = (secret !== null && verifyTotp(secret, code))
      || deps.users.consumeRecoveryCode(stage.userId, code);

    if (!accepted) {
      throttle.fail(request.ip);
      stage.failures += 1;
      deps.audit.record({ actor, action: 'drugi_skladnik_nieudany', ip: request.ip });
      reply.code(401);
      if (stage.failures < STAGE_MAX_FAILURES) return (totpPage('Kod jest nieprawidłowy. Spróbuj ponownie.'));
      // Etap pośredni przepada: kolejne kody wymagają ponownego podania hasła.
      stages.delete(token);
      reply.clearCookie(STAGE_COOKIE, cookieOptions);
      deps.audit.record({ actor, action: 'drugi_skladnik_zablokowany', ip: request.ip });
      return (loginPage(TOO_MANY_CODES));
    }

    stages.delete(token);
    reply.clearCookie(STAGE_COOKIE, cookieOptions);
    deps.users.touchLogin(stage.userId, now());
    deps.audit.record({ actor, action: 'logowanie_udane', ip: request.ip });
    return finishLogin(reply, stage.userId, request.ip);
  });

  app.get('/wyloguj', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) deps.sessions.destroy(token);
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return reply.redirect('/zaloguj', 302);
  });

  app.get('/', async (_request, reply) => reply.redirect('/przeglad', 302));

  app.get('/drugi-skladnik', async (request, reply) => {
    const userId = request.adminUserId!;
    const user = deps.users.findById(userId);
    if (!user || user.totpEnabled === 1) return reply.redirect('/przeglad', 302);

    reply.type('text/html; charset=utf-8');
    return (setupPage(user.login, proposedSecret(userId)));
  });

  app.post<{ Body: { kod?: string } }>('/drugi-skladnik', async (request, reply) => {
    const userId = request.adminUserId!;
    const user = deps.users.findById(userId);
    if (!user || user.totpEnabled === 1) return reply.redirect('/przeglad', 302);

    reply.type('text/html; charset=utf-8');

    // Bez propozycji z ekranu nie ma czego potwierdzać: sekret powstaje przy jego wyświetleniu,
    // więc samo wysłanie formularza nie może niczego zapisać.
    const secret = proposals.get(userId);
    if (!secret) {
      reply.code(400);
      return (setupPage(user.login, proposedSecret(userId), 'Ekran wygasł. Zeskanuj kod ponownie.'));
    }

    if (!verifyTotp(secret, request.body?.kod ?? '')) {
      deps.audit.record({ actor: user.login, action: 'drugi_skladnik_nieudany', ip: request.ip });
      reply.code(400);
      return (setupPage(user.login, secret, 'Kod jest nieprawidłowy. Sprawdź zegar w telefonie i spróbuj ponownie.'));
    }

    const codes = generateRecoveryCodes();
    deps.users.enableTotp(userId, secret, codes);
    proposals.delete(userId);
    deps.audit.record({ actor: user.login, action: 'drugi_skladnik_wlaczony', ip: request.ip });

    // Kody widać jeden raz, w odpowiedzi na to żądanie - w bazie leżą już tylko zaszyfrowane.
    return (recoveryCodesPage(codes));
  });

  const render = createRenderer(deps, new FlashStore(), () => pendingRelease(deps.settings));
  registerAccountRoutes(app, deps, render);
  registerKeyRoutes(app, deps, render);
  registerIntegrationRoutes(app, deps, render);
  registerLinkRoutes(app, deps, render);
  registerNotificationRoutes(app, deps, render);
  registerSettingsRoutes(app, deps, render);
  registerUserRoutes(app, deps, render);
  registerOverviewRoutes(app, deps, render);
  registerPackageViewRoutes(app, deps, render);
  registerMessageViewRoutes(app, deps, render);
  registerInboundViewRoutes(app, deps, render);
  registerDeliveryRoutes(app, deps, render);
  registerAuditRoutes(app, deps, render);
  if (deps.m365 && deps.m365Accounts) registerM365Routes(app, { ...deps, m365: deps.m365, m365Accounts: deps.m365Accounts }, render);

  /**
   * Sekret trzymamy do czasu potwierdzenia, żeby odświeżenie ekranu nie unieważniło
   * kodu przepisanego już do aplikacji. Po włączeniu wpis znika.
   */
  function proposedSecret(userId: number): string {
    const existing = proposals.get(userId);
    if (existing) return existing;
    const secret = generateTotpSecret();
    proposals.set(userId, secret);
    return secret;
  }

  function setupPage(login: string, secret: string, error: string | null = null): string {
    const otpauth = totpKeyuri(login, TOTP_ISSUER, secret);
    return totpSetupPage({ secret, otpauth, qr: qrSvg(otpauth), error });
  }

  /** Identyfikator sesji powstaje dopiero tutaj, po przejściu wszystkich etapów. */
  function finishLogin(reply: FastifyReply, userId: number, ip: string) {
    throttle.reset(ip);
    const token = deps.sessions.create(userId);
    reply.setCookie(SESSION_COOKIE, token, cookieOptions);
    return reply.redirect('/przeglad', 302);
  }

  return app;
}
