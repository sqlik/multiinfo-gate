import { describe, expect, it } from 'vitest';
import { matches, type ConditionConfig } from '../../src/integrations/conditions.ts';
import { TemplateEngine } from '../../src/integrations/templates.ts';

const engine = new TemplateEngine();
const ctx = { p: { status: 'firing', title: 'CPU high on web-1', count: 7, nested: { flag: true } } };
const builder = (...rules: Array<[string, string, string]>): ConditionConfig => ({ mode: 'builder', rules: rules.map(([path, op, value]) => ({ path, op: op as never, value })) });

describe('matches - konstruktor', () => {
  it('pusta lista reguł przepuszcza wszystko', () => {
    expect(matches(builder(), ctx, engine)).toBe(true);
  });
  it('łączy reguły spójnikiem i', () => {
    expect(matches(builder(['status', 'eq', 'firing'], ['title', 'contains', 'CPU']), ctx, engine)).toBe(true);
    expect(matches(builder(['status', 'eq', 'firing'], ['title', 'contains', 'RAM']), ctx, engine)).toBe(false);
  });
  it.each([
    [['status', 'ne', 'resolved'], true], [['title', 'starts', 'CPU'], true], [['title', 'regex', 'web-\\d'], true],
    [['nested.flag', 'exists', ''], true], [['brak', 'missing', ''], true], [['count', 'gt', '5'], true], [['count', 'lt', '5'], false],
    [['status', 'eq', 'FIRING'], false], [['count', 'eq', '7'], true], [['nested.flag', 'eq', 'true'], true],
  ] as Array<[[string, string, string], boolean]>)('%j -> %s', (rule, expected) => {
    expect(matches(builder(rule), ctx, engine)).toBe(expected);
  });
  it('błędne wyrażenie regularne nie pasuje i nie rzuca', () => {
    expect(matches(builder(['title', 'regex', '(']), ctx, engine)).toBe(false);
  });
});

describe('matches - liquid', () => {
  it('pusty, false i 0 to nie; reszta tak', () => {
    expect(matches({ mode: 'liquid', expr: '{% if p.status == "firing" %}true{% endif %}' }, ctx, engine)).toBe(true);
    expect(matches({ mode: 'liquid', expr: '{% if p.status == "resolved" %}true{% endif %}' }, ctx, engine)).toBe(false);
    expect(matches({ mode: 'liquid', expr: 'false' }, ctx, engine)).toBe(false);
    expect(matches({ mode: 'liquid', expr: ' 0 ' }, ctx, engine)).toBe(false);
    expect(matches({ mode: 'liquid', expr: '{{ p.count }}' }, ctx, engine)).toBe(true);
  });
});
