import { describe, expect, it } from 'vitest';
import { segmentPanel, segmentsWord } from '../../src/admin/views/segments.ts';
import { measureText } from '../../src/text/measure.ts';
import { segmentText } from '../../src/text/segment.ts';

const panel = (text: string, encoding: 'auto' | 'unicode' = 'auto') => {
  const m = measureText(text, encoding);
  return segmentPanel(text, m, segmentText(text, m, 9));
};

describe('segmentPanel', () => {
  it('zaznacza znaki rozszerzone i granicę między częściami', () => {
    const html = panel(`${'a'.repeat(150)}{b}${'c'.repeat(20)}`);
    expect(html).toContain('<span class="x2">{</span>');
    expect(html).toContain('<span class="cut"><i>2</i></span>');
    expect(html).toContain('2 segmenty');
    expect(html).toContain('liczone podwójnie');
    expect(html).toContain('153 / 153 miejsc - pełny');
    expect(html).toContain('<span class="s2">');
  });

  it('ostrzega o granicy wewnątrz słowa', () => {
    const html = panel(`${'a '.repeat(75)}Prosimy o punktualnosc`);
    expect(html).toContain('wewnątrz słowa „Prosimy”');
  });

  it('dla jednej części pokazuje wolne miejsca i ostrzeżenie o UCS-2', () => {
    const html = panel('Ala ma kota');
    expect(html).toContain('149 wolnych miejsc');
    expect(html).toContain('UCS-2');
    expect(html).toContain('1 segment');
    expect(html).not.toContain('class="cut"');
  });

  it('dla UCS-2 nie ostrzega o przełączeniu kodowania ani o znakach rozszerzonych', () => {
    const html = panel('Zażółć {gęślą}');
    expect(html).toContain('miejsc UCS-2');
    expect(html).not.toContain('przełączy kodowanie');
    expect(html).not.toContain('class="x2"');
  });

  it('ucieka HTML w treści', () => {
    const html = panel('<b>x</b>');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('segmentsWord', () => {
  it('odmienia liczbę segmentów', () => {
    expect([1, 2, 5, 12, 22].map(segmentsWord)).toEqual(['1 segment', '2 segmenty', '5 segmentów', '12 segmentów', '22 segmenty']);
  });
});
