import { describe, expect, it } from 'vitest';
import { layout } from '../../src/admin/views/layout.ts';

const base = { title: 'Test', active: 'przeglad' as const, body: '<p>treść</p>' };

describe('layout', () => {
  it('nie rysuje plakietki przy liczniku równym zero', () => {
    const html = layout({ ...base, counts: { wiadomosci: 0, konta: 1, klucze: 0, uzytkownicy: 2 } });
    expect(html).not.toContain('<span class="ct">0</span>');
    expect(html).toContain('<span class="ct">1</span>');
    expect(html).toContain('<span class="ct">2</span>');
  });

  it('rysuje pasek komunikatu z tonem i przyciskiem zamknięcia', () => {
    const html = layout({ ...base, counts: { wiadomosci: 0, konta: 0, klucze: 0, uzytkownicy: 0 },
      flash: { tone: 'ok', text: 'Konto <Firma> zapisane.' } });
    expect(html).toContain('class="flash flash-ok"');
    expect(html).toContain('Konto &lt;Firma&gt; zapisane.');
    expect(html).toContain('class="flash-close"');
    expect(html).toContain('<script src="/panel.js" defer></script>');
  });

  it('bez komunikatu nie rysuje paska', () => {
    const html = layout({ ...base, counts: { wiadomosci: 0, konta: 0, klucze: 0, uzytkownicy: 0 }, flash: null });
    expect(html).not.toContain('class="flash');
  });

  it('ma pozycję Użytkownicy w grupie Konfiguracja i link do zmiany hasła', () => {
    const html = layout({ ...base, counts: { wiadomosci: 0, konta: 0, klucze: 0, uzytkownicy: 0 } });
    expect(html).toContain('<a href="/uzytkownicy">Użytkownicy</a>');
    expect(html.indexOf('/klucze')).toBeLessThan(html.indexOf('/uzytkownicy'));
    expect(html).toContain('<a href="/haslo">Zmień hasło</a>');
  });

  it('pozwala nie podświetlać żadnej pozycji', () => {
    const html = layout({ ...base, active: null, counts: { wiadomosci: 0, konta: 0, klucze: 0, uzytkownicy: 0 } });
    expect(html).not.toContain('class="on"');
  });
});
