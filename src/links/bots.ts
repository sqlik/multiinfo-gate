// Rozpoznawanie wejść automatów: podglądów linków w komunikatorach, skanerów poczty, wstępnego pobierania
// i pobrań bez nagłówków, które wysyła każda przeglądarka.
// Automat również otrzymuje przekierowanie, ale nie jest liczony jako otwarcie.

/**
 * Fragmenty nagłówka `User-Agent` znanych pobieraczy podglądów i skanerów, małymi literami.
 * Lista zawiera pełne nazwy, a nie samo „bot”, ponieważ „bot” występuje też w nazwach modeli telefonów.
 */
const AUTOMATED_AGENTS = [
  'facebookexternalhit', // Facebook, Messenger, podgląd w Wiadomościach Apple
  'facebot',
  'meta-externalagent',
  'twitterbot',
  'whatsapp',
  'telegrambot',
  'slackbot',
  'slack-imgproxy',
  'discordbot',
  'linkedinbot',
  'skypeuripreview', // Microsoft Teams i Skype
  'microsoftpreview',
  'bingpreview',
  'bingbot',
  'googlebot',
  'google-safety',
  'applebot',
  'proofpoint',
  'mimecast',
  'barracuda',
  'headlesschrome',
  'python-requests',
  'python-urllib',
  'curl/',
  'wget/',
  'go-http-client',
  'okhttp',
  'apache-httpclient',
] as const;

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string {
  const value = headers[name];
  return (Array.isArray(value) ? value.join(' ') : (value ?? '')).toLowerCase();
}

export function isAutomated(method: string, headers: Headers): boolean {
  if (method.toUpperCase() === 'HEAD') return true;
  if (header(headers, 'purpose').includes('prefetch')) return true;
  if (header(headers, 'sec-purpose').includes('prefetch')) return true;
  if (header(headers, 'x-moz').includes('prefetch')) return true;
  if (header(headers, 'x-purpose').includes('preview')) return true;
  const agent = header(headers, 'user-agent').trim();
  if (agent === '') return true;
  // Każda przeglądarka używana przez człowieka wysyła Accept-Language. Serwer Google, który pobiera podgląd
  // linku dla Wiadomości Google, podaje User-Agent zwykłego Chrome, ale tego nagłówka nie wysyła.
  if (header(headers, 'accept-language').trim() === '') return true;
  return AUTOMATED_AGENTS.some((fragment) => agent.includes(fragment));
}
