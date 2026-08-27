import type { Flash } from '../flash.ts';

export type NavKey = 'przeglad' | 'wiadomosci' | 'rozsylki' | 'konta' | 'klucze' | 'uzytkownicy' | 'dziennik';

export interface NavCounts {
  wiadomosci: number;
  konta: number;
  klucze: number;
  uzytkownicy: number;
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/** Ucieczka znaków HTML. Każda wartość pochodząca z bazy musi przez nią przejść. */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

const NAV: Array<{ key: NavKey; label: string; group: string }> = [
  { key: 'przeglad', label: 'Przegląd', group: 'Ruch' },
  { key: 'wiadomosci', label: 'Wiadomości', group: 'Ruch' },
  { key: 'rozsylki', label: 'Rozsyłki', group: 'Ruch' },
  { key: 'konta', label: 'Konta Multiinfo', group: 'Konfiguracja' },
  { key: 'klucze', label: 'Klucze API', group: 'Konfiguracja' },
  { key: 'uzytkownicy', label: 'Użytkownicy', group: 'Konfiguracja' },
  { key: 'dziennik', label: 'Dziennik zdarzeń', group: 'Audyt' },
];

/** Licznik pokazujemy tylko przy pozycjach, które go mają - bez rzutowania na słownik. */
function countOf(counts: NavCounts, key: NavKey): number | undefined {
  switch (key) {
    case 'wiadomosci': return counts.wiadomosci;
    case 'konta': return counts.konta;
    case 'klucze': return counts.klucze;
    case 'uzytkownicy': return counts.uzytkownicy;
    default: return undefined;
  }
}

export function layout(opts: {
  title: string; active: NavKey | null; counts: NavCounts; body: string; flash?: Flash | null;
}): string {
  const groups = [...new Set(NAV.map((n) => n.group))];
  const rail = groups.map((group) => {
    const items = NAV.filter((n) => n.group === group).map((n) => {
      const count = countOf(opts.counts, n.key);
      // Zero nic nie mówi: pusta kolejka to stan normalny, a plakietka „0” wygląda jak błąd.
      const badge = count === undefined || count === 0 ? '' : `<span class="ct">${esc(count)}</span>`;
      return `<a href="/${n.key}"${n.key === opts.active ? ' class="on"' : ''}>${esc(n.label)}${badge}</a>`;
    }).join('');
    return `<div class="rail-label">${esc(group)}</div><div class="nav">${items}</div>`;
  }).join('');

  const flash = opts.flash ? `<div class="flash flash-${opts.flash.tone}" role="status">
      <div>${esc(opts.flash.text)}</div>
      <button class="flash-close" type="button" aria-label="Zamknij komunikat">×</button>
    </div>` : '';

  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} - Multiinfo Gate</title>
<link rel="stylesheet" href="/style.css">
<script src="/panel.js" defer></script>
</head>
<body>
<div class="root">
  <div class="mast">
    <div class="brand">Multiinfo<span> / </span>Gate</div>
    <div class="mast-right"><a href="/haslo">Zmień hasło</a><a href="/wyloguj">Wyloguj</a></div>
  </div>
  <div class="body">
    <div class="rail">${rail}</div>
    <div class="main">${flash}${opts.body}</div>
  </div>
</div>
</body>
</html>`;
}
