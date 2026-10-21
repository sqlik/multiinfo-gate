import { convert } from 'html-to-text';
import { simpleParser, type AddressObject } from 'mailparser';

/** Mail rozebrany do postaci, na której pracuje potok skrzynki: bez załączników, bez HTML. */
export interface ParsedMail {
  /** Adres z nagłówka `From` małymi literami; pusty, gdy brak albo więcej niż jeden adres. */
  from: string;
  fromName: string;
  subject: string;
  /** Część tekstowa albo HTML zamieniony na tekst; pusty, gdy maila nie da się przeczytać jako tekst. */
  textFull: string;
  /** ISO 8601; gdy nagłówka `Date` brak, chwila rozbioru. */
  date: string;
  to: string[];
  messageId: string | null;
  /** Każdy nagłówek `Authentication-Results` w całości, w kolejności z maila. */
  authResults: string[];
  /** Mail automatyczny (RFC 3834): autoresponder, urządzenie, lista dyskusyjna; bramka na taki nie odpisuje. */
  auto: boolean;
}

/** HTML na tekst: tabele jako wiersze, odnośniki bez adresów, obrazki pominięte, najwyżej dwie puste linie z rzędu. */
export function htmlToPlain(html: string): string {
  const text = convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'table', format: 'dataTable' },
    ],
  });
  return text.replace(/\n{4,}/g, '\n\n\n').trim();
}

const addressesOf = (value: AddressObject | AddressObject[] | undefined): Array<{ address: string; name: string }> => {
  const objects = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return objects.flatMap((o) => o.value).filter((a) => typeof a.address === 'string' && a.address !== '').map((a) => ({ address: a.address!.toLowerCase(), name: a.name ?? '' }));
};

const headerText = (value: unknown): string => (Array.isArray(value) ? value.map(String).join(' ') : value === undefined ? '' : String(value)).trim().toLowerCase();

/** Czy mail jest automatyczny: `Auto-Submitted` inne niż `no`, `Precedence` bulk/list/junk/auto_reply, `List-Id` albo `X-Auto-Response-Suppress`. */
function isAutomatic(headers: Map<string, unknown>): boolean {
  const auto = headerText(headers.get('auto-submitted'));
  if (auto !== '' && auto !== 'no') return true;
  if (/^(bulk|list|junk|auto_reply)\b/.test(headerText(headers.get('precedence')))) return true;
  // mailparser składa nagłówki List-* pod jednym kluczem `list`.
  if (headers.has('list-id') || headers.has('list')) return true;
  return headers.has('x-auto-response-suppress');
}

export async function parseMail(source: Buffer, now: Date = new Date()): Promise<ParsedMail> {
  const mail = await simpleParser(source, { skipHtmlToText: true, skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const from = addressesOf(mail.from);
  const textFull = typeof mail.text === 'string' && mail.text.trim() !== ''
    ? mail.text.trim()
    : typeof mail.html === 'string' && mail.html !== '' ? htmlToPlain(mail.html) : '';
  const rawAuth = mail.headers.get('authentication-results') as unknown;
  const authResults = (Array.isArray(rawAuth) ? rawAuth : rawAuth === undefined ? [] : [rawAuth]).map((h) => String(h));
  return {
    from: from.length === 1 ? from[0]!.address : '',
    fromName: from.length === 1 ? from[0]!.name : '',
    subject: mail.subject ?? '',
    textFull,
    date: mail.date instanceof Date && !Number.isNaN(mail.date.getTime()) ? mail.date.toISOString() : now.toISOString(),
    to: addressesOf(mail.to).map((a) => a.address),
    messageId: mail.messageId ?? null,
    authResults,
    auto: isAutomatic(mail.headers as Map<string, unknown>),
  };
}
