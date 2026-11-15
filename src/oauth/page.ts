// Strona połączenia aplikacji AI z bramką. Jest jedyną stroną z formularzem widoczną z internetu poza panelem,
// dlatego ma kolory panelu, style w dokumencie i nie pobiera żadnych zasobów: bez czcionek, skryptów i obrazów.
import { esc } from '../admin/views/layout.ts';

/** Nagłówek CSP strony: style w dokumencie, formularz wyłącznie do bramki, zakaz osadzania w ramce. */
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const STYLE = [
  'body{margin:0;background:#F4F5F2;color:#1A1D1B;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
  'main{max-width:28rem;margin:10vh auto 2rem;padding:0 1rem}',
  '.card{background:#FFFFFF;border:1px solid #DDE0DA;border-top:3px solid #B4531A;border-radius:3px;padding:1.5rem}',
  '.brand{margin:0 0 1rem;color:#5C625E;font:600 .75rem/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase}',
  'h1{margin:0 0 .75rem;font-size:1.25rem;font-weight:600;line-height:1.3}',
  'p{margin:0 0 .75rem}ul{margin:0 0 .75rem;padding-left:1.25rem}',
  'label{display:block;margin:1.25rem 0 .25rem;font-weight:600}',
  'input{box-sizing:border-box;width:100%;padding:.5rem .625rem;border:1px solid #C9CEC5;border-radius:3px;background:#FFFFFF;color:#1A1D1B;'
    + 'font:1.125rem/1.4 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase}',
  '.hint{margin:.375rem 0 0;color:#5C625E;font-size:.875rem}',
  'button{margin-top:1.25rem;padding:.5rem 1.25rem;border:0;border-radius:3px;background:#B4531A;color:#FFFFFF;'
    + 'font-family:inherit;font-size:1rem;font-weight:600;cursor:pointer}',
  'button:hover{background:#8E4014}',
  'a{color:#B4531A}a:hover{color:#8E4014}',
  'input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid #B4531A;outline-offset:2px}',
  '.error{padding:.5rem .75rem;border-radius:3px;background:#F8E4E3;color:#741816}',
].join('');

function page(title: string, body: string, head = ''): string {
  return '<!doctype html><html lang="pl"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">'
    + `${head}<title>${esc(title)}</title><style>${STYLE}</style></head>`
    + `<body><main><div class="card"><p class="brand">Multiinfo Gate</p>${body}</div></main></body></html>`;
}

/** Strona z polem na kod jednorazowy. Nazwa aplikacji i domena adresu powrotu pokazują pracownikowi, komu daje dostęp. */
export function authorizePage(v: { appName: string; redirectHost: string; requestId: string; error?: string }): string {
  const error = v.error === undefined ? '' : `<p class="error" role="alert">${esc(v.error)}</p>`;
  return page('Połączenie aplikacji z bramką', '<h1>Połączenie aplikacji z bramką</h1>'
    + `<p>Aplikacja <strong>${esc(v.appName)}</strong> prosi o dostęp do bramki SMS. Po połączeniu otrzyma uprawnienia, które administrator nadał w integracji Agent AI.</p>`
    + `<p>Bramka przekaże dostęp pod adres <strong>${esc(v.redirectHost)}</strong>. Wpisz kod tylko wtedy, gdy łączenie rozpoczęto w aplikacji, której używasz.</p>`
    + error
    + '<form method="post" action="/oauth/authorize">'
    + `<input type="hidden" name="request_id" value="${esc(v.requestId)}">`
    + '<label for="code">Kod jednorazowy</label>'
    + '<input id="code" name="code" required maxlength="20" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" autofocus>'
    + '<p class="hint">Kod przekazuje administrator bramki. Wielkość liter i myślniki nie mają znaczenia.</p>'
    + '<button type="submit">Połącz</button>'
    + '</form>');
}

/**
 * Potwierdzenie po poprawnym kodzie. Powrót do aplikacji następuje odnośnikiem i odświeżeniem strony, a nie
 * przekierowaniem 302, ponieważ dyrektywa form-action 'self' zablokowałaby przekierowanie formularza do aplikacji.
 */
export function connectedPage(v: { connectionName: string; scopes: string[]; redirectUrl: string }): string {
  const url = esc(v.redirectUrl);
  return page('Aplikacja połączona z bramką', '<h1>Aplikacja połączona z bramką</h1>'
    + `<p>Połączenie <strong>${esc(v.connectionName)}</strong> jest aktywne. Aplikacja otrzymała następujące uprawnienia:</p>`
    + `<ul>${v.scopes.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`
    + `<p>Za chwilę nastąpi powrót do aplikacji. Jeżeli przeglądarka nie wróci samoczynnie, wybierz odnośnik <a href="${url}">Wróć do aplikacji</a>.</p>`,
  `<meta http-equiv="refresh" content="3;url=${url}">`);
}

export function oauthErrorPage(message: string, title = 'Nie można połączyć aplikacji'): string {
  return page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);
}
