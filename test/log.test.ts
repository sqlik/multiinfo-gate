import { describe, expect, it } from 'vitest';
import { createLogger, type LogLevel } from '../src/log.ts';

function capture(level: LogLevel) {
  const lines: string[] = [];
  const log = createLogger(level, (line) => lines.push(line), () => new Date('2026-08-26T12:00:00Z'));
  return { log, lines };
}

describe('createLogger', () => {
  it('zapisuje wiersz JSON z poziomem, czasem, komunikatem i polami', () => {
    const { log, lines } = capture('info');
    log.info('wysylka.ok', { messageId: 'msg_1', parts: 2 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      at: '2026-08-26T12:00:00.000Z', level: 'info', msg: 'wysylka.ok', messageId: 'msg_1', parts: 2,
    });
  });

  it('pomija wpisy poniżej ustawionego poziomu', () => {
    const { log, lines } = capture('warn');
    log.debug('szczegol');
    log.info('informacja');
    log.warn('ostrzezenie');
    log.error('blad');
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(['warn', 'error']);
  });

  it('poziom silent wycisza wszystko', () => {
    const { log, lines } = capture('silent');
    log.error('blad');
    expect(lines).toHaveLength(0);
  });

  it('zapisuje błąd jako komunikat i nazwę, bez stosu', () => {
    const { log, lines } = capture('error');
    log.error('worker.wyjatek', { error: new TypeError('coś poszło nie tak') });
    const entry = JSON.parse(lines[0]!);
    expect(entry.error).toEqual({ name: 'TypeError', message: 'coś poszło nie tak' });
    expect(lines[0]).not.toContain('at ');
  });
});
