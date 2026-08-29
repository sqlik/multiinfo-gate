import { createHmac } from 'node:crypto';
import { silentLogger } from '../log.ts';
import { PRIVATE_TARGET_MESSAGE, systemResolver, webhookTarget } from '../net/private-address.ts';
import type { Job } from '../store/jobs.ts';
import type { WorkerDeps } from './send.ts';

export type WebhookEvent = 'message.sent' | 'message.delivered' | 'message.failed' | 'package.completed' | 'message.received';

/** Tyle z zależności workera, ile trzeba do zakolejkowania dostawy - korzysta też odbiornik. */
export type WebhookEmitDeps = Pick<WorkerDeps, 'apiKeys' | 'deliveries' | 'jobs'>;

export interface EmitOptions {
  /** Wiadomość przychodząca, której dotyczy dostawa - do śladu w panelu i plakietki. */
  inboundId?: string;
  /** Po zakończeniu dostawy zastąpić treść skrótem (konto bez przechowywania treści). */
  scrubAfter?: boolean;
}

export type HttpPost = (
  url: string, headers: Record<string, string>, body: string,
) => Promise<{ status: number; body: string }>;

/** Ponowienia z §6.3: 1 min, 5 min, 15 min, 1 h, 6 h. */
export const WEBHOOK_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000] as const;

const REQUEST_TIMEOUT_MS = 10_000;

/** Tyle odpowiedzi odbiorcy zachowujemy do diagnozy. */
const RESPONSE_CHARS = 300;

/** `sha256=` + HMAC-SHA256 z sekretu po `<znacznik czasu>.<body>`. */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Bez podążania za przekierowaniami - podpisane body ma trafić dokładnie pod zapisany adres. */
export const httpPost: HttpPost = async (url, headers, body) => {
  const res = await fetch(url, {
    method: 'POST', headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'manual',
  });
  return { status: res.status, body: (await res.text()).slice(0, RESPONSE_CHARS) };
};

/** Zapisuje dostawę i zadanie. Klucz bez adresu webhooka nic nie dostaje. */
export function emitWebhook(
  deps: WebhookEmitDeps, apiKeyId: number, event: WebhookEvent, payload: Record<string, unknown>, now: Date,
  opts: EmitOptions = {},
): number | null {
  const key = deps.apiKeys.get(apiKeyId);
  if (!key?.webhookUrl) return null;
  const body = JSON.stringify({ event, at: now.toISOString(), ...payload });
  const id = deps.deliveries.insert({
    apiKeyId, event, payload: body, url: key.webhookUrl, createdAt: now,
    inboundId: opts.inboundId ?? null, scrubAfter: opts.scrubAfter === true,
  });
  deps.jobs.enqueue('webhook', { deliveryId: id }, now);
  return id;
}

export async function handleWebhook(job: Job, deps: WorkerDeps, now: Date): Promise<void> {
  const log = deps.log ?? silentLogger;
  const delivery = deps.deliveries.get(Number(job.payload.deliveryId));
  if (!delivery || delivery.status !== 'pending') {
    deps.jobs.complete(job.id);
    return;
  }

  const secret = deps.apiKeys.webhookSecret(delivery.apiKeyId);
  if (secret === null) {
    deps.deliveries.markFailed(delivery.id, 'klucz nie ma już sekretu webhooka');
    deps.jobs.complete(job.id);
    return;
  }

  // Cel sprawdzamy przy każdej dostawie, nie tylko przy zapisie adresu: nazwa mogła zacząć
  // wskazywać sieć wewnętrzną później. Nazwa bez adresu to awaria sieci - ponawiamy.
  const target = await webhookTarget(delivery.url, deps.resolve ?? systemResolver);
  if (target.kind === 'private' && !deps.allowPrivateWebhooks) {
    deps.deliveries.markFailed(delivery.id, `${PRIVATE_TARGET_MESSAGE} (${target.address})`);
    deps.jobs.complete(job.id);
    log.warn('webhook.odmowa_sieci_wewnetrznej', { deliveryId: delivery.id, event: delivery.event, address: target.address });
    return;
  }
  if (target.kind === 'unresolved') {
    const response = `nazwa nie rozwiązuje się: ${target.reason}`;
    const delay = WEBHOOK_BACKOFF_MS[job.attempts];
    if (delay === undefined) {
      deps.deliveries.markFailed(delivery.id, response);
        deps.jobs.complete(job.id);
      log.warn('webhook.nieudany', { deliveryId: delivery.id, event: delivery.event, response });
      return;
    }
    deps.deliveries.markRetry(delivery.id, new Date(now.getTime() + delay), response);
    deps.jobs.retry(job.id, new Date(now.getTime() + delay), response);
    return;
  }

  const timestamp = Math.floor(now.getTime() / 1000);
  const headers = {
    'Content-Type': 'application/json',
    'X-MIG-Event': delivery.event,
    'X-MIG-Timestamp': String(timestamp),
    'X-MIG-Signature': signWebhook(secret, timestamp, delivery.payload),
  };

  let outcome: { status: number; body: string } | null = null;
  let failure = '';
  try {
    outcome = await (deps.post ?? httpPost)(delivery.url, headers, delivery.payload);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }

  if (outcome && outcome.status >= 200 && outcome.status < 300) {
    deps.deliveries.markDelivered(delivery.id, now, `${outcome.status} ${outcome.body}`);
    deps.jobs.complete(job.id);
    log.info('webhook.dostarczony', { deliveryId: delivery.id, event: delivery.event, attempt: job.attempts + 1 });
    return;
  }

  const response = outcome ? `${outcome.status} ${outcome.body}` : failure;
  // 4xx to decyzja odbiorcy - ponawianie nic nie zmieni. 5xx i awarie sieci ponawiamy.
  const permanent = outcome !== null && outcome.status >= 400 && outcome.status < 500;
  const delay = WEBHOOK_BACKOFF_MS[job.attempts];
  if (permanent || delay === undefined) {
    deps.deliveries.markFailed(delivery.id, response);
    deps.jobs.complete(job.id);
    log.warn('webhook.nieudany', { deliveryId: delivery.id, event: delivery.event, response: response.slice(0, 120) });
    return;
  }
  deps.deliveries.markRetry(delivery.id, new Date(now.getTime() + delay), response);
  deps.jobs.retry(job.id, new Date(now.getTime() + delay), response);
}
