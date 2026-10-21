import { describe, expect, it } from 'vitest';
import { pullRecipients } from '../../../src/integrations/mail/recipients.ts';

describe('pullRecipients', () => {
  it('temat: numery przed dwukropkiem, rozdzielone przecinkiem, średnikiem albo spacją; temat bez przedrostka', () => {
    expect(pullRecipients('600100200, 48600100201; 601 000 002: Serwer padł', 'treść', 'subject'))
      .toEqual({ numbers: ['600100200', '48600100201', '601 000 002'], subject: 'Serwer padł', text: 'treść' });
    expect(pullRecipients('+48 600 100 200 600100201: Awaria', 'treść', 'subject').numbers).toEqual(['+48 600 100 200', '600100201']);
  });
  it('temat bez numerów zostaje w całości, w tym temat zaczynający się liczbą', () => {
    expect(pullRecipients('2 serwery padły: sprawdź', 'treść', 'subject').numbers).toEqual([]);
    expect(pullRecipients('2 serwery padły: sprawdź', 'treść', 'subject').subject).toBe('2 serwery padły: sprawdź');
    expect(pullRecipients('Re: awaria', 'treść', 'subject').numbers).toEqual([]);
    expect(pullRecipients('600100200, serwer: x', 'treść', 'subject').numbers).toEqual([]);
    expect(pullRecipients('Awaria', 'treść', 'subject')).toEqual({ numbers: [], subject: 'Awaria', text: 'treść' });
  });
  it('tryb tematu nie rusza treści, tryb treści nie rusza tematu', () => {
    expect(pullRecipients('600100200: Awaria', '600100201\nx', 'subject').text).toBe('600100201\nx');
    expect(pullRecipients('600100200: Awaria', '600100201\nx', 'body').subject).toBe('600100200: Awaria');
  });
  it('pierwsza linia treści z samymi numerami jest zabierana z treści', () => {
    expect(pullRecipients('Awaria', '\n600100200 600100201\nSerwer padł', 'body')).toEqual({ numbers: ['600100200', '600100201'], subject: 'Awaria', text: 'Serwer padł' });
    expect(pullRecipients('Awaria', 'Serwer 600100200 padł', 'body').numbers).toEqual([]);
    expect(pullRecipients('Awaria', '', 'body')).toEqual({ numbers: [], subject: 'Awaria', text: '' });
  });
});
