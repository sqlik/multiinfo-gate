import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { button, buttons, field, fields, messageBox, numbers, phoneLabel, section, share, smsCounter, tile, tiles, txt, wideField } from '../../src/mcp/views/client/bridge.js';
import { BUILT_VIEWS, viewFiles, viewHtml } from '../../src/mcp/views/index.ts';
import { VIEW_STYLE } from '../../src/mcp/views/style.ts';

describe('style kart widoków', () => {
  it('jeden promień 6 px i jedna wysokość pól oraz przycisków, bez dawnych promieni', () => {
    expect(VIEW_STYLE).toContain('--r:6px');
    expect(VIEW_STYLE).toContain('--h:34px');
    expect(VIEW_STYLE).not.toMatch(/border-radius:\d+px/);
  });

  it('przycisk ostrzegawczy, szary przycisk niedostępny, równe przyciski i okno treści z obwódką koloru akcji', () => {
    expect(VIEW_STYLE).toMatch(/\.btn-danger\{[^}]*background:var\(--danger\)/);
    expect(VIEW_STYLE).toMatch(/\.btn:disabled[^{]*\{[^}]*background:var\(--rule-soft\)/);
    expect(VIEW_STYLE).toMatch(/\.btns\.n2\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
    expect(VIEW_STYLE).toMatch(/\.msg\{[^}]*border:1px solid var\(--signal\)/);
    expect(VIEW_STYLE).toMatch(/\.msg\{[^}]*background:var\(--surface\)/);
  });

  it('pole na całą szerokość siatki pól (próba B, B4)', () => {
    expect(VIEW_STYLE).toContain('.field.wide{grid-column:1/-1}');
    expect(wideField('Termin', txt('2026-11-20 08:00'), 'podpowiedź')).toBe(
      '<div class="field wide"><span class="lbl">Termin</span><div class="txt">2026-11-20 08:00</div><p class="note">podpowiedź</p></div>');
  });

  it('podpis kafla zawija się zamiast urywać wielokropkiem (próba B, B2)', () => {
    expect(VIEW_STYLE).toMatch(/\.tile \.s\{[^}]*white-space:normal/);
    expect(VIEW_STYLE).not.toMatch(/\.tile \.s\{[^}]*text-overflow:ellipsis/);
  });

  it('komunikat zawija długi tekst bez spacji i stoi w elemencie blokowym, który mieści rozwijane szczegóły błędu', () => {
    expect(VIEW_STYLE).toMatch(/\.notice\{[^}]*overflow-wrap:anywhere/);
    expect(VIEW_STYLE).toMatch(/\.why \.mono\{[^}]*white-space:pre-wrap/);
    for (const id of BUILT_VIEWS) expect(viewHtml(id)).toContain('<div id="komunikat" class="notice" role="status" hidden></div>');
  });

  it('style nie zawierają klas dawnego układu', () => {
    for (const old of ['.box', '.kv', '.split2', '.phone', '.bubble', '.chips', '.recips', '.who']) {
      expect(VIEW_STYLE, old).not.toContain(`${old}{`);
    }
  });
});

describe('elementy układu kart', () => {
  it('share: udział z jednym miejscem po przecinku, a zaokrąglenie nie ukrywa niedoręczeń (próba B, B14)', () => {
    expect(share(1, 3)).toBe('33,3 %');
    expect(share(0, 10)).toBe('0,0 %');
    expect(share(10, 10)).toBe('100,0 %');
    expect(share(9896, 9899)).toBe('ponad 99,9 %');
    expect(share(3, 9899)).toBe('poniżej 0,1 %');
    expect(share(5, 0)).toBe('-');
  });

  it('phoneLabel: numer w zapisie panelu, bez plusa i odstępów', () => {
    expect(phoneLabel('48601000072')).toBe('48601000072');
    expect(phoneLabel(null)).toBe('');
  });

  it('section: pogrubiona nazwa i opis pod nazwą jako tekst', () => {
    expect(section('Odbiorcy: <b>3</b>', '<p>x</p>', 'Lista "grupy"'))
      .toBe('<section class="sec"><h3>Odbiorcy: &lt;b&gt;3&lt;/b&gt;</h3><p class="lead">Lista &quot;grupy&quot;</p><p>x</p></section>');
    expect(section('Limity', '')).toBe('<section class="sec"><h3>Limity</h3></section>');
  });

  it('field i fields: etykieta nad wartością, podpowiedź pod polem, wartość tekstowa ucieczona', () => {
    expect(fields(field('Integracja', txt('<i>Agent</i>'), 'Zmienia administrator')))
      .toBe('<div class="fields"><div class="field"><span class="lbl">Integracja</span><div class="txt">&lt;i&gt;Agent&lt;/i&gt;</div>'
        + '<p class="note">Zmienia administrator</p></div></div>');
  });

  it('tile i tiles: etykieta, wartość i opis jako tekst, wyróżnienie stanu', () => {
    expect(tiles(tile('Doręczone', 1198, '96,6 %', 'ok'), tile('Razem', '<b>1</b>', '')))
      .toBe('<div class="tiles"><div class="tile ok"><div class="lbl">Doręczone</div><div class="v">1198</div><div class="s">96,6 %</div></div>'
        + '<div class="tile"><div class="lbl">Razem</div><div class="v">&lt;b&gt;1&lt;/b&gt;</div><div class="s"></div></div></div>');
  });

  it('buttons: równe przyciski w rzędzie, cztery w dwóch kolumnach, rodzaj, dane i wyłączenie', () => {
    const send = button('Wyślij 3 SMS-y', { act: 'send', kind: 'primary' });
    expect(send).toBe('<button type="button" class="btn btn-primary" data-act="send">Wyślij 3 SMS-y</button>');
    expect(button('Anuluj "x"', { act: 'cancel', kind: 'danger', disabled: true, data: { index: 2 } }))
      .toBe('<button type="button" class="btn btn-danger" data-act="cancel" data-index="2" disabled>Anuluj &quot;x&quot;</button>');
    expect(buttons(send)).toBe(`<div class="btns n1">${send}</div>`);
    expect(buttons(send, '', send)).toBe(`<div class="btns n2">${send}${send}</div>`);
    expect(buttons(send, send, send)).toContain('class="btns n3"');
    expect(buttons(send, send, send, send)).toContain('class="btns n2"');
    expect(buttons('', null)).toBe('');
  });

  it('numbers: numery po przecinku z nazwą przed numerem złączoną twardą spacją, nazwy jako tekst, długa lista skrócona', () => {
    expect(numbers([{ phone: '48601000071', label: 'Tomasz <dyżur>' }, { phone: '48601000072' }]))
      .toBe('<p class="nums">Tomasz &lt;dyżur&gt;\u00a048601000071, 48601000072</p>');
    const many = Array.from({ length: 501 }, (_, i) => ({ phone: String(48601000000 + i) }));
    expect(numbers(many)).toMatch(/48601000499, …<\/p>$/);
    expect(numbers([])).toBe('');
  });

  it('smsCounter i messageBox: nadawca jako tekst, liczba znaków i części, treść w oknie', () => {
    const counter = smsCounter({ characters: 131, parts: 2, encoding: 'ucs2' });
    expect(counter).toBe('<b>131</b> znaków · <b>2</b> części · UCS-2');
    expect(smsCounter({ characters: 1, parts: 1, encoding: 'gsm' })).toBe('<b>1</b> znak · <b>1</b> część · GSM');
    expect(messageBox({ sender: '<MI GATE>', counter, body: 'Treść' }))
      .toBe('<div class="msg"><div class="msg-head"><span>Nadawca na telefonie: <b>&lt;MI GATE&gt;</b></span>'
        + `<span>${counter}</span></div><div class="msg-text">Treść</div></div>`);
    expect(messageBox({ sender: null, counter, body: 'x' })).toContain('<div class="msg-head"><span></span>');
  });
});

describe('pliki dokumentów widoków', () => {
  it('dokument każdego widoku zawiera pliki, z których importują jego pliki, w kolejności przed nimi', () => {
    const dir = new URL('../../src/mcp/views/client/', import.meta.url);
    for (const id of BUILT_VIEWS) {
      const files = viewFiles(id);
      files.forEach((file, at) => {
        for (const [, dep] of readFileSync(new URL(file, dir), 'utf8').matchAll(/^import\s[^;]*?from '\.\/([\w-]+\.js)';$/gm)) {
          expect(files.indexOf(dep!), `${id}: ${file} importuje ${dep}`).toBeGreaterThanOrEqual(0);
          expect(files.indexOf(dep!), `${id}: ${dep} przed ${file}`).toBeLessThan(at);
        }
      });
    }
  });
});
