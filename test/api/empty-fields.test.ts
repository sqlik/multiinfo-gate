import { describe, expect, it } from 'vitest';
import { dropEmptyFields } from '../../src/api/empty-fields.ts';

describe('dropEmptyFields', () => {
  it('usuwa właściwości równe pustemu napisowi albo null', () => {
    expect(dropEmptyFields({ to: '48601000001', orig: '', validTo: null, costCenter: 'x' }))
      .toEqual({ to: '48601000001', costCenter: 'x' });
  });

  it('czyści także elementy wskazanych tablic obiektów', () => {
    expect(dropEmptyFields({ recipients: [{ to: '1', text: '', clientId: null }] }, ['recipients']))
      .toEqual({ recipients: [{ to: '1' }] });
  });

  it('nie rusza tablic, których nie wskazano', () => {
    expect(dropEmptyFields({ to: ['', '48601000001'] })).toEqual({ to: ['', '48601000001'] });
  });

  it('zwraca bez zmian wartości, które nie są obiektami', () => {
    expect(dropEmptyFields('tekst')).toBe('tekst');
    expect(dropEmptyFields([1])).toEqual([1]);
    expect(dropEmptyFields(null)).toBeNull();
    expect(dropEmptyFields(undefined)).toBeUndefined();
  });

  it('zostawia fałsz i zero', () => {
    expect(dropEmptyFields({ deliveryReport: false, maxParts: 0 })).toEqual({ deliveryReport: false, maxParts: 0 });
  });

  it('nie zmienia obiektu wejściowego', () => {
    const body = { to: '1', orig: '' };
    dropEmptyFields(body);
    expect(body).toEqual({ to: '1', orig: '' });
  });
});
