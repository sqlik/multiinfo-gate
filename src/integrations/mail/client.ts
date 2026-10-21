import { ImapFlow } from 'imapflow';
import type { MailboxErrorKind } from '../../store/mail-in.ts';
import type { MailSecurity } from '../config.ts';

export interface MailboxSettings { host: string; port: number; security: MailSecurity; verifyCert: boolean; user: string; password: string }
export interface MailMeta { uid: number; size: number; messageId: string | null }

/** Sesja ze skrzynką: wszystko, czego poller i „Sprawdź połączenie” potrzebują od IMAP. Testy podstawiają podróbkę. */
export interface MailboxSession {
  folders(): Promise<string[]>;
  open(folder: string): Promise<{ uidValidity: number; uidNext: number; unseen: number }>;
  /** UID-y nieprzeczytanych większe niż `uidFrom`, rosnąco. */
  unseen(uidFrom: number): Promise<number[]>;
  meta(uids: number[]): Promise<MailMeta[]>;
  source(uid: number): Promise<Buffer>;
  markSeen(uid: number): Promise<void>;
  /** Przenosi do folderu; brakujący folder tworzy. */
  move(uid: number, folder: string): Promise<void>;
  /** \Deleted plus EXPUNGE tego jednego UID. */
  remove(uid: number): Promise<void>;
  close(): Promise<void>;
}
export type MailboxConnect = (settings: MailboxSettings, timeoutMs: number) => Promise<MailboxSession>;

export class MailboxError extends Error {
  constructor(public readonly kind: MailboxErrorKind, message: string) {
    super(message);
    this.name = 'MailboxError';
  }
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'EAI_AGAIN', 'EPIPE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED']);

