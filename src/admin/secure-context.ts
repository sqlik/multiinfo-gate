import type { FastifyRequest } from 'fastify';
import { addressInList } from '../integrations/sources.ts';

/** Przeglądarki uznają pętlę zwrotną za kontekst bezpieczny także bez TLS. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1' || hostname.startsWith('127.') || hostname === '[::1]' || hostname === '::1';
}

/**
 * Czy żądanie przyszło w kontekście bezpiecznym: przez HTTPS (także za odwrotnym proxy)
 * albo pod adresem pętli zwrotnej, np. tunelem SSH. Decyduje nagłówek Host, nie adres nasłuchu -
 * tunel przez hosta Proxmox do adresu kontenera daje w przeglądarce 127.0.0.1 i przechodzi.
 * Tylko w takim kontekście przeglądarka przyjmie ciasteczko Secure. Podrobiony nagłówek szkodzi
 * wyłącznie podrabiającemu, dlatego /healthz korzysta z `healthDetailsAllowed`, a nie z tego predykatu.
 */
export function secureContext(request: FastifyRequest): boolean {
  if (request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https') return true;
  const host = request.headers.host ?? '';
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
  return isLoopbackHost(hostname);
}

/** Adres gniazda w pętli zwrotnej: 127.0.0.0/8, ::1 i odwzorowane `::ffff:127.x.x.x`. */
export function isLoopbackAddress(address: string): boolean {
  return address === '::1' || /^(::ffff:)?127\.\d+\.\d+\.\d+$/i.test(address);
}

/**
 * Czy /healthz panelu może podać szczegóły. Decyduje adres połączenia, ponieważ nagłówki Host
 * i X-Forwarded-Proto ustawia dowolny klient: pętla zwrotna (polecenie na tym samym hoście,
 * tunel SSH do kontenera) albo odwrotne proxy z MIG_TRUSTED_PROXIES, które przekazało żądanie HTTPS.
 */
export function healthDetailsAllowed(trustedProxies: string[]): (request: FastifyRequest) => boolean {
  return (request) => {
    const peer = request.socket.remoteAddress ?? '';
    if (isLoopbackAddress(peer)) return true;
    return request.headers['x-forwarded-proto'] === 'https' && addressInList(trustedProxies, peer);
  };
}
