import { addWarsawDays } from '../time/warsaw.ts';
import { ApiError } from './errors.ts';

/**
 * Bramka przekazuje zaplanowaną rozsyłkę do Multiinfo tyle przed terminem, a termin przekazuje dalej.
 * Próba z 2026-11-16 potwierdziła, że Multiinfo uruchamia rozsyłkę z terminem punktualnie.
 */
export const HANDOVER_LEAD_MS = 10 * 60_000;
/** Rozsyłka, której bramka nie przekazała w tym czasie od terminu, czeka na decyzję administratora. */
export const OVERDUE_AFTER_MS = 60 * 60_000;
/** Najdalszy termin rozpoczęcia rozsyłki liczony od chwili przyjęcia. */
export const START_AT_MAX_MS = 30 * 86_400_000;
/** Bliższy termin względem chwili przekazania oznacza wysyłkę natychmiastową, bez terminu po stronie Multiinfo. */
export const MI_START_MARGIN_MS = 60_000;
/** Czas przyjmowania rozsyłki przez Multiinfo na odbiorcę, około 50 s dla 5000 odbiorców. */
export const MI_START_MARGIN_PER_RECIPIENT_MS = 10;

/** Margines terminu rozsyłki: minuta i czas, w którym Multiinfo przyjmuje listę odbiorców, do 110 s przy 5000. */
export function miStartMarginMs(recipients: number): number {
  return MI_START_MARGIN_MS + recipients * MI_START_MARGIN_PER_RECIPIENT_MS;
}

/** Zdanie o oknie anulowania dla panelu, API, konektora i widoków; bez wyprzedzenia anulowanie trwa do terminu. */
export const CANCEL_WINDOW_TEXT = HANDOVER_LEAD_MS > 0
  ? `Anulowanie jest możliwe do chwili przekazania rozsyłki do Multiinfo, zwykle ${HANDOVER_LEAD_MS / 60_000} minut przed terminem`
  : 'Anulowanie jest możliwe do terminu rozpoczęcia rozsyłki';

/** Chwila przekazania: termin minus wyprzedzenie, nie wcześniej niż przyjęcie. */
export function handoverAt(startAt: string, createdAt: string): string {
  return new Date(Math.max(Date.parse(startAt) - HANDOVER_LEAD_MS, Date.parse(createdAt))).toISOString();
}

/**
 * Termin musi przypadać po chwili przyjęcia i najwyżej 30 dni później. Granica obejmuje zarówno 30 dób, jak i tę samą
 * godzinę czasu polskiego po 30 dniach, która przez jesienną zmianę czasu przypada godzinę dalej.
 */
export function checkStartAt(startAt: Date, now: Date): void {
  if (startAt.getTime() <= now.getTime()) {
    throw new ApiError(400, 'start_at_in_past', 'Termin rozpoczęcia rozsyłki już minął.');
  }
  const limit = Math.max(now.getTime() + START_AT_MAX_MS, addWarsawDays(now, START_AT_MAX_MS / 86_400_000).getTime());
  if (startAt.getTime() > limit) {
    throw new ApiError(400, 'start_at_too_far', 'Termin rozpoczęcia rozsyłki może przypadać najwyżej 30 dni od chwili wysyłki.');
  }
}
