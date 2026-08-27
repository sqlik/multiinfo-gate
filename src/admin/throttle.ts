/** Tyle nieudanych prób z jednego adresu w oknie blokuje kolejne. */
export const LOGIN_MAX_FAILURES = 10;

/** Okno liczone od ostatniej nieudanej próby; po nim licznik znika. */
export const LOGIN_WINDOW_MS = 15 * 60_000;

interface Entry { failures: number; lastAt: number }

/**
 * Hamulec zgadywania hasła i kodu jednorazowego, liczony na adres nadawcy.
 * Stan żyje w pamięci procesu, jak sesje - restart zdejmuje blokadę, co przy
 * panelu na pętli zwrotnej albo za tunelem jest akceptowalne. Argon2 sam
 * spowalnia zgadywanie hasła; kodu sześciocyfrowego nie spowalnia nic innego.
 */
export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  allowed(ip: string): boolean {
    const entry = this.entries.get(ip);
    if (!entry) return true;
    if (this.now() - entry.lastAt > LOGIN_WINDOW_MS) {
      this.entries.delete(ip);
      return true;
    }
    return entry.failures < LOGIN_MAX_FAILURES;
  }

  fail(ip: string): void {
    const t = this.now();
    const entry = this.entries.get(ip);
    if (!entry || t - entry.lastAt > LOGIN_WINDOW_MS) {
      this.entries.set(ip, { failures: 1, lastAt: t });
      return;
    }
    entry.failures += 1;
    entry.lastAt = t;
  }

  reset(ip: string): void {
    this.entries.delete(ip);
  }
}
