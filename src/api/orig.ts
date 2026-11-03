import type { AccountsRepo, AccountRow } from '../store/accounts.ts';
import { InvalidOrigError, validateOrig } from '../text/phone.ts';
import type { AuthContext } from './auth.ts';
import { ApiError } from './errors.ts';

/**
 * Nadpisy, których klucz może użyć jawnie, w kolejności alfabetycznej, oraz nadpis domyślny
 * (klucza, a gdy go nie ma - konta). Z tej samej listy korzysta odmowa przy wysyłce i lista
 * wyboru w `GET /v1/key`, więc aplikacja widzi dokładnie to, co bramka przyjmie.
 */
export function keyOrigs(
  auth: AuthContext, account: AccountRow, accounts: AccountsRepo,
): { allowed: string[]; fallback: string | null } {
  const dictionary = new Set(accounts.origs(auth.accountId));
  const fallback = auth.defaultOrig ?? account.defaultOrig;
  const allowed = new Set(auth.allowedOrigs.filter((o) => dictionary.has(o)));
  if (fallback) allowed.add(fallback);
  return { allowed: [...allowed].sort(), fallback };
}

/**
 * Rozstrzyga nadpis nadawcy dla wiadomości i rozsyłek. Sprawdzamy tylko wartość podaną
 * jawnie. Wartości domyślne ustawia administrator w panelu, który pilnuje ich zgodności
 * ze słownikiem - gdyby obowiązywał je ten sam warunek, usunięcie wpisu unieruchomiłoby
 * klucze, które o nadpisie nic nie wiedzą.
 */
export function resolveOrig(
  input: string | undefined, auth: AuthContext, account: AccountRow, accounts: AccountsRepo,
): string | undefined {
  const orig = input ?? auth.defaultOrig ?? account.defaultOrig ?? undefined;
  if (input === undefined) return orig;

  try {
    validateOrig(input);
  } catch (e) {
    if (e instanceof InvalidOrigError) throw new ApiError(400, 'invalid_orig', e.message);
    throw e;
  }

  const { allowed: list } = keyOrigs(auth, account, accounts);
  if (!list.includes(input)) {
    throw new ApiError(403, 'orig_not_allowed', list.length === 0
      ? 'Ten klucz nie ma przypisanego żadnego nadpisu nadawcy. Pomiń pole orig albo poproś administratora bramki o przypisanie nadpisu uruchomionego przez Polkomtel.'
      : `Ten klucz może użyć nadpisu: ${list.join(', ')}.`);
  }
  return orig;
}
