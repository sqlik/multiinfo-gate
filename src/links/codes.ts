// Kody krótkich linków: 7 znaków z [A-Za-z0-9], losowane kryptograficznie.
import { randomInt as cryptoRandomInt } from 'node:crypto';

export const CODE_LENGTH = 7;
/** Kod w szablonie treści; ma długość kodu prawdziwego, więc pomiar szablonu odpowiada treści końcowej. */
export const PLACEHOLDER_CODE = '0000000';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CODE = /^[A-Za-z0-9]{7}$/;

export function newCode(randomInt: (max: number) => number = (max) => cryptoRandomInt(max)): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

export function isCode(value: string): boolean {
  return CODE.test(value);
}
