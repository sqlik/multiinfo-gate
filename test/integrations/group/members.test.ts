import { describe, expect, it } from 'vitest';
import { defaultSmsGroupConfig } from '../../../src/integrations/config.ts';
import { groupRecipients, groupSender, memberLines, parseMemberLines } from '../../../src/integrations/group/members.ts';

describe('parseMemberLines', () => {
  it('czyta numer i nazwę, normalizuje i usuwa powtórzenia', () => {
    expect(parseMemberLines('601 000 001 Ania Kowalska\n+48 601 000 002\n0601000001 Ania\n\n48601000003 Basia', '48')).toEqual({ ok: true, members: [
      { phone: '48601000001', name: 'Ania Kowalska' }, { phone: '48601000002', name: '' }, { phone: '48601000003', name: 'Basia' },
    ] });
  });
  it('zły numer wraca zdaniem z numerem', () => {
    const out = parseMemberLines('601 000 001\n12 Jan', '48');
    expect(out).toMatchObject({ ok: false });
    expect((out as { error: string }).error).toContain('„12 Jan”');
  });
  it('zły numer z przyczyną wraca zdaniem z przyczyną', () => {
    const out = parseMemberLines('4848601000001 Ania', '48');
    expect((out as { error: string }).error).toContain('podwojony');
  });
  it('nazwa dłuższa niż 40 znaków to błąd', () => {
    expect(parseMemberLines(`601000001 ${'a'.repeat(41)}`, '48')).toMatchObject({ ok: false, error: expect.stringContaining('40') });
  });
  it('pusty tekst to pusta lista', () => {
    expect(parseMemberLines('\n  \n', '48')).toEqual({ ok: true, members: [] });
  });
  it('memberLines odtwarza linie z nazwą i bez', () => {
    expect(memberLines([{ phone: '48601000001', name: 'Ania' }, { phone: '48601000002', name: '' }])).toBe('48601000001 Ania\n48601000002');
  });
});

describe('groupSender i groupRecipients', () => {
  it('w obu trybach; grupa zamknięta bez nadawcy, jedyny członek bez odbiorców', () => {
    const lists = { ...defaultSmsGroupConfig(), senders: [{ phone: '48601000001', name: 'Ania' }], recipients: ['48601000002', '48601000003', '48601000002'] };
    expect(groupSender(lists, '48601000001')).toEqual({ phone: '48601000001', name: 'Ania' });
    expect(groupSender(lists, '48601000002')).toBeNull();
    expect(groupRecipients(lists, '48601000001')).toEqual(['48601000002', '48601000003']);
    const closed = { ...defaultSmsGroupConfig(), mode: 'closed' as const, members: [{ phone: '48601000001', name: '' }, { phone: '48601000002', name: '' }, { phone: '48601000001', name: 'dubel' }] };
    expect(groupRecipients(closed, '48601000001')).toEqual(['48601000002']);
    expect(groupRecipients({ ...closed, members: [closed.members[0]!] }, '48601000001')).toEqual([]);
    expect(groupSender(closed, '48601000002')).toEqual({ phone: '48601000002', name: '' });
    expect(groupSender(closed, '48601000009')).toBeNull();
  });
  it('tryb lists nie czyta członków, a closed nie czyta nadawców', () => {
    const mixed = { ...defaultSmsGroupConfig(), senders: [{ phone: '48601000001', name: '' }], recipients: ['48601000002'], members: [{ phone: '48601000005', name: '' }, { phone: '48601000006', name: '' }] };
    expect(groupSender(mixed, '48601000005')).toBeNull();
    expect(groupSender({ ...mixed, mode: 'closed' }, '48601000001')).toBeNull();
    expect(groupRecipients({ ...mixed, mode: 'closed' }, '48601000005')).toEqual(['48601000006']);
  });
});
