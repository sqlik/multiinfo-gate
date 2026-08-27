import { randomBytes } from 'node:crypto';
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
import type { JobsRepo } from '../store/jobs.ts';
import type { MessageEventsRepo } from '../store/message-events.ts';
import type { MessagesRepo } from '../store/messages.ts';
import type { PackagesRepo } from '../store/packages.ts';
import type { WebhookDeliveriesRepo } from '../store/webhook-deliveries.ts';
import type { Resolver } from '../net/private-address.ts';
import type { ClientPool } from '../worker/clients.ts';
import { FlashStore } from './flash.ts';
import { registerAccountRoutes } from './routes/accounts.ts';
import { registerAuditRoutes } from './routes/audit.ts';
import { registerKeyRoutes } from './routes/keys.ts';
import { registerUserRoutes } from './routes/users.ts';
import { registerMessageViewRoutes } from './routes/messages.ts';
import { registerOverviewRoutes } from './routes/overview.ts';
import { registerPackageViewRoutes } from './routes/packages.ts';
import { qrSvg } from './qr.ts';
import { createRenderer } from './render.ts';
import { LoginThrottle } from './throttle.ts';
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
  clients: ClientPool;
  sessions: SessionStore;
  masterKey: Buffer;
  now?: () => Date;
  /** Rozwiązywanie nazw przy sprawdzaniu adresu webhooka; testy podstawiają atrapę. */
  resolve?: Resolver;
  /** MIG_WEBHOOK_ALLOW_PRIVATE: zgoda na adresy webhooków w sieci wewnętrznej. */
  allowPrivateWebhooks?: boolean;
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

/** Ścieżki dostępne bez sesji: ekran logowania i pliki, z których się składa. */
function isPublicPath(path: string): boolean {
  return path === '/zaloguj' || path.startsWith('/zaloguj/')
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

const TOO_MANY_ATTEMPTS = 'Zbyt wiele nieudanych prób logowania z tego adresu. Spróbuj ponownie za kwadrans.';

/**
 * Ciasteczko sesji ma znacznik Secure, więc przeglądarka odrzuci je bez HTTPS - poza adresami
 * lokalnymi, które traktuje jako bezpieczne. Logowanie po zwykłym HTTP pod adresem sieciowym
 * kończyłoby się po cichu pętlą do ekranu logowania; lepiej powiedzieć to wprost i nie próbować.
 */
const INSECURE_CONTEXT = 'Panel bez HTTPS działa tylko pod adresem 127.0.0.1 albo localhost (tunel SSH). '
  + 'Ciasteczko sesji wymaga HTTPS albo adresu lokalnego, więc logowanie z tego adresu nie powiodłoby się.';

/** Przeglądarki uznają pętlę zwrotną za kontekst bezpieczny także bez TLS. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1' || hostname.startsWith('127.') || hostname === '[::1]' || hostname === '::1';
}

/** Czy przeglądarka przyjmie ciasteczko Secure z tej odpowiedzi. */
function secureContext(request: FastifyRequest): boolean {
  if (request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https') return true;
  const host = request.headers.host ?? '';
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
  return isLoopbackHost(hostname);
}
const TOO_MANY_CODES = 'Zbyt wiele błędnych kodów. Zaloguj się od nowa.';

const publicPath = fileURLToPath(new URL('./public', import.meta.url));

const cookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  secure: true,
  path: '/',
} as const;

interface Stage { userId: number; at: number; failures: number }

export function buildAdminServer(deps: AdminDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
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

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (isPublicPath(path)) return;

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

  app.get('/zaloguj', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return (loginPage(secureContext(request) ? null : INSECURE_CONTEXT));
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
      return (loginPage(BAD_CREDENTIALS));
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
      return (loginPage('Logowanie trwało zbyt długo. Zacznij od nowa.'));
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
      if (stage.failures < STAGE_MAX_FAILURES) return (totpPage('Kod nie pasuje. Spróbuj ponownie.'));
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
      return (setupPage(user.login, proposedSecret(userId), 'Ekran wygasł. Zeskanuj kod jeszcze raz.'));
    }

    if (!verifyTotp(secret, request.body?.kod ?? '')) {
      deps.audit.record({ actor: user.login, action: 'drugi_skladnik_nieudany', ip: request.ip });
      reply.code(400);
      return (setupPage(user.login, secret, 'Kod nie pasuje. Sprawdź zegar w telefonie i spróbuj ponownie.'));
    }

    const codes = generateRecoveryCodes();
    deps.users.enableTotp(userId, secret, codes);
    proposals.delete(userId);
    deps.audit.record({ actor: user.login, action: 'drugi_skladnik_wlaczony', ip: request.ip });

    // Kody widać jeden raz, w odpowiedzi na to żądanie - w bazie leżą już tylko zaszyfrowane.
    return (recoveryCodesPage(codes));
  });

  const render = createRenderer(deps, new FlashStore());
  registerAccountRoutes(app, deps, render);
  registerKeyRoutes(app, deps, render);
  registerUserRoutes(app, deps, render);
  registerOverviewRoutes(app, deps, render);
  registerPackageViewRoutes(app, deps, render);
  registerMessageViewRoutes(app, deps, render);
  registerAuditRoutes(app, deps, render);

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
