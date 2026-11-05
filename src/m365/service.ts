/**
 * Usługi konta Microsoft 365 wołane z tras panelu (a w 1.11 z MCP): zakładanie, logowanie przez
 * przeglądarkę, zmiana adresu, rozłączenie i usunięcie. Każda operacja trafia do dziennika zdarzeń,
 * bez tokenów i bez kodu autoryzacji.
 */
import { randomBytes } from 'node:crypto';
import type { AuditRepo } from '../store/audit.ts';
import { isMailIn, type IntegrationsRepo } from '../store/integrations.ts';
import type { M365AccountInput, M365AccountsRepo } from '../store/m365-accounts.ts';
import type { NotificationsRepo } from '../store/notifications.ts';
import {
  M365AuthError, addressFromClaims, authorizeUrl, cleanDescription, pkcePair, redeemCode, validClientId, validTenant,
  type TokenFetch, type TokenSet,
} from './oauth.ts';
import type { M365Tokens } from './tokens.ts';

export type M365User = { kind: 'integration'; id: number; name: string } | { kind: 'smtp' };
/** `session` jest skrótem tokenu sesji panelu: logowanie w Microsoft kończy wyłącznie sesja, która je rozpoczęła. */
export interface PanelUser { id: number; login: string; session?: string }

/** Czas na powrót z logowania Microsoftu. */
export const LOGIN_TTL_MS = 600_000;

const MAX_NAME = 100;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Znaki sterujące rozdzielają pola ciągu SASL XOAUTH2, dlatego adres skrzynki nie może ich zawierać. */
const CONTROL = /[\x00-\x1f\x7f]/;

const EXPIRED = 'Logowanie wygasło albo zostało już zakończone, dlatego należy rozpocząć je ponownie';
const CHANGED = 'Ustawienia konta zmieniły się w trakcie logowania, dlatego należy rozpocząć je ponownie';
const MISSING = 'Konto Microsoft 365 nie istnieje';

interface PendingLogin {
  accountId: number; userId: number; session: string | undefined; tenant: string; clientId: string; verifier: string;
  redirectUri: string; expiresAt: number;
  /** Numer zmiany konta z chwili rozpoczęcia; rozłączenie, zmiana aplikacji i usunięcie go zwiększają. */
  epoch: number;
}

export interface M365ServiceDeps {
  accounts: M365AccountsRepo; tokens: M365Tokens; fetch: TokenFetch;
  integrations: IntegrationsRepo; notifications: NotificationsRepo; audit: AuditRepo;
}

/**
 * Wynik powrotu z logowania. `login` jest nazwą logowania z roszczeń, a `switched` oznacza logowanie innym kontem
 * niż poprzednio, po którym adres skrzynki pochodzi z roszczeń nowego konta.
 */
type Finish =
  | { ok: true; accountId: number; address: string; login: string | null; switched: boolean }
  | { ok: false; accountId: number | null; error: string };

export class M365Service {
  /** Logowania w toku, kluczem jest `state`. Tylko w pamięci: restart bramki unieważnia rozpoczęte logowania. */
  private readonly pending = new Map<string, PendingLogin>();
  /** Numery zmian kont. Logowanie, które wymieniało kod w chwili rozłączenia, zmiany aplikacji albo usunięcia, przepada. */
  private readonly epochs = new Map<number, number>();

  constructor(private readonly deps: M365ServiceDeps) {}

  create(input: M365AccountInput, user: PanelUser, at: Date): { ok: true; id: number } | { ok: false; error: string } {
    const v = normalize(input);
    if (typeof v === 'string') return { ok: false, error: v };
    const id = this.deps.accounts.create(v, at);
    this.record(user, 'm365.dodano', id, { name: v.name, tenant: v.tenant, clientId: v.clientId });
    return { ok: true, id };
  }

  update(id: number, input: M365AccountInput, user: PanelUser, at: Date): { ok: true } | { ok: false; error: string } {
    const current = this.deps.accounts.get(id);
    if (!current) return { ok: false, error: 'Konto Microsoft 365 nie istnieje' };
    const v = normalize(input);
    if (typeof v === 'string') return { ok: false, error: v };
    const reset = current.tenant !== v.tenant || current.clientId !== v.clientId;
    this.deps.accounts.update(id, v, at);
    if (reset) {
      this.deps.tokens.forget(id);
      this.dropPending(id);
    }
    this.record(user, 'm365.zmieniono', id, { name: v.name, tenant: v.tenant, clientId: v.clientId, reset });
    return { ok: true };
  }

