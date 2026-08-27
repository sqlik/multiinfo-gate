export type FlashTone = 'ok' | 'warn' | 'fail';

export interface Flash {
  tone: FlashTone;
  text: string;
}

/**
 * Komunikat pokazywany raz, na pierwszej stronie po przekierowaniu.
 * Żyje w pamięci procesu pod tokenem sesji - jak same sesje. Restart bramki
 * gubi niepokazany komunikat; przy jednym panelu to akceptowalne.
 */
export class FlashStore {
  private readonly items = new Map<string, Flash>();

  put(sessionToken: string, flash: Flash): void {
    this.items.set(sessionToken, flash);
  }

  take(sessionToken: string): Flash | null {
    const flash = this.items.get(sessionToken) ?? null;
    this.items.delete(sessionToken);
    return flash;
  }
}
