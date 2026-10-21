import { MailboxError, type MailboxConnect, type MailboxSession } from '../../src/integrations/mail/client.ts';

export interface FakeMessage { uid: number; seen: boolean; source: string; folder: string; size: number }

/** Skrzynka w pamięci o kontrakcie `MailboxSession`; `move` zmienia folder wpisu bez zmiany UID. */
export class FakeMailbox {
  uidValidity: number;
  password: string;
  failConnect: Error | null;
  rejectMove = false;
  /** Opóźnienie każdego połączenia; do testu, że wisząca skrzynka nie blokuje innych. */
  delayMs = 0;
  readonly calls: string[] = [];
  private readonly folderSet: Set<string>;
  private readonly items: FakeMessage[] = [];

  constructor(opts: { uidValidity?: number; password?: string; folders?: string[]; failConnect?: Error } = {}) {
    this.uidValidity = opts.uidValidity ?? 1;
    this.password = opts.password ?? 'p';
    this.failConnect = opts.failConnect ?? null;
    this.folderSet = new Set(opts.folders ?? ['INBOX']);
  }

  add(m: { uid: number; seen: boolean; source: string; folder?: string; size?: number }): void {
    this.items.push({ uid: m.uid, seen: m.seen, source: m.source, folder: m.folder ?? 'INBOX', size: m.size ?? Buffer.byteLength(m.source) });
    this.folderSet.add(m.folder ?? 'INBOX');
  }

  messages(folder: string): FakeMessage[] {
    return this.items.filter((m) => m.folder === folder).sort((a, b) => a.uid - b.uid);
  }

  unsee(uid: number): void {
    const m = this.items.find((i) => i.uid === uid);
    if (m) m.seen = false;
  }

  /** Odtworzenie folderu u dostawcy: nowa UIDVALIDITY, te same maile pod nowymi UID (od 1). */
  resetUidValidity(n: number): void {
    this.uidValidity = n;
    this.items.sort((a, b) => a.uid - b.uid).forEach((m, i) => { m.uid = i + 1; });
  }

  get uidNext(): number {
    return this.items.reduce((max, m) => Math.max(max, m.uid), 0) + 1;
  }

  session(): MailboxSession {
    const need = (uid: number): FakeMessage => {
      const m = this.items.find((i) => i.uid === uid);
      if (!m) throw new MailboxError('other', `brak maila UID ${uid}`);
      return m;
    };
    let current = 'INBOX';
    return {
      folders: async () => { this.calls.push('folders'); return [...this.folderSet]; },
      open: async (folder) => {
        this.calls.push(`open:${folder}`);
        if (!this.folderSet.has(folder)) throw new MailboxError('folder', `Mailbox does not exist: ${folder}`);
        current = folder;
        return { uidValidity: this.uidValidity, uidNext: this.uidNext, unseen: this.messages(folder).filter((m) => !m.seen).length };
      },
      unseen: async (uidFrom) => this.messages(current).filter((m) => !m.seen && m.uid > uidFrom).map((m) => m.uid),
      meta: async (uids) => uids.map((uid) => {
        const m = need(uid);
        const id = /^Message-ID:\s*(<[^>]+>)/im.exec(m.source);
        return { uid, size: m.size, messageId: id ? id[1]! : null };
      }),
      source: async (uid) => { this.calls.push(`source:${uid}`); return Buffer.from(need(uid).source); },
      markSeen: async (uid) => { this.calls.push(`markSeen:${uid}`); need(uid).seen = true; },
      move: async (uid, folder) => {
        this.calls.push(`move:${uid}:${folder}`);
        if (this.rejectMove) throw new MailboxError('folder', `Serwer odrzucił przeniesienie do folderu ${folder}.`);
        this.folderSet.add(folder);
        need(uid).folder = folder;
      },
      remove: async (uid) => {
        this.calls.push(`remove:${uid}`);
        const i = this.items.findIndex((m) => m.uid === uid);
        if (i >= 0) this.items.splice(i, 1);
      },
      close: async () => { this.calls.push('close'); },
    };
  }
}

export const fakeConnect = (box: FakeMailbox): MailboxConnect => async (settings) => {
  box.calls.push('connect');
  if (box.delayMs > 0) await new Promise((r) => setTimeout(r, box.delayMs));
  if (box.failConnect) throw box.failConnect;
  if (settings.password !== box.password) throw new MailboxError('auth', 'LOGIN failed: Authentication failed.');
  return box.session();
};
