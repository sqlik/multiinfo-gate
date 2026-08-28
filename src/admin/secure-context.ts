import type { FastifyRequest } from 'fastify';

/** Przeglądarki uznają pętlę zwrotną za kontekst bezpieczny także bez TLS. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1' || hostname.startsWith('127.') || hostname === '[::1]' || hostname === '::1';
}

/**
 * Czy żądanie przyszło w kontekście bezpiecznym: przez HTTPS (także za odwrotnym proxy)
 * albo pod adresem pętli zwrotnej, np. tunelem SSH. Decyduje nagłówek Host, nie adres nasłuchu -
 * tunel przez hosta Proxmox do adresu kontenera daje w przeglądarce 127.0.0.1 i przechodzi.
 * Tylko w takim kontekście przeglądarka przyjmie ciasteczko Secure, a panel podaje szczegóły
 * (np. w /healthz) tylko tam, gdzie da się też zalogować.
 */
export function secureContext(request: FastifyRequest): boolean {
  if (request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https') return true;
  const host = request.headers.host ?? '';
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
  return isLoopbackHost(hostname);
}
