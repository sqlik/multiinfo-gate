import { describe, expect, it } from 'vitest';
import { FAVICON_LINK } from '../../src/admin/views/favicon.ts';
import { layout } from '../../src/admin/views/layout.ts';
import { gate } from '../../src/admin/views/login.ts';

describe('favicon panelu', () => {
  it('jest odnośnikiem do SVG wpisanego w adres data, bez osobnego żądania', () => {
    expect(FAVICON_LINK).toMatch(/^<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
    expect(FAVICON_LINK).not.toMatch(/href="\//);
  });

  it('ma adres data bez znaków, które psują URI w atrybucie', () => {
    const href = /href="([^"]+)"/.exec(FAVICON_LINK)?.[1] ?? '';
    expect(href).not.toMatch(/[#<>"]/);
    expect(decodeURIComponent(href.replace('data:image/svg+xml,', ''))).toMatch(/^<svg[\s\S]*<\/svg>$/);
  });

  it('trafia do nagłówka układu panelu i ekranów logowania', () => {
    const inside = layout({ title: 'Test', active: 'przeglad', body: '', counts: { wiadomosci: 0, konta: 0, klucze: 0, uzytkownicy: 0 } });
    const outside = gate('Logowanie', '<p></p>');
    for (const html of [inside, outside]) {
      const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
      expect(head).toContain(FAVICON_LINK);
    }
  });
});
