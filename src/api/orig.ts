import type { AccountsRepo, AccountRow } from '../store/accounts.ts';
import { InvalidOrigError, validateOrig } from '../text/phone.ts';
import type { AuthContext } from './auth.ts';
import { ApiError } from './errors.ts';

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

  const dictionary = new Set(accounts.origs(auth.accountId));
  const fallback = auth.defaultOrig ?? account.defaultOrig;
  const allowed = new Set(auth.allowedOrigs.filter((o) => dictionary.has(o)));
  if (fallback) allowed.add(fallback);

  if (!allowed.has(input)) {
    const list = [...allowed].sort();
    throw new ApiError(403, 'orig_not_allowed', list.length === 0
      ? 'Ten klucz nie ma przypisanego żadnego nadpisu nadawcy. Pomiń pole orig albo poproś administratora bramki o przypisanie nadpisu uruchomionego przez Polkomtel.'
      : `Ten klucz może użyć nadpisu: ${list.join(', ')}.`);
  }
  return orig;
}
