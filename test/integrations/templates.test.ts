import { describe, expect, it } from 'vitest';
import { OUTPUT_LIMIT_CHARS, TemplateEngine, TemplateError } from '../../src/integrations/templates.ts';

const engine = new TemplateEngine();
const p = { status: 'firing', alerts: [{ labels: { alertname: 'CPU' } }, { labels: { alertname: 'Disk' } }], contact: { phone: '+48 601 000 001' }, at: '2026-09-02T10:00:00Z' };

describe('TemplateEngine.render', () => {
  it('podstawia pola, warunki i pętle', () => {
    const out = engine.render('{% if p.status == "firing" %}ALARM{% endif %}: {% for a in p.alerts %}{{ a.labels.alertname }}{% unless forloop.last %}, {% endunless %}{% endfor %}', { p });
    expect(out).toBe('ALARM: CPU, Disk');
  });
  it('nieznane pole daje pusty ciąg', () => {
    expect(engine.render('[{{ p.brak }}]', { p })).toBe('[]');
  });
  it('filtry bramki', () => {
    expect(engine.render('{{ "Zażółć gęślą" | gsm }}', {})).toBe('Zazolc gesla');
    expect(engine.render('{{ p.contact.phone | phone }}', { p })).toBe('48601000001');
    expect(engine.render('{{ "abcdefghij" | sms_truncate: 6 }}', {})).toBe('abcde…');
    expect(engine.render('{{ p.at | date_pl }}', { p })).toBe('02.09.2026 12:00');
  });
  it('html_text robi z HTML-u helpdesku tekst ze spacjami między blokami', () => {
    const html = "Anna : <div style='x'>Dziękujemy, sprawa&nbsp;rozwiązana.<div><br></div><div><strong>Anna</strong></div></div>\n\n";
    expect(engine.render('{{ p.t | html_text }}', { p: { t: html } })).toBe('Anna : Dziękujemy, sprawa rozwiązana. Anna');
    expect(engine.render('{{ p.t | html_text }}', { p: { t: '<p>a &amp; b</p><p>c</p>' } })).toBe('a & b c');
  });

  it('phone na numerze niepoprawnym zostawia tekst bez zmian', () => {
    expect(engine.render('{{ "brak" | phone }}', {})).toBe('brak');
  });
  it('json podaje wartość jako literał JSON', () => {
    expect(engine.render('{"t": {{ "a\\"b" | json }}}', {})).toBe('{"t": "a\\"b"}');
  });
});

describe('TemplateEngine.validate', () => {
  it('zwraca null dla poprawnego i komunikat z linią dla błędnego', () => {
    expect(engine.validate('{{ p.a }}')).toBeNull();
    expect(engine.validate('{% if p.a %}bez końca')).toMatch(/linia 1/);
    expect(engine.validate('{{ p.a | nieznany }}')).toMatch(/nieznany/);
  });
  it('odrzuca include i render', () => {
    expect(engine.validate('{% include "x" %}')).toMatch(/include/);
    expect(engine.validate('{% render "x" %}')).toMatch(/render/);
  });
  it('include przemycony poza walidacją nie czyta plików', () => {
    expect(() => engine.render('{% include "x" %}', {})).toThrow(TemplateError);
  });
});

describe('limity', () => {
  it('za długi wynik to TemplateError', () => {
    expect(() => engine.render(`{% for i in (1..${OUTPUT_LIMIT_CHARS}) %}xx{% endfor %}`, {})).toThrow(TemplateError);
  });
  it('bardzo długa pętla przekracza limit czasu', () => {
    expect(() => engine.render('{% for i in (1..2000000) %}{% assign x = i | plus: 1 %}{% endfor %}', {})).toThrow(TemplateError);
  });
});
