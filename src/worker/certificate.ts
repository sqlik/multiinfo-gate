import type { Logger } from '../log.ts';
import type { ProviderError } from '../multiinfo/response.ts';
import type { AccountsRepo } from '../store/accounts.ts';
import type { ClientPool } from './clients.ts';

export interface CertificatePauseDeps { accounts: AccountsRepo; clients: ClientPool }

/**
 * Multiinfo odrzuciło certyfikat konta (kody -80..-86): wstrzymujemy całe konto i wyrzucamy
 * klienta z puli, żeby po wymianie certyfikatu w panelu powstał nowy. Jedno miejsce dla
 * wysyłki, odpytywania, rozsyłek i odbioru - reakcja ma być wszędzie ta sama.
 */
export function pauseForCertificate(deps: CertificatePauseDeps, accountId: number, error: ProviderError, log: Logger): string {
  const reason = `Certyfikat odrzucony przez Multiinfo, kod ${error.code}: ${error.message}`;
  deps.accounts.pause(accountId, reason);
  deps.clients.invalidate(accountId);
  log.error('konto.wstrzymane', { accountId, code: error.code, reason: error.message });
  return reason;
}