/** Rodzaj awarii na podstawie błędu z imapflow albo z gniazda; `other`, gdy nie wiadomo. */
export function errorKindOf(e: unknown): MailboxErrorKind {
  if (e instanceof MailboxError) return e.kind;
  if (typeof e !== 'object' || e === null) return 'other';
  const err = e as { code?: unknown; authenticationFailed?: unknown; responseStatus?: unknown; command?: unknown; responseText?: unknown; message?: unknown };
  if (err.authenticationFailed === true) return 'auth';
  const command = typeof err.command === 'string' ? err.command.toUpperCase() : '';
  if (err.responseStatus === 'NO' && (command === 'LOGIN' || command === 'AUTHENTICATE')) return 'auth';
  const code = typeof err.code === 'string' ? err.code : '';
  if (NETWORK_CODES.has(code) || code.startsWith('CERT_') || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SOCKET')) return 'network';
  const text = typeof err.responseText === 'string' ? err.responseText : '';
  if (/mailbox|folder/i.test(text)) return 'folder';
  if (/timeout|timed out/i.test(typeof err.message === 'string' ? err.message : '') || code === 'ETIMEOUT') return 'network';
  return 'other';
}

/** Komunikat błędu z odpowiedzią serwera, gdy imapflow ją ma (jego własny tekst to zwykle ogólne „Command failed”). */
const CODE_WORDS: Record<string, string> = {
  DEPTH_ZERO_SELF_SIGNED_CERT: 'certyfikat serwera nie pochodzi od zaufanego urzędu (własny certyfikat); dla serwera w sieci wewnętrznej wyłącz sprawdzanie certyfikatu w trybie zaawansowanym',
  SELF_SIGNED_CERT_IN_CHAIN: 'certyfikat serwera nie pochodzi od zaufanego urzędu (własny certyfikat); dla serwera w sieci wewnętrznej wyłącz sprawdzanie certyfikatu w trybie zaawansowanym',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certyfikat serwera nie pochodzi od zaufanego urzędu (własny certyfikat); dla serwera w sieci wewnętrznej wyłącz sprawdzanie certyfikatu w trybie zaawansowanym',
  CERT_HAS_EXPIRED: 'certyfikat serwera wygasł',
  ERR_TLS_CERT_ALTNAME_INVALID: 'certyfikat serwera jest wystawiony na inną nazwę niż wpisana',
  ECONNREFUSED: 'serwer odrzucił połączenie na tym porcie',
  ENOTFOUND: 'nazwa serwera nie istnieje w DNS',
  EAI_AGAIN: 'nazwa serwera nie istnieje w DNS',
  ETIMEDOUT: 'serwer nie odpowiada w zadanym czasie',
  EHOSTUNREACH: 'serwer jest nieosiągalny z maszyny bramki',
  ECONNRESET: 'serwer zerwał połączenie',
};

export function errorMessageOf(e: unknown): string {
  const code = typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : '';
  if (CODE_WORDS[code]) return `${CODE_WORDS[code]} (${code})`;
  const message = e instanceof Error ? e.message : String(e);
  const response = typeof e === 'object' && e !== null && typeof (e as { responseText?: unknown }).responseText === 'string' ? (e as { responseText: string }).responseText.trim() : '';
  return response === '' ? message : `${message}: ${response}`;
}

const ERROR_CHARS = 300;

/** Komunikat błędu bez sekretów (hasło, login), bez znaków sterujących, ucięty do 300 znaków. */
export function scrubError(message: string, secrets: string[]): string {
  let out = message.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f]/g, '');
  for (const s of secrets) if (s !== '') out = out.split(s).join('***');
  // Spec 12: komunikat serwera bez żadnych adresów e-mail (login już zdjęty wyżej, inne adresy też nie są potrzebne).
  out = out.replace(/[^\s@<>"'()]+@[^\s@<>"'()]+/g, '***');
  return out.length > ERROR_CHARS ? `${out.slice(0, ERROR_CHARS - 1)}…` : out;
}

const WATCHDOG_MS = 60_000;

/** Foldery, które da się otworzyć: bez `\Noselect` (u Gmaila kontener `[Gmail]`). */
export function selectableFolders(list: Array<{ path: string; flags: Set<string> }>): string[] {
  return list.filter((m) => !m.flags.has('\\Noselect')).map((m) => m.path);
}

/** Połączenie z prawdziwym serwerem przez imapflow; po `connect()` sesja jest zalogowana. */
export const imapConnect: MailboxConnect = async (settings, timeoutMs) => {
  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: settings.security === 'tls',
    doSTARTTLS: settings.security === 'starttls',
    tls: { rejectUnauthorized: settings.verifyCert },
    auth: { user: settings.user, pass: settings.password },
    logger: false,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: WATCHDOG_MS,
  });
  await client.connect();
  const uidOf = (uid: number): string => String(uid);
  return {
    async folders() {
      const list = await client.list();
      return selectableFolders(list);
    },
    async open(folder) {
      const box = await client.mailboxOpen(folder);
      const status = await client.status(folder, { unseen: true });
      return { uidValidity: Number(box.uidValidity), uidNext: box.uidNext, unseen: status === false ? 0 : status.unseen ?? 0 };
    },
    async unseen(uidFrom) {
      const found = await client.search({ seen: false, uid: `${uidFrom + 1}:*` }, { uid: true });
      // Zakres `n:*` obejmuje też ostatni mail, gdy n przekracza najwyższy UID; filtr to zdejmuje.
      return (Array.isArray(found) ? found : []).filter((uid) => uid > uidFrom).sort((a, b) => a - b);
    },
    async meta(uids) {
      if (uids.length === 0) return [];
      const out: MailMeta[] = [];
      for await (const m of client.fetch(uids.map(uidOf).join(','), { uid: true, size: true, envelope: true }, { uid: true })) {
        out.push({ uid: m.uid, size: m.size ?? 0, messageId: m.envelope?.messageId ?? null });
      }
      return out;
    },
    async source(uid) {
      const result = await client.download(uidOf(uid), undefined, { uid: true });
      if (!('content' in result) || !result.content) throw new MailboxError('other', `Serwer nie zwrócił treści maila UID ${uid}.`);
      const chunks: Buffer[] = [];
      for await (const chunk of result.content) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      return Buffer.concat(chunks);
    },
    async markSeen(uid) {
      await client.messageFlagsAdd(uidOf(uid), ['\\Seen'], { uid: true });
    },
    async move(uid, folder) {
      const attempt = async (): Promise<boolean> => (await client.messageMove(uidOf(uid), folder, { uid: true })) !== false;
      try {
        if (await attempt()) return;
      } catch (e) {
        if (errorKindOf(e) !== 'folder') throw e;
      }
      await client.mailboxCreate(folder);
      if (!(await attempt())) throw new MailboxError('folder', `Serwer odrzucił przeniesienie do folderu ${folder}.`);
    },
    async remove(uid) {
      await client.messageDelete(uidOf(uid), { uid: true });
    },
    async close() {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
  };
};
