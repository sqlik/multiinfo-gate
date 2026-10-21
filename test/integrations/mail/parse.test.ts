import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { htmlToPlain, parseMail } from '../../../src/integrations/mail/parse.ts';

const read = (name: string) => readFileSync(new URL(`../../fixtures/mail/${name}`, import.meta.url));

describe('parseMail', () => {
  it('zwykły tekst: nadawca, temat, treść, data ISO, Message-ID', async () => {
    const m = await parseMail(read('prosty-tekst.eml'));
    expect(m.from).toBe('jan@przyklad.test');
    expect(m.fromName).toBe('Jan Kowalski');
    expect(m.subject).toBe('Jutro przerwa serwisowa');
    expect(m.textFull).toContain('Serwer plików będzie niedostępny');
    expect(m.date).toMatch(/^2026-10-20T\d\d:\d\d:\d\d\.000Z$/);
    expect(m.date).toBe('2026-10-20T07:12:00.000Z');
    expect(m.messageId).toBe('<prosty-1@przyklad.test>');
    expect(m.to).toEqual(['bramka@przyklad.test']);
    expect(m.authResults).toEqual([]);
  });

  it('HTML z tabelą zamienia się na wiersze, bez odnośników i obrazków', async () => {
    const m = await parseMail(read('html-tabela-ups.eml'));
    expect(m.textFull).toMatch(/Device\s+UPS-01/);
    expect(m.textFull).toMatch(/Error code\s+E042/);
    expect(m.textFull).toContain('Szczegóły');
    expect(m.textFull).not.toContain('http');
    expect(m.textFull).not.toContain('<');
    expect(m.textFull).not.toContain('logo');
  });

  it('mail bez części tekstowej daje pustą treść, nie wyjątek', async () => {
    const m = await parseMail(read('tylko-zalacznik.eml'));
    expect(m.textFull).toBe('');
    expect(m.subject).toBe('Raport dysku');
  });

  it('nagłówek From zakodowany w RFC 2047 jest zdekodowany, adres małymi literami', async () => {
    const m = await parseMail(read('from-rfc2047.eml'));
    expect(m.from).toBe('tomek@przyklad.test');
    expect(m.fromName).toBe('Tomasz Sawko');
    expect(m.subject).toBe('Próba kodowania');
    expect(m.textFull).toContain('Treść próbna.');
  });

  it('zbiera wszystkie nagłówki Authentication-Results', async () => {
    const m = await parseMail(read('gmail-cytat.eml'));
    expect(m.authResults).toHaveLength(1);
    expect(m.authResults[0]).toContain('dkim=pass');
    const two = await parseMail(Buffer.from('Authentication-Results: a; spf=fail\r\nAuthentication-Results: b; dkim=pass\r\nFrom: x@przyklad.test\r\n\r\nt\r\n'));
    expect(two.authResults).toEqual(['a; spf=fail', 'b; dkim=pass']);
  });

  it('From z dwoma adresami zostaje pusty, bo takiego maila nie wysyła żaden program pocztowy', async () => {
    const src = Buffer.from('From: a@przyklad.test, b@przyklad.test\r\nSubject: x\r\nMessage-ID: <d@x>\r\n\r\ntreść\r\n');
    const m = await parseMail(src);
    expect(m.from).toBe('');
    expect(m.fromName).toBe('');
  });

  it('brak nagłówków daje puste pola i datę rozbioru', async () => {
    const now = new Date('2026-10-21T10:00:00Z');
    const m = await parseMail(Buffer.from('\r\nsama treść\r\n'), now);
    expect([m.from, m.subject, m.messageId, m.to, m.date]).toEqual(['', '', null, [], now.toISOString()]);
    expect(m.textFull).toBe('sama treść');
  });
});

describe('htmlToPlain', () => {
  it('więcej niż dwie puste linie z rzędu zamienia na dwie', () => {
    expect(htmlToPlain('<p>a</p><br><br><br><br><br><p>b</p>')).toBe('a\n\n\nb');
  });
});
