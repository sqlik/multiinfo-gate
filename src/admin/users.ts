import type { AdminUsersRepo } from '../store/admin-users.ts';
import { hashPassword } from './session.ts';

/** Login trafia do dziennika zdarzeń i do adresu `otpauth://` - zostawiamy znaki bezpieczne w obu. */
const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

/** Dwanaście znaków to próg, poniżej którego hasło do panelu nie ma sensu. */
export const MIN_PASSWORD_LENGTH = 12;

export const LOGIN_RULE = 'od 3 do 32 znaków: małe litery, cyfry, kropka, myślnik lub podkreślenie';
export const PASSWORD_RULE = 'co najmniej dwanaście znaków';

/** Błąd danych od człowieka: formularz pokazuje treść przy polu, CLI wypisuje ją na stderr. */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserInputError';
  }
}

export function validateLogin(login: string): void {
  if (!LOGIN_PATTERN.test(login)) throw new UserInputError(`Nieprawidłowy login: ${LOGIN_RULE}.`);
}

export function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new UserInputError(`Hasło musi mieć ${PASSWORD_RULE}, podano ${password.length}.`);
  }
}

/** Wspólne dla CLI (pierwsze konto) i panelu (kolejne). Konto powstaje bez drugiego składnika. */
export async function createAdminUser(users: AdminUsersRepo, login: string, password: string): Promise<number> {
  validateLogin(login);
  validatePassword(password);
  if (users.findByLogin(login)) throw new UserInputError(`Konto o loginie ${login} już istnieje.`);
  return users.insert(login, await hashPassword(password));
}
