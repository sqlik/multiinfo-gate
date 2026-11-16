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

/** Chwila przekazania: termin minus wyprzedzenie, nie wcześniej niż przyjęcie. */
export function handoverAt(startAt: string, createdAt: string): string {
  return new Date(Math.max(Date.parse(startAt) - HANDOVER_LEAD_MS, Date.parse(createdAt))).toISOString();
}

/** Termin musi przypadać po chwili przyjęcia i najwyżej `START_AT_MAX_MS` później. */
export function checkStartAt(startAt: Date, now: Date): void {
  if (startAt.getTime() <= now.getTime()) {
    throw new ApiError(400, 'start_at_in_past', 'Termin rozpoczęcia rozsyłki już minął.');
  }
  if (startAt.getTime() > now.getTime() + START_AT_MAX_MS) {
    throw new ApiError(400, 'start_at_too_far', 'Termin rozpoczęcia rozsyłki może przypadać najwyżej 30 dni od chwili wysyłki.');
  }
}
