import { ProviderError } from '../multiinfo/response.ts';
import { pauseForCertificate } from './certificate.ts';
import { silentLogger } from '../log.ts';
import { combineStatuses, describeSubstatus, isFinal, mapStatus, type GatewayStatus } from '../multiinfo/status.ts';
import type { Job } from '../store/jobs.ts';
import { notify, type WorkerDeps } from './send.ts';

/** Odstępy kolejnych pytań o status, liczone od poprzedniego pytania. */
export const POLL_SCHEDULE_MS = [
  10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000,
] as const;

/** Po wyczerpaniu harmonogramu pytamy co dwie godziny. */
export const POLL_TAIL_MS = 2 * 3600_000;

/** Stany ostateczne zgłaszane odbiorcy webhooka jako `message.failed`. */
const FAILURE_STATUSES = new Set<GatewayStatus>(['failed', 'blocked', 'expired', 'cancelled']);

/** Po tym czasie od terminu ważności przestajemy czekać na status. */
const GIVE_UP_AFTER_VALID_TO_MS = 2 * 3600_000;

/**
 * Wiadomość bez terminu ważności: po tylu dniach od przekazania bez statusu ostatecznego
 * kończymy ją jako przedawnioną. Multiinfo trzyma wiadomość najwyżej 72 godziny, więc
 * siedem dni to margines na opóźniony raport, a nie na wieczne odpytywanie co dwie godziny.
 */
export const POLL_GIVE_UP_MS = 7 * 86_400_000;

export async function handlePoll(job: Job, deps: WorkerDeps, now: Date): Promise<void> {
  const log = deps.log ?? silentLogger;
  const messageId = String(job.payload.messageId);
  const message = deps.messages.get(messageId);
  if (!message || message.miIds.length === 0) {
    deps.jobs.complete(job.id);
    return;
  }

  if (message.validTo) {
    const deadline = Date.parse(message.validTo) + GIVE_UP_AFTER_VALID_TO_MS;
    if (now.getTime() > deadline) {
      const description = 'Termin ważności minął, a Multiinfo nie zwróciło statusu ostatecznego.';
      deps.messages.setStatus(messageId, { status: 'expired', error: description, finalAt: now });
      deps.jobs.complete(job.id);
      deps.events.record(messageId, now, 'expired', description);
      notify(deps, message, 'message.failed', { status: 'expired', to: message.dest, error: description }, now);
      return;
    }
  }

  const client = deps.clients.for(message.accountId);
  const perPart: Array<{ status: GatewayStatus; miStatus: number; miSubstatus: number }> = [];

  for (const miId of message.miIds) {
    try {
      const info = await client.info(miId);
      perPart.push({
        status: mapStatus(info.status, info.substatus),
        miStatus: info.status,
        miSubstatus: info.substatus,
      });
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'certificate') {
        pauseForCertificate(deps, message.accountId, error, log);
      } else {
        log.warn('status.blad_odczytu', { messageId, miId, error });
      }
      // Nie udało się odczytać części - spróbujemy całości ponownie w kolejnej turze.
      deps.jobs.retry(job.id, nextRun(job, now), error instanceof Error ? error.message : String(error));
      return;
    }
  }

  const combined = combineStatuses(perPart.map((p) => p.status));
  // Do zapisu bierzemy część, która przesądziła o wyniku całości.
  const decisive = perPart.find((p) => p.status === combined) ?? perPart[0]!;
  // Status spoza słownika jest ostateczny wedle numeru, ale nie wiemy, co znaczy -
  // pytamy dalej, zamiast zamykać wiadomość wynikiem, którego nie umiemy nazwać.
  const allFinal = perPart.every((p) => p.status !== 'unknown' && isFinal(p.miStatus));

  // Zdarzenie tylko przy zmianie - pytamy wielokrotnie, a przebieg ma pokazywać przejścia.
  if (decisive.miStatus !== message.miStatus || decisive.miSubstatus !== message.miSubstatus) {
    deps.events.record(messageId, now, 'status',
      `status ${decisive.miStatus} / ${decisive.miSubstatus} - ${describeSubstatus(decisive.miStatus, decisive.miSubstatus)}`);
  }

  // Bez statusu ostatecznego po tygodniu od przekazania przestajemy pytać: ostatnia
  // odczytana para status/substatus zostaje przy wiadomości jako ślad.
  const sentAt = message.sentAt === null ? null : Date.parse(message.sentAt);
  if (!allFinal && sentAt !== null && now.getTime() - sentAt > POLL_GIVE_UP_MS) {
    const description = 'Multiinfo nie zwróciło statusu ostatecznego w ciągu siedmiu dni od przekazania.';
    deps.messages.setStatus(messageId, {
      status: 'expired', miStatus: decisive.miStatus, miSubstatus: decisive.miSubstatus, error: description, finalAt: now,
    });
    deps.jobs.complete(job.id);
    deps.events.record(messageId, now, 'expired', description);
    notify(deps, message, 'message.failed', { status: 'expired', to: message.dest, error: description }, now);
    log.warn('status.porzucony', { messageId, miStatus: decisive.miStatus, miSubstatus: decisive.miSubstatus });
    return;
  }

  // Wiadomość anulowana przez API czeka na status ostateczny Multiinfo; stan pośredni
  // (Plus jeszcze nie przetworzył cancelsms.aspx) nie może jej cofnąć do „sent”.
  const holdCancelled = message.status === 'cancelled' && !allFinal;
  if (!holdCancelled) {
    deps.messages.setStatus(messageId, {
      status: combined,
      miStatus: decisive.miStatus,
      miSubstatus: decisive.miSubstatus,
      error: combined === 'failed' || combined === 'blocked'
        ? describeSubstatus(decisive.miStatus, decisive.miSubstatus)
        : null,
      ...(allFinal ? { finalAt: now } : {}),
    });
  }

  if (allFinal) {
    deps.jobs.complete(job.id);
    log.info('status.ostateczny', { messageId, status: combined, miStatus: decisive.miStatus, miSubstatus: decisive.miSubstatus });
    // „sent” bez raportu doręczenia został już zgłoszony przy przekazaniu; „unknown” nie kończy wiadomości.
    const event = combined === 'delivered' ? 'message.delivered'
      : FAILURE_STATUSES.has(combined) ? 'message.failed' : null;
    if (event) {
      notify(deps, message, event, {
        status: combined, to: message.dest, miStatus: decisive.miStatus, miSubstatus: decisive.miSubstatus,
        error: combined === 'delivered' ? null : describeSubstatus(decisive.miStatus, decisive.miSubstatus),
      }, now);
    }
    return;
  }
  deps.jobs.retry(job.id, nextRun(job, now), '');
}

function nextRun(job: Job, now: Date): Date {
  const delay = POLL_SCHEDULE_MS[job.attempts + 1] ?? POLL_TAIL_MS;
  return new Date(now.getTime() + delay);
}
