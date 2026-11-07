// Tokeny sprawdzenia domeny skracacza. Panel wystawia token i pobiera go przez
// https://<domena>/.well-known/multiinfo-gate/<token>; poprawna odpowiedź potwierdza DNS, serwer
// pośredniczący, certyfikat i przypisanie domeny do tej bramki. Tokeny żyją wyłącznie w pamięci procesu.
import { randomBytes } from 'node:crypto';

const TOKEN_TTL_MS = 120_000;

export class DomainChecks {
  private readonly tokens = new Map<string, { domainId: number; expiresAt: number; answered: boolean; untrustedProxy: string | null }>();

  get size(): number {
    return this.tokens.size;
  }

  issue(domainId: number, now: Date): string {
    for (const [token, entry] of this.tokens) if (entry.expiresAt <= now.getTime()) this.tokens.delete(token);
    const token = randomBytes(24).toString('base64url');
    this.tokens.set(token, { domainId, expiresAt: now.getTime() + TOKEN_TTL_MS, answered: false, untrustedProxy: null });
    return token;
  }

  /**
   * Token jest ważny przez 120 s, wyłącznie pod domeną, dla której powstał, i odpowiada tylko raz. `untrustedProxy`
   * to adres serwera pośredniczącego, któremu bramka nie ufa (MIG_TRUSTED_PROXIES), jeżeli żądanie przyszło przez taki serwer.
   */
  answer(token: string, now: Date, domainId: number, untrustedProxy: string | null = null): boolean {
    const entry = this.tokens.get(token);
    const valid = entry !== undefined && !entry.answered && entry.domainId === domainId && now.getTime() < entry.expiresAt;
    if (valid) {
      entry.answered = true;
      entry.untrustedProxy = untrustedProxy;
    }
    return valid;
  }

  /**
   * Wynik po pobraniu tokenu przez panel: czy odpowiedział serwer przekierowań tej bramki i przez jaki serwer
   * pośredniczący bez zaufania. Odczyt usuwa token, dlatego tę samą odpowiedź można wykorzystać tylko raz.
   */
  take(token: string): { answered: boolean; untrustedProxy: string | null } {
    const entry = this.tokens.get(token);
    this.tokens.delete(token);
    return { answered: entry?.answered === true, untrustedProxy: entry?.untrustedProxy ?? null };
  }
}
