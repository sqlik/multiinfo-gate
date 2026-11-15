import { describe, expect, it } from 'vitest';
import { McpSessions } from '../../src/mcp/sessions.ts';

const HOUR = 3_600_000;

describe('sesje MCP ery poprzedniej', () => {
  it('sesja należy do połączenia: inne połączenie i nieznany identyfikator dają undefined', () => {
    let now = 1_000;
    const sessions = new McpSessions({ now: () => now });
    const s = sessions.create(7, true, '2025-11-25');
    expect(s).toMatchObject({ connectionId: 7, apps: true, protocolVersion: '2025-11-25', lastSeen: 1_000 });
    expect(s.id).toMatch(/^[0-9a-f]{32}$/);
    now = 5_000;
    expect(sessions.get(s.id, 7)).toMatchObject({ id: s.id, lastSeen: 5_000 });
    expect(sessions.get(s.id, 8)).toBeUndefined();
    expect(sessions.get('nieznana', 7)).toBeUndefined();
    sessions.remove(s.id);
    expect(sessions.get(s.id, 7)).toBeUndefined();
  });

  it('sesja wygasa po 8 godzinach bezczynności, a użycie przedłuża ją', () => {
    let now = 0;
    const sessions = new McpSessions({ now: () => now });
    const s = sessions.create(1, false, '2025-06-18');
    now = 7 * HOUR;
    expect(sessions.get(s.id, 1)).toBeDefined();
    now = 15 * HOUR - 1;
    expect(sessions.get(s.id, 1)).toBeDefined();
    now = 23 * HOUR;
    expect(sessions.get(s.id, 1)).toBeUndefined();
  });

  it('ponad 20 sesji jednego połączenia ustępuje najstarsza sesja tego połączenia, sesje innych zostają', () => {
    let now = 0;
    const sessions = new McpSessions({ now: () => now });
    const other = sessions.create(2, false, '2025-11-25');
    const own = Array.from({ length: 20 }, () => { now += 1; return sessions.create(1, false, '2025-11-25'); });
    now += 1;
    sessions.get(own[0]!.id, 1);
    now += 1;
    const extra = sessions.create(1, false, '2025-11-25');
    expect(sessions.get(other.id, 2)).toBeDefined();
    expect(sessions.get(own[0]!.id, 1)).toBeDefined();
    expect(sessions.get(own[1]!.id, 1)).toBeUndefined();
    expect(sessions.get(extra.id, 1)).toBeDefined();
    expect(own.slice(2).every((s) => sessions.get(s.id, 1) !== undefined)).toBe(true);
  });

  it('ponad limit sesji ustępuje najdawniej używana', () => {
    let now = 0;
    const sessions = new McpSessions({ max: 2, now: () => now });
    const a = sessions.create(1, false, '2025-11-25');
    now = 1;
    const b = sessions.create(2, false, '2025-11-25');
    now = 2;
    sessions.get(a.id, 1);
    now = 3;
    const c = sessions.create(3, false, '2025-11-25');
    expect(sessions.get(a.id, 1)).toBeDefined();
    expect(sessions.get(b.id, 2)).toBeUndefined();
    expect(sessions.get(c.id, 3)).toBeDefined();
  });
});
