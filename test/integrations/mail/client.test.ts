import { describe, expect, it } from 'vitest';
import { MailboxError, errorKindOf, scrubError } from '../../../src/integrations/mail/client.ts';
import { FakeMailbox, fakeConnect } from '../../helpers/fake-mailbox.ts';

const settings = { host: 'h', port: 993, security: 'tls' as const, verifyCert: true, user: 'u', password: 'p' };

describe('scrubError', () => {
  it('usuwa hasło i login z komunikatu serwera', () => {
    expect(scrubError('LOGIN failed for bramka@x.pl with Tajne123', ['Tajne123', 'bramka@x.pl'])).toBe('LOGIN failed for *** with ***');
  });
  it('pomija puste sekrety, ucina długie komunikaty i znaki sterujące', () => {
    expect(scrubError('x', ['', 'x'])).toBe('***');
    expect(scrubError(`a\r\nb${'c'.repeat(400)}`, []).length).toBeLessThanOrEqual(300);
    expect(scrubError('a\r\nb', [])).toBe('a b');
  });
});

describe('errorKindOf', () => {
  it('rozpoznaje logowanie, sieć i folder', () => {
    expect(errorKindOf(new MailboxError('auth', 'x'))).toBe('auth');
    expect(errorKindOf(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe('network');
    expect(errorKindOf(Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }))).toBe('network');
    expect(errorKindOf(Object.assign(new Error('x'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }))).toBe('network');
    expect(errorKindOf(Object.assign(new Error('x'), { authenticationFailed: true }))).toBe('auth');
    expect(errorKindOf(Object.assign(new Error('x'), { responseStatus: 'NO', command: 'LOGIN' }))).toBe('auth');
    expect(errorKindOf(Object.assign(new Error('x'), { responseText: 'Mailbox does not exist' }))).toBe('folder');
    expect(errorKindOf(new Error('cokolwiek'))).toBe('other');
    expect(errorKindOf('napis')).toBe('other');
  });
});

describe('FakeMailbox', () => {
  it('open, unseen od progu, meta, source, markSeen, move tworzy folder, remove', async () => {
    const box = new FakeMailbox({ uidValidity: 7 });
    box.add({ uid: 1, seen: true, source: 'Subject: a\r\n\r\nx' });
    box.add({ uid: 2, seen: false, source: 'Message-ID: <b@x>\r\nSubject: b\r\n\r\ny' });
    box.add({ uid: 3, seen: false, source: 'Subject: c\r\n\r\nz' });
    const s = await fakeConnect(box)(settings, 1000);
    expect(await s.open('INBOX')).toEqual({ uidValidity: 7, uidNext: 4, unseen: 2 });
    expect(await s.unseen(1)).toEqual([2, 3]);
    expect(await s.unseen(0)).toEqual([2, 3]);
    expect(await s.unseen(3)).toEqual([]);
    expect(await s.meta([2])).toEqual([{ uid: 2, size: expect.any(Number), messageId: '<b@x>' }]);
    expect(await s.meta([3])).toEqual([{ uid: 3, size: expect.any(Number), messageId: null }]);
    expect((await s.source(3)).toString()).toContain('Subject: c');
    await s.markSeen(2);
    expect(box.messages('INBOX').find((m) => m.uid === 2)?.seen).toBe(true);
    await s.move(3, 'Przetworzone');
    expect(await s.folders()).toContain('Przetworzone');
    await s.remove(2);
    await s.close();
    expect(box.messages('INBOX').map((m) => m.uid)).toEqual([1]);
    expect(box.messages('Przetworzone').map((m) => m.uid)).toEqual([3]);
    expect(box.calls).toEqual(expect.arrayContaining(['connect', 'open:INBOX', 'source:3', 'markSeen:2', 'move:3:Przetworzone', 'remove:2', 'close']));
  });
  it('błąd logowania, gdy hasło nie pasuje; failConnect rzuca podany błąd; nieznany folder to błąd folder', async () => {
    const box = new FakeMailbox({ password: 'dobre' });
    await expect(fakeConnect(box)({ ...settings, password: 'złe' }, 1000)).rejects.toBeInstanceOf(MailboxError);
    await expect(fakeConnect(box)({ ...settings, password: 'złe' }, 1000)).rejects.toMatchObject({ kind: 'auth' });
    box.password = 'złe';
    const s = await fakeConnect(box)({ ...settings, password: 'złe' }, 1000);
    await expect(s.open('Niema')).rejects.toMatchObject({ kind: 'folder' });
    box.failConnect = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    await expect(fakeConnect(box)({ ...settings, password: 'złe' }, 1000)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
  it('unsee, resetUidValidity, rejectMove i size nadpisany', async () => {
    const box = new FakeMailbox({ uidValidity: 7 });
    box.add({ uid: 5, seen: true, source: 'Subject: a\r\n\r\nx', size: 3 * 1024 * 1024 });
    box.unsee(5);
    const s = await fakeConnect(box)(settings, 1000);
    await s.open('INBOX');
    expect(await s.unseen(0)).toEqual([5]);
    expect((await s.meta([5]))[0]?.size).toBe(3 * 1024 * 1024);
    box.rejectMove = true;
    await expect(s.move(5, 'X')).rejects.toMatchObject({ kind: 'folder' });
    box.resetUidValidity(8);
    expect(await s.open('INBOX')).toMatchObject({ uidValidity: 8 });
  });
});