  startLogin(id: number, redirectUri: string, user: PanelUser, now: Date): { url: string } {
    const account = this.deps.accounts.get(id);
    if (!account) throw new Error(MISSING);
    this.prune(now.getTime());
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(32).toString('base64url');
    this.pending.set(state, {
      accountId: id, userId: user.id, session: user.session, tenant: account.tenant, clientId: account.clientId, verifier, redirectUri,
      expiresAt: now.getTime() + LOGIN_TTL_MS, epoch: this.epoch(id),
    });
    return { url: authorizeUrl({ tenant: account.tenant, clientId: account.clientId, redirectUri, state, challenge }) };
  }

  async finishLogin(
    q: { state?: string; code?: string; error?: string; error_description?: string },
    user: PanelUser,
    now: Date,
  ): Promise<Finish> {
    const login = q.state ? this.pending.get(q.state) : undefined;
    if (!login || !q.state) return { ok: false, accountId: null, error: EXPIRED };
    this.pending.delete(q.state);
    const accountId = login.accountId;
    if (now.getTime() > login.expiresAt) return { ok: false, accountId, error: EXPIRED };
    if (login.userId !== user.id) return { ok: false, accountId, error: 'Logowanie rozpoczął inny użytkownik panelu, dlatego należy rozpocząć je ponownie' };
    if (login.session !== user.session) {
      return { ok: false, accountId, error: 'Logowanie rozpoczęto w innej sesji panelu, dlatego należy rozpocząć je ponownie' };
    }
    if (q.error) {
      const detail = q.error_description ? cleanDescription(q.error_description) : q.error;
      return { ok: false, accountId, error: `Microsoft odrzucił logowanie: ${detail}` };
    }
    const before = this.deps.accounts.get(accountId);
    if (!before) return { ok: false, accountId: null, error: MISSING };
    if (before.tenant !== login.tenant || before.clientId !== login.clientId) return { ok: false, accountId, error: CHANGED };
    if (!q.code) return { ok: false, accountId, error: 'Odpowiedź Microsoftu nie zawiera kodu autoryzacji' };
    let set: TokenSet;
    try {
      set = await redeemCode(this.deps.fetch, {
        tenant: login.tenant, clientId: login.clientId, redirectUri: login.redirectUri, code: q.code, verifier: login.verifier,
      }, now);
    } catch (err) {
      const message = err instanceof M365AuthError ? err.message : 'nieoczekiwany błąd wymiany kodu';
      return { ok: false, accountId, error: `Microsoft odrzucił logowanie: ${message}` };
    }
    // Wymiana kodu trwa do kilkunastu sekund. Konto rozłączone, zmienione albo usunięte w tym czasie nie dostaje tokenu.
    const account = this.deps.accounts.get(accountId);
    if (!account) return { ok: false, accountId: null, error: MISSING };
    if (this.epoch(accountId) !== login.epoch || account.tenant !== login.tenant || account.clientId !== login.clientId) {
      return { ok: false, accountId, error: CHANGED };
    }
    if (GUID.test(login.tenant) && set.claims?.tid?.toLowerCase() !== login.tenant) {
      return { ok: false, accountId, error: 'Zalogowane konto należy do innego katalogu niż podany w ustawieniach konta' };
    }
    const claimed = addressFromClaims(set.claims);
    if (claimed === null) {
      return { ok: false, accountId, error: 'Microsoft nie przekazał adresu konta, dlatego należy sprawdzić uprawnienia email i profile w rejestracji aplikacji' };
    }
    const identity = { loginName: set.claims?.preferred_username?.trim() || null, loginOid: set.claims?.oid?.trim().toLowerCase() || null };
    const known = account.loginOid !== null || account.loginName !== null;
    const same = known && sameLogin(account, identity);
    const keep = same && account.addressManual && account.address !== null;
    const address = keep ? account.address! : claimed;
    this.deps.accounts.connected(accountId, {
      refreshToken: set.refreshToken, address, addressManual: keep, ...identity, redirectUri: login.redirectUri, by: user.login,
    }, now);
    this.deps.tokens.remember(accountId, set);
    const switched = known && !same;
    this.record(user, 'm365.zalogowano', accountId, { address, login: identity.loginName, switched });
    return { ok: true, accountId, address, login: identity.loginName, switched };
  }

