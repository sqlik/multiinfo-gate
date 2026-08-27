import { describe, expect, it } from 'vitest';
import { combineStatuses, describeSubstatus, isFinal, mapStatus } from '../../src/multiinfo/status.ts';

describe('mapStatus', () => {
  it('mapuje statusy nieostateczne', () => {
    expect(mapStatus(0, 0)).toBe('queued');
    expect(mapStatus(1, 0)).toBe('queued');
    expect(mapStatus(3, 0)).toBe('sent');
    expect(mapStatus(7, 0)).toBe('throttled');
  });

  it('mapuje statusy ostateczne', () => {
    expect(mapStatus(11, 0)).toBe('failed');
    expect(mapStatus(12, 0)).toBe('expired');
    expect(mapStatus(13, 0)).toBe('cancelled');
  });

  it('traktuje czarne listy jako blokadę', () => {
    expect(mapStatus(14, 0)).toBe('blocked');
    expect(mapStatus(20, 0)).toBe('blocked');
    expect(mapStatus(22, 0)).toBe('blocked');
  });

  it('nie uznaje wysyłki bez żądania potwierdzenia za doręczenie', () => {
    expect(mapStatus(21, 0)).toBe('sent');
  });

  it('uznaje doręczenie tylko przy potwierdzeniu odbioru', () => {
    expect(mapStatus(21, 1)).toBe('delivered');
    expect(mapStatus(21, 2)).toBe('delivered');
    expect(mapStatus(21, 3)).toBe('delivered');
  });

  it('przekazanie dalej traktuje jak wysłanie, nie doręczenie', () => {
    expect(mapStatus(21, 4)).toBe('sent');
  });

  it('nieznany status oznacza jako unknown zamiast zgłaszać wyjątek', () => {
    expect(mapStatus(99, 0)).toBe('unknown');
  });
});

describe('describeSubstatus', () => {
  it('opisuje znane substatusy po polsku', () => {
    expect(describeSubstatus(11, 4)).toBe('SMSC - brak odpowiedzi');
    expect(describeSubstatus(20, 0)).toBe('Numer odbiorcy znajduje się na czarnej liście');
  });

  it('dla nieznanej pary podaje surowe wartości', () => {
    expect(describeSubstatus(99, 7)).toBe('Nieznany status 99 / 7');
  });
});

describe('isFinal', () => {
  it('uznaje statusy powyżej dziesięciu za ostateczne', () => {
    expect(isFinal(11)).toBe(true);
    expect(isFinal(21)).toBe(true);
    expect(isFinal(3)).toBe(false);
    expect(isFinal(7)).toBe(false);
  });
});

describe('combineStatuses', () => {
  it('doręczona tylko wtedy, gdy wszystkie części doręczone', () => {
    expect(combineStatuses(['delivered', 'delivered'])).toBe('delivered');
    expect(combineStatuses(['delivered', 'sent'])).toBe('sent');
  });

  it('jedna część nieudana przesądza o całości', () => {
    expect(combineStatuses(['delivered', 'failed'])).toBe('failed');
    expect(combineStatuses(['sent', 'expired'])).toBe('expired');
    expect(combineStatuses(['delivered', 'blocked'])).toBe('blocked');
  });

  it('część wciąż w kolejce cofa całość do queued', () => {
    expect(combineStatuses(['sent', 'queued'])).toBe('queued');
  });

  it('pusta lista oznacza queued', () => {
    expect(combineStatuses([])).toBe('queued');
  });
});
