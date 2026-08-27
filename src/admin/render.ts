import type { FastifyRequest } from 'fastify';
import type { FlashStore, FlashTone } from './flash.ts';
import { navCounts, type NavCountsDeps } from './nav-counts.ts';
import { SESSION_COOKIE } from './session.ts';
import { layout, type NavKey } from './views/layout.ts';

export interface PageOptions {
  title: string;
  active: NavKey | null;
  body: string;
}

/** Wspólne rysowanie stron panelu: liczniki w nawigacji i jednorazowy komunikat. */
export interface Renderer {
  page(request: FastifyRequest, opts: PageOptions): string;
  flash(request: FastifyRequest, tone: FlashTone, text: string): void;
}

const tokenOf = (request: FastifyRequest): string => request.cookies[SESSION_COOKIE] ?? '';

export function createRenderer(deps: NavCountsDeps, store: FlashStore): Renderer {
  return {
    page(request, opts) {
      return layout({ ...opts, counts: navCounts(deps), flash: store.take(tokenOf(request)) });
    },
    flash(request, tone, text) {
      store.put(tokenOf(request), { tone, text });
    },
  };
}
