import { InvalidPhoneError, normalizeRecipient } from '../../text/phone.ts';
import { GROUP_LIMITS, type GroupMember, type SmsGroupConfig } from '../config.ts';

export type MemberLines = { ok: true; members: GroupMember[] } | { ok: false; error: string };

/** Najdłuższy wiersz listy: numer z odstępami i nazwa do 40 znaków mieszczą się z dużym zapasem. */
const MAX_LINE = 200;
/** Część numeru: cyfry, spacje, plusy, myślniki, nawiasy i kropki. */
const PHONE_PART = /^[\d\s+().-]+$/;

/**
 * Wiersz formularza: numer, a od pierwszej litery nazwa do końca wiersza. Podział po indeksie
 * pierwszej litery zamiast jednego wyrażenia z nakładającymi się powtórzeniami: wiersz z tysiącami
 * spacji nie blokuje procesu bramki. Wiersz, którego początek nie jest numerem, idzie w całości do
 * normalizacji, żeby komunikat mówił o numerze.
 */
function splitLine(line: string): [string, string] {
  const at = line.search(/\p{L}/u);
  if (at === -1) return [line, ''];
  const head = line.slice(0, at);
  return at > 0 && PHONE_PART.test(head) ? [head.trimEnd(), line.slice(at).trim()] : [line, ''];
}

/**
 * Lista członków z pola formularza, jeden numer w wierszu, po numerze opcjonalna nazwa.
 * Numery są normalizowane z kodem kraju konta, powtórzony numer znika razem z drugą nazwą.
 * Linia bez dopasowania idzie w całości do normalizacji, żeby komunikat mówił o numerze.
 */
export function parseMemberLines(raw: string, countryCode: string): MemberLines {
  const members: GroupMember[] = [];
  const seen = new Set<string>();
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  for (const [index, line] of lines.entries()) {
    if (line === '') continue;
    if (line.length > MAX_LINE) return { ok: false, error: `Wiersz ${index + 1} listy numerów ma więcej niż ${MAX_LINE} znaków.` };
    const [rawPhone, name] = splitLine(line);
    let phone: string;
    try {
      phone = normalizeRecipient(rawPhone, countryCode);
    } catch (e) {
      const reason = e instanceof InvalidPhoneError && e.reason ? `: ${e.reason}` : '';
      return { ok: false, error: `Numer „${line}” jest nieprawidłowy${reason}.` };
    }
    if (name.length > GROUP_LIMITS.name) return { ok: false, error: `Nazwa przy numerze ${phone} ma więcej niż ${GROUP_LIMITS.name} znaków.` };
    if (seen.has(phone)) continue;
    seen.add(phone);
    members.push({ phone, name });
  }
  return { ok: true, members };
}

/** Odwrotność `parseMemberLines` do formularza: `48601000001 Anna Nowak`, jeden w wierszu. */
export const memberLines = (members: GroupMember[]): string => members.map((m) => (m.name ? `${m.phone} ${m.name}` : m.phone)).join('\n');

/** Nadawca z listy właściwej dla trybu albo null, gdy numer nie ma prawa pisać. */
export function groupSender(config: SmsGroupConfig, from: string): GroupMember | null {
  const list = config.mode === 'closed' ? config.members : config.senders;
  return list.find((m) => m.phone === from) ?? null;
}

/** Odbiorcy jednego SMS-a: `lists` to cała lista odbiorców, `closed` to członkowie bez nadawcy; zawsze bez powtórzeń. */
export function groupRecipients(config: SmsGroupConfig, from: string): string[] {
  const phones = config.mode === 'closed' ? config.members.map((m) => m.phone).filter((p) => p !== from) : config.recipients.map((m) => m.phone);
  return [...new Set(phones)];
}
