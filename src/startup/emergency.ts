import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { emergencyPage, type StartupFailure } from '../admin/views/emergency.ts';
import type { AppConfig } from '../config/env.ts';
import type { InstallKind } from '../config/install.ts';
import type { Logger } from '../log.ts';
import type { RunningGate } from './running.ts';

export type { StartupFailure };

const publicPath = fileURLToPath(new URL('../admin/public', import.meta.url));

const API_MESSAGE = 'Bramka nie rozpoczęła pracy. Przyczynę i sposób jej usunięcia pokazuje panel bramki.';

/** Identyfikator zdarzenia: krótki, do przepisania z ekranu i odszukania w dzienniku. */
export const newIncidentId = (): string => randomBytes(4).toString('hex');

export interface EmergencyOptions {
  install: InstallKind | null;
  log: Logger;
  /** Wyjątek, który zatrzymał start; trafia wyłącznie do dziennika. */
  error?: unknown;
}

/**
 * Tryb awaryjny: oba porty odpowiadają 503, panel stroną przyczyny, API błędem w swoim kształcie.
 * Bez bazy, workera, odbiornika i kopii - nic nie trafia do Multiinfo ani do aplikacji. Proces
 * pracuje dalej, żeby przeglądarka pokazała przyczynę zamiast zerwanego połączenia.
 */
export async function startEmergency(config: AppConfig, failure: StartupFailure, opts: EmergencyOptions): Promise<RunningGate> {
  const page = emergencyPage(failure, opts.install);

  const panel = Fastify({ logger: false });
  // Trasy tylko dla istniejących plików: katalog (`/`, `/fonts/`) i każda inna ścieżka idą do strony przyczyny.
  panel.register(fastifyStatic, { root: publicPath, prefix: '/', index: false, wildcard: false });
  panel.get('/healthz', async (_request, reply) => reply.code(503).send({ status: 'unavailable' }));
  panel.setNotFoundHandler((_request, reply) => {
    reply.code(503).header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(page);
  });

  const api = Fastify({ logger: false });
  api.get('/healthz', async (_request, reply) => reply.code(503).send({
    status: 'unavailable', error: { code: 'unavailable', message: API_MESSAGE },
  }));
  api.setNotFoundHandler((request, reply) => {
    reply.code(503);
    if (request.url.startsWith('/hooks/')) return reply.send({ accepted: false, reason: 'unavailable' });
    return reply.send({ error: { code: 'unavailable', message: API_MESSAGE } });
  });

  try {
    await api.listen({ port: config.apiPort, host: config.apiHost });
    await panel.listen({ port: config.adminPort, host: config.adminHost });
  } catch (error) {
    await api.close();
    await panel.close();
    throw error;
  }

  const portOf = (address: string | { port: number } | null): number =>
    typeof address === 'object' && address !== null ? address.port : 0;
  const running: RunningGate = {
    apiPort: portOf(api.server.address()),
    adminPort: portOf(panel.server.address()),
    apiHost: config.apiHost,
    adminHost: config.adminHost,
    mode: 'emergency',
    reason: failure.reason,
    stop: async () => {
      await api.close();
      await panel.close();
      opts.log.info('bramka.zatrzymana');
    },
  };

  opts.log.error('bramka.awaria_startu', {
    reason: failure.reason, id: failure.id,
    api: `${running.apiHost}:${running.apiPort}`, panel: `${running.adminHost}:${running.adminPort}`,
    ...(opts.error === undefined ? {} : { error: opts.error }),
  });
  return running;
}
