import { MultiinfoClient } from '../multiinfo/client.ts';
import type { AccountsRepo } from '../store/accounts.ts';

/**
 * Jeden klient na konto, żeby połączenia TLS i uzgodnienia certyfikatu
 * nie powtarzały się przy każdej wiadomości.
 */
export class ClientPool {
  private readonly pool = new Map<number, MultiinfoClient>();

  constructor(private readonly accounts: AccountsRepo, private readonly masterKey: Buffer) {}

  for(accountId: number): MultiinfoClient {
    const existing = this.pool.get(accountId);
    if (existing) return existing;

    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`Konto ${accountId} nie istnieje`);
    const secrets = this.accounts.getSecrets(accountId, this.masterKey);

    const client = new MultiinfoClient({
      baseUrl: account.baseUrl,
      login: account.login,
      password: secrets.password,
      certPem: secrets.certPem,
      keyPem: secrets.keyPem,
      caPem: secrets.caPem,
    });
    this.pool.set(accountId, client);
    return client;
  }

  /** Wywoływane po wymianie certyfikatu w panelu. */
  invalidate(accountId: number): void {
    this.pool.get(accountId)?.close();
    this.pool.delete(accountId);
  }

  closeAll(): void {
    for (const client of this.pool.values()) client.close();
    this.pool.clear();
  }
}
