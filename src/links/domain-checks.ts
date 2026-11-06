// Tokeny sprawdzenia domeny skracacza. Panel wystawia token i pobiera go przez
// https://<domena>/.well-known/multiinfo-gate/<token>; poprawna odpowiedź potwierdza DNS, serwer
// pośredniczący, certyfikat i przypisanie domeny do tej bramki. Tokeny żyją wyłącznie w pamięci procesu.
import { randomBytes } from 'node:crypto';

const TOKEN_TTL_MS = 120_000;

export class DomainChecks {
  private readonly tokens = new Map<string, { domainId: number; expiresAt: number; untrustedProxy: string | null }>();

  get size(): number {
    return this.tokens.size;
  }

  issue(domainId: number, now: Date): string {
    for (const [token, entry] of this.tokens) if (entry.expiresAt <= now.getTime()) this.tokens.delete(token);
    const token = randomBytes(24).toString('base64url');
    this.tokens.set(token, { domainId, expiresAt: now.getTime() + TOKEN_TTL_MS, untrustedProxy: null });
    return token;
  }

  /**
   * Token jest ważny przez 120 s i wyłącznie pod domeną, dla której powstał. `untrustedProxy` to adres
   * serwera pośredniczącego, któremu bramka nie ufa (MIG_TRUSTED_PROXIES), jeżeli żądanie przyszło przez taki serwer.
   */
  answer(token: string, now: Date, domainId: number, untrustedProxy: string | null = null): boolean {
    const entry = this.tokens.get(token);
    const valid = entry !== undefined && entry.domainId === domainId && now.getTime() < entry.expiresAt;
    if (valid) entry.untrustedProxy = untrustedProxy;
    return valid;
  }

  /** Serwer pośredniczący bez zaufania, przez który przyszło udane pobranie tokenu; null bez takiego serwera. */
  untrustedProxy(token: string): string | null {
    return this.tokens.get(token)?.untrustedProxy ?? null;
  }
}
