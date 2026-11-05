// Strony serwera przekierowań. Czyta je odbiorca SMS-a na telefonie, dlatego są krótkie, w kolorach
// panelu i bez zasobów zewnętrznych: bez czcionek, skryptów i obrazów. Nie zawierają danych kampanii.
import { esc } from '../admin/views/layout.ts';

const STYLE = [
  'body{margin:0;background:#F4F5F2;color:#1A1D1B;font:17px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
  'main{max-width:30rem;margin:12vh auto 0;padding:0 1rem}',
  '.card{background:#FFFFFF;border:1px solid #DDE0DA;border-top:3px solid #B4531A;border-radius:3px;padding:1.5rem}',
  '.brand{margin:0 0 1rem;color:#5C625E;font-size:.875rem;font-weight:600}',
  'h1{margin:0 0 .75rem;font-size:1.375rem;font-weight:600;line-height:1.3}',
  'p{margin:0 0 .75rem}p:last-child{margin-bottom:0}',
].join('');

function page(title: string, body: string): string {
  return '<!doctype html><html lang="pl"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">'
    + `<title>${esc(title)}</title><style>${STYLE}</style></head>`
    + `<body><main><div class="card">${body}</div></main></body></html>`;
}

const brand = (displayName: string | null): string => (displayName ? `<p class="brand">${esc(displayName)}</p>` : '');

export function expiredPage(displayName: string | null): string {
  return page('Link wygasł', `${brand(displayName)}<h1>Link wygasł</h1>`
    + '<p>Link z wiadomości SMS stracił ważność albo został wyłączony przez nadawcę.</p>'
    + '<p>Aby otrzymać aktualny link, skontaktuj się z nadawcą wiadomości.</p>');
}

/** Strona samego adresu domeny, gdy domena nie ma adresu strony głównej. */
export function homePage(displayName: string): string {
  return page(displayName, `<h1>${esc(displayName)}</h1>`
    + '<p>Ta domena obsługuje krótkie linki w wiadomościach SMS.</p>'
    + '<p>Aby przejść do właściwej strony, otwórz link z otrzymanej wiadomości.</p>');
}

export function limitPage(): string {
  return page('Zbyt wiele żądań', '<h1>Zbyt wiele żądań</h1>'
    + '<p>Z tego adresu sieciowego wpłynęło zbyt wiele żądań w krótkim czasie. Spróbuj ponownie za minutę.</p>');
}

export function unavailablePage(): string {
  return page('Link chwilowo niedostępny', '<h1>Link chwilowo niedostępny</h1>'
    + '<p>Nie można teraz otworzyć tego linku. Spróbuj ponownie za kilka minut.</p>');
}
