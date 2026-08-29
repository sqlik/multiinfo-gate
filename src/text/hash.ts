import { createHash } from 'node:crypto';

/**
 * Skrót SHA-256 tekstu (UTF-8, szesnastkowo). Jedno miejsce, bo skrót treści odebranej
 * w bazie, w odczycie API i w wyczyszczonej dostawie ma być tym samym skrótem.
 */
export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
