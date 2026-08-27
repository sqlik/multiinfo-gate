import { randomBytes } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { authenticator } from 'otplib';

/** Nazwa ciasteczka sesji panelu. Token wskazuje wpis w `SessionStore` i w `FlashStore`. */
export const SESSION_COOKIE = 'mig_session';

const IDLE_TIMEOUT_MS = 8 * 3600_000;

export function hashPassword(plain: string): Promise<string> {
  return argonHash(plain);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hash, plain);
  } catch {
    return false;
  }
}

/** Dopuszczamy jedno okno wstecz i w przód, żeby drobny rozjazd zegara nie blokował logowania. */
authenticator.options = { window: 1 };

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

/** Adres `otpauth://`, który aplikacja uwierzytelniająca odczytuje z kodu graficznego. */
export function totpKeyuri(login: string, issuer: string, secret: string): string {
  return authenticator.keyuri(login, issuer, secret);
}

export function verifyTotp(secret: string, code: string): boolean {
  try {
    return authenticator.check(code.replace(/\s/g, ''), secret);
  } catch {
    return false;
  }
}

/** Alfabet bez znaków mylących się przy przepisywaniu z kartki: 0/O, 1/I/L. */
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Kody zapasowe do jednorazowego użycia, w postaci `XXXX-XXXX`.
 * Losowanie odrzuca bajty spoza pełnych wielokrotności alfabetu, żeby żaden
 * znak nie wypadał częściej od pozostałych.
 */
export function generateRecoveryCodes(count = 10): string[] {
  const limit = Math.floor(256 / RECOVERY_ALPHABET.length) * RECOVERY_ALPHABET.length;
  const codes = new Set<string>();

  while (codes.size < count) {
    let code = '';
    while (code.length < 8) {
      for (const byte of randomBytes(16)) {
        if (byte >= limit || code.length === 8) continue;
        code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
      }
    }
    codes.add(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return [...codes];
}

interface Session { userId: number; lastSeen: number }

/** Sesje żyją w pamięci procesu: restart wylogowuje, co dla panelu jest akceptowalne. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  create(userId: number): string {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, { userId, lastSeen: this.now() });
    return token;
  }

  get(token: string): number | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    const t = this.now();
    if (t - session.lastSeen > IDLE_TIMEOUT_MS) {
      this.sessions.delete(token);
      return null;
    }
    session.lastSeen = t;
    return session.userId;
  }

  destroy(token: string): void {
    this.sessions.delete(token);
  }

  /**
   * Zamyka sesje jednej osoby: po usunięciu konta albo resecie drugiego składnika wszystkie,
   * po zmianie hasła wszystkie poza bieżącą (`except`).
   */
  destroyForUser(userId: number, except?: string): void {
    for (const [token, session] of this.sessions) {
      if (session.userId === userId && token !== except) this.sessions.delete(token);
    }
  }
}