  setAddress(id: number, address: string, user: PanelUser, at: Date): { ok: true } | { ok: false; error: string } {
    if (!this.deps.accounts.get(id)) return { ok: false, error: MISSING };
    const a = address.trim().toLowerCase();
    if (a.length > 254 || !EMAIL.test(a) || CONTROL.test(a)) return { ok: false, error: 'Adres skrzynki musi być adresem e-mail, na przykład alarmy@firma.pl' };
    this.deps.accounts.setAddress(id, a, at);
    this.record(user, 'm365.adres', id, { address: a });
    return { ok: true };
  }

  disconnect(id: number, user: PanelUser, at: Date): void {
    this.deps.accounts.disconnect(id, at);
    this.deps.tokens.forget(id);
    this.dropPending(id);
    this.record(user, 'm365.rozlaczono', id);
  }

  remove(id: number, user: PanelUser, _at: Date): { ok: true } | { ok: false; error: string; users: M365User[] } {
    const users = this.users(id);
    if (users.length > 0) {
      return { ok: false, error: 'Konto jest używane przez integracje albo ustawienia SMTP, dlatego nie można go usunąć', users };
    }
    const name = this.deps.accounts.get(id)?.name;
    this.deps.accounts.remove(id);
    this.deps.tokens.forget(id);
    this.dropPending(id);
    this.record(user, 'm365.usunieto', id, name !== undefined ? { name } : undefined);
    return { ok: true };
  }

  /** Odbiorcy konta: skrzynki Mail2SMS logujące się tym kontem i ustawienia SMTP, które je wskazują. */
  users(id: number): M365User[] {
    const users: M365User[] = this.deps.integrations.list()
      .filter(isMailIn)
      .filter((i) => i.config.imap.auth.mode === 'm365' && i.config.imap.auth.accountId === id)
      .map((i) => ({ kind: 'integration', id: i.id, name: i.name }));
    if (this.deps.notifications.smtp()?.m365AccountId === id) users.push({ kind: 'smtp' });
    return users;
  }

  private record(user: PanelUser, action: string, id: number, meta?: Record<string, unknown>): void {
    this.deps.audit.record({ actor: user.login, action, target: `m365:${id}`, ...(meta ? { meta } : {}) });
  }

  private prune(nowMs: number): void {
    for (const [state, login] of this.pending) if (login.expiresAt < nowMs) this.pending.delete(state);
  }

  private epoch(accountId: number): number {
    return this.epochs.get(accountId) ?? 0;
  }

  /** Porzuca logowania w toku, także te, które właśnie wymieniają kod. */
  private dropPending(accountId: number): void {
    for (const [state, login] of this.pending) if (login.accountId === accountId) this.pending.delete(state);
    this.epochs.set(accountId, this.epoch(accountId) + 1);
  }
}

type Identity = { loginName: string | null; loginOid: string | null };

/** To samo konto: równy `oid`, a gdy po którejś stronie go brak, równa nazwa logowania bez rozróżniania wielkości liter. */
function sameLogin(before: Identity, after: Identity): boolean {
  if (before.loginOid !== null && after.loginOid !== null) return before.loginOid === after.loginOid;
  return before.loginName !== null && after.loginName !== null && before.loginName.toLowerCase() === after.loginName.toLowerCase();
}

/** Nazwa bez spacji na brzegach, identyfikatory małymi literami; napis oznacza błąd do pokazania w formularzu. */
function normalize(input: M365AccountInput): M365AccountInput | string {
  const name = input.name.trim();
  const tenant = input.tenant.trim().toLowerCase();
  const clientId = input.clientId.trim().toLowerCase();
  if (name === '' || name.length > MAX_NAME) return `Nazwa konta jest wymagana i może zawierać do ${MAX_NAME} znaków`;
  if (!validTenant(tenant)) return 'Identyfikator katalogu musi być identyfikatorem GUID albo nazwą domeny, na przykład firma.onmicrosoft.com';
  if (!validClientId(clientId)) return 'Identyfikator aplikacji musi być identyfikatorem GUID z rejestracji aplikacji w Entra ID';
  return { name, tenant, clientId };
}
