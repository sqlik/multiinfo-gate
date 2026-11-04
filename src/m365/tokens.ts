/**
 * Dostawca tokenów dostępu kont Microsoft 365 (spec 5.4). Token dostępu żyje wyłącznie w pamięci,
 * token odświeżania wyłącznie zaszyfrowany w bazie. Jedno odświeżenie naraz na konto: równoległe
 * odpytania skrzynek i wysyłka maila czekają na tę samą obietnicę.
 */
import type { Logger } from '../log.ts';
import type { AdminNotifier } from '../notifications/rules.ts';
import type { M365AccountRow, M365AccountsRepo } from '../store/m365-accounts.ts';
import { M365AuthError, hintFor, refreshTokens, type TokenFetch, type TokenSet } from './oauth.ts';

/** Token dostępu odświeżany, gdy do wygaśnięcia zostało mniej niż tyle. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface M365Access { token: string; address: string }

export interface M365TokensDeps { accounts: M365AccountsRepo; fetch: TokenFetch; notifier?: AdminNotifier; log?: Logger }

export class M365Tokens {
  private readonly cache = new Map<number, { token: string; expiresAt: Date }>();
  private readonly inflight = new Map<number, Promise<M365Access>>();

  constructor(private readonly deps: M365TokensDeps) {}

  /** Rzuca M365AuthError: 'needs_login' bez wołania Microsoftu, gdy konto jest new albo needs_login. */
  access(accountId: number, now: Date): Promise<M365Access> {
    const account = this.deps.accounts.get(accountId);
    if (!account) return Promise.reject(new M365AuthError('needs_login', null, 'Konto Microsoft 365 nie istnieje'));
    if (account.state === 'new' || account.state === 'needs_login') {
      return Promise.reject(new M365AuthError('needs_login', account.errorCode, 'Konto Microsoft 365 wymaga logowania'));
    }
    const cached = this.cache.get(accountId);
    if (cached && cached.expiresAt.getTime() - now.getTime() >= REFRESH_MARGIN_MS) {
      return Promise.resolve({ token: cached.token, address: account.address ?? '' });
    }
    let pending = this.inflight.get(accountId);
    if (!pending) {
      pending = this.refresh(account, now).finally(() => this.inflight.delete(accountId));
      this.inflight.set(accountId, pending);
    }
    return pending;
  }

  remember(accountId: number, set: TokenSet): void {
    this.cache.set(accountId, { token: set.accessToken, expiresAt: set.expiresAt });
  }

  forget(accountId: number): void {
    this.cache.delete(accountId);
  }

  private async refresh(account: M365AccountRow, now: Date): Promise<M365Access> {
    const used = this.deps.accounts.refreshToken(account.id);
    if (used === null) {
      throw this.fail(account, new M365AuthError('needs_login', null, 'Konto Microsoft 365 nie zawiera tokenu odświeżania'), now);
    }
    let set: TokenSet;
    try {
      set = await refreshTokens(this.deps.fetch, { tenant: account.tenant, clientId: account.clientId, refreshToken: used }, now);
    } catch (err) {
      const e = err instanceof M365AuthError ? err : new M365AuthError('error', null, 'Nieoczekiwany błąd odświeżania tokenu');
      if (this.replaced(account.id, used)) throw stale();
      throw this.fail(account, e, now);
    }
    // Rozłączenie, ponowne logowanie albo zmiana aplikacji w trakcie odświeżania: wynik należy do starego uprawnienia.
    if (this.replaced(account.id, used)) throw stale();
    this.deps.accounts.refreshed(account.id, set.refreshToken, now);
    this.remember(account.id, set);
    return { token: set.accessToken, address: this.deps.accounts.get(account.id)?.address ?? account.address ?? '' };
  }

  private replaced(accountId: number, used: string): boolean {
    return this.deps.accounts.refreshToken(accountId) !== used;
  }

  /** Zapisuje awarię; przy `needs_login` jedno powiadomienie na awarię, kluczem jest jej początek. */
  private fail(account: M365AccountRow, e: M365AuthError, now: Date): M365AuthError {
    this.deps.accounts.failed(account.id, { state: e.kind, code: e.code, message: e.message }, now);
    this.forget(account.id);
    this.deps.log?.warn(e.kind === 'needs_login' ? 'konto Microsoft 365 wymaga logowania' : 'odświeżenie tokenu Microsoft 365 nieudane', {
      account: account.id, code: e.code, error: e.message,
    });
    if (e.kind !== 'needs_login') return e;
    const row = this.deps.accounts.get(account.id);
    if (!row || row.notifiedAt !== null || row.errorSince === null || !this.deps.notifier) return e;
    this.deps.notifier.notify('m365_disconnected', `m365:${account.id}`, `${account.name}: ${hintFor(e.code)}`, now,
      `m365:${account.id}:${row.errorSince}`);
    this.deps.accounts.markNotified(account.id, now);
    return e;
  }
}

function stale(): M365AuthError {
  return new M365AuthError('error', null, 'Konto Microsoft 365 zmieniło się w trakcie odświeżania tokenu');
}
