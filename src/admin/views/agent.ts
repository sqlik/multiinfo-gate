import { SCOPE_LABELS } from '../../agents/scopes.ts';
import type { AgentScope } from '../../integrations/config.ts';
import { esc } from './layout.ts';
import { apiAddressPanel } from './settings.ts';

/**
 * Ostrzeżenie, gdy aplikacje z logowaniem nie połączą się z bramką: adres pusty albo bez `https://`. Odsyła do panelu
 * „Adres bramki dla aplikacji” na tej samej stronie (`gatewayAddressPanel`), bo panel nie prowadzi osobnej strony ustawień.
 */
export function gatewayAddressWarning(apiUrl: string | null, where: 'pod formularzem' | 'na dole strony'): string {
  if (apiUrl !== null && apiUrl.startsWith('https://')) return '';
  const link = `<a href="#adres-bramki">„Adres bramki dla aplikacji”</a>`;
  const text = apiUrl === null
    ? `Panel nie zna adresu bramki. Aplikacje z logowaniem, na przykład claude.ai i ChatGPT, wymagają adresu <code>https://</code> z domeną. Adres ustawisz w panelu ${link} ${where}.`
    : `Adres bramki <code>${esc(apiUrl)}</code> nie zaczyna się od <code>https://</code>. Aplikacje z logowaniem, na przykład claude.ai i ChatGPT, nie połączą się z bramką. Adres zmienisz w panelu ${link} ${where}.`;
  return `<div class="notice notice-wait">${text}</div>`;
}

/** Panel adresu bramki dla ostrzeżenia `gatewayAddressWarning`; pusty, gdy adres zaczyna się od `https://`. */
export function gatewayAddressPanel(apiUrl: string | null, back: string): string {
  if (apiUrl !== null && apiUrl.startsWith('https://')) return '';
  return `<div id="adres-bramki">${apiAddressPanel(apiUrl, back)}</div>`;
}

/** Zakresy słowami do szczegółów integracji, w stałej kolejności. */
export const scopesWords = (scopes: readonly AgentScope[]): string => scopes.map((s) => SCOPE_LABELS[s]).join(', ');
