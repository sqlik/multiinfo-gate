import { randomBytes } from 'node:crypto';

/** Sesja ery poprzedniej: połączenie, uzgodniona wersja i obsługa widoków zadeklarowana przy `initialize`. */
export interface McpSession { id: string; connectionId: number; apps: boolean; protocolVersion: string; lastSeen: number }

const IDLE_MS = 8 * 3_600_000;
const MAX_SESSIONS = 10_000;

/**
 * Sesje w pamięci procesu. Po ponownym uruchomieniu bramki nieznana sesja daje 404, a aplikacja według
 * specyfikacji zaczyna nową. Mapa zachowuje kolejność użycia, więc ponad limit ustępuje sesja najdawniej używana.
 */
export class McpSessions {
  private readonly sessions = new Map<string, McpSession>();
  private readonly idleMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: { idleMs?: number; max?: number; now?: () => number } = {}) {
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.max = opts.max ?? MAX_SESSIONS;
    this.now = opts.now ?? (() => Date.now());
  }

  create(connectionId: number, apps: boolean, protocolVersion: string): McpSession {
    while (this.sessions.size >= this.max) this.sessions.delete(this.sessions.keys().next().value!);
    const session: McpSession = { id: randomBytes(16).toString('hex'), connectionId, apps, protocolVersion, lastSeen: this.now() };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Sesja tego samego połączenia w terminie; użycie przedłuża ją i przesuwa na koniec kolejki. */
  get(id: string, connectionId: number): McpSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const now = this.now();
    if (now - session.lastSeen >= this.idleMs) {
      this.sessions.delete(id);
      return undefined;
    }
    if (session.connectionId !== connectionId) return undefined;
    session.lastSeen = now;
    this.sessions.delete(id);
    this.sessions.set(id, session);
    return session;
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }
}
