// Tokeny sprawdzenia domeny skracacza. Panel wystawia token i pobiera go przez
// https://<domena>/.well-known/multiinfo-gate/<token>; poprawna odpowiedź potwierdza DNS, serwer
// pośredniczący, certyfikat i przypisanie domeny do tej bramki. Tokeny żyją wyłącznie w pamięci procesu.
import { randomBytes } from 'node:crypto';

const TOKEN_TTL_MS = 120_000;

export class DomainChecks {
  private readonly tokens = new Map<string, { domainId: number; expiresAt: number }>();

  get size(): number {
    return this.tokens.size;
  }

  issue(domainId: number, now: Date): string {
    for (const [token, entry] of this.tokens) if (entry.expiresAt <= now.getTime()) this.tokens.delete(token);
    const token = randomBytes(24).toString('base64url');
    this.tokens.set(token, { domainId, expiresAt: now.getTime() + TOKEN_TTL_MS });
    return token;
  }

  /** Token jest ważny przez 120 s i wyłącznie pod domeną, dla której powstał. */
  answer(token: string, now: Date, domainId: number): boolean {
    const entry = this.tokens.get(token);
    return entry !== undefined && entry.domainId === domainId && now.getTime() < entry.expiresAt;
  }
}
