/**
 * Logowanie do skrzynki Mail2SMS kontem Microsoft 365: token dostępu tuż przed połączeniem albo przyczyna,
 * dla której łączenie nie ma sensu. Wspólne dla pollera i „Sprawdź połączenie”.
 */
import type { MailboxAuth } from '../integrations/mail/client.ts';
import type { M365AccountsRepo } from '../store/m365-accounts.ts';
import { M365AuthError } from './oauth.ts';
import type { M365Tokens } from './tokens.ts';

export interface M365MailboxDeps { tokens: Pick<M365Tokens, 'access'>; accounts: Pick<M365AccountsRepo, 'get'> }

export const ACCOUNT_NEEDS_LOGIN = 'Konto Microsoft 365 wymaga logowania';

/** Podpowiedź przy odmowie logowania XOAUTH2 mimo działającego tokenu (spec 6.3). */
export const M365_IMAP_REFUSED = 'Microsoft odrzucił logowanie do skrzynki. Najczęstszą przyczyną jest wyłączony IMAP na koncie albo brak dostępu konta do skrzynki współdzielonej';

export type M365MailboxAuth = { ok: true; auth: MailboxAuth } | { ok: false; kind: 'account' | 'network'; error: string };

/**
 * Konto nieistniejące, nowe albo wymagające logowania daje `account` bez wołania Microsoftu. Odrzucenie
 * tokenu odświeżania też daje `account`, a błąd sieci albo usługi Microsoftu daje `network`.
 */
export async function m365MailboxAuth(deps: M365MailboxDeps | undefined, accountId: number, now: Date): Promise<M365MailboxAuth> {
  const account = deps?.accounts.get(accountId);
  if (!deps || !account || account.state === 'new' || account.state === 'needs_login') {
    return { ok: false, kind: 'account', error: ACCOUNT_NEEDS_LOGIN };
  }
  try {
    const access = await deps.tokens.access(accountId, now);
    return { ok: true, auth: { kind: 'oauth2', accessToken: access.token } };
  } catch (e) {
    if (!(e instanceof M365AuthError)) throw e;
    return e.kind === 'needs_login' ? { ok: false, kind: 'account', error: ACCOUNT_NEEDS_LOGIN } : { ok: false, kind: 'network', error: e.message };
  }
}
