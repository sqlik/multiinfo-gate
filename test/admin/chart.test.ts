import { describe, expect, it } from 'vitest';
import { clicksChart } from '../../src/admin/views/chart.ts';

const slots = (svg: string, cls: string) =>
  [...svg.matchAll(new RegExp(`<rect class="${cls}"[^>]*data-slot="(\\d+)"`, 'g'))].map((m) => Number(m[1]));
const bars = (svg: string) => [...svg.matchAll(/<rect class="bar[^"]*"[^>]*data-slot="(\d+)"[^>]*height="([\d.]+)"/g)]
  .map((m) => ({ slot: Number(m[1]), height: Number(m[2]) }));

describe('wykres kliknięć: co godzinę', () => {
  it('48 słupków od godziny pierwszej wysyłki, bez skryptu', () => {
    const svg = clicksChart([{ hour: '2026-11-05T10', clicks: 72 }, { hour: '2026-11-05T11', clicks: 36 }], new Date('2026-11-05T10:24:00Z'), 'hourly');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toContain('<script');
    const b = bars(svg);
    expect(b).toHaveLength(48);
    expect(b[0]!.height).toBeGreaterThan(b[1]!.height);
    expect(b[1]!.height).toBeCloseTo(b[0]!.height / 2, 1);
    expect(b[2]!.height).toBe(0);
  });

  it('kliknięcia spoza 48 godzin nie trafiają na wykres godzinowy', () => {
    const svg = clicksChart([{ hour: '2026-11-07T10', clicks: 5 }], new Date('2026-11-05T10:00:00Z'), 'hourly');
    expect(bars(svg).every((b) => b.height === 0)).toBe(true);
  });

  it('noc 22:00-7:00 według czasu polskiego, także w dniu zmiany czasu na letni', () => {
    // 27.03.2027 21:00 czasu zimowego; w nocy 28.03 zegar przesuwa się z 2:00 na 3:00.
    const svg = clicksChart([], new Date('2027-03-27T20:00:00Z'), 'hourly');
    expect(slots(svg, 'night')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
  });

  it('noc według czasu polskiego zimą: 21:00-6:00 UTC', () => {
    const svg = clicksChart([], new Date('2026-11-05T10:00:00Z'), 'hourly');
    expect(slots(svg, 'night')).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 35, 36, 37, 38, 39, 40, 41, 42, 43]);
  });

  it('godziny osi w czasie polskim co sześć godzin i opis słupka w podpowiedzi', () => {
    const svg = clicksChart([{ hour: '2026-11-05T10', clicks: 3 }], new Date('2026-11-05T10:00:00Z'), 'hourly');
    expect(svg).toContain('>12:00</text>');
    expect(svg).toContain('>18:00</text>');
    expect(svg).toContain('<title>05.11, 11:00-12:00, kliknięcia: 3</title>');
  });
});

describe('wykres kliknięć: dziennie', () => {
  it('słupek na dzień czasu polskiego od pierwszej wysyłki do ostatniego kliknięcia', () => {
    const svg = clicksChart([
      { hour: '2026-11-05T10', clicks: 4 },
      // 23:00 UTC to już 6 listopada w Polsce.
      { hour: '2026-11-05T23', clicks: 2 },
      { hour: '2026-11-14T08', clicks: 1 },
    ], new Date('2026-11-05T10:00:00Z'), 'daily');
    const b = bars(svg);
    expect(b).toHaveLength(10);
    expect(slots(svg, 'night')).toEqual([]);
    expect(svg).toContain('<title>05.11, kliknięcia: 4</title>');
    expect(svg).toContain('<title>06.11, kliknięcia: 2</title>');
    expect(svg).toContain('<title>14.11, kliknięcia: 1</title>');
  });

  it('kampania bez kliknięć: jeden dzień', () => {
    expect(bars(clicksChart([], new Date('2026-11-05T10:00:00Z'), 'daily'))).toHaveLength(1);
  });
});
