import type { InstallKind } from '../../config/install.ts';
import { problemUrl } from '../../docs-links.ts';
import { logSearch } from './commands.ts';
import { esc } from './layout.ts';
import { gate } from './login.ts';

const BACK = '<p class="sub"><a href="/przeglad">Wróć do przeglądu</a></p>';

/**
 * Błąd wewnętrzny panelu. Strona stoi w ramie logowania, bo układ panelu sam czyta bazę i mógłby
 * rzucić ten sam błąd. Treść wyjątku zostaje w dzienniku - strona podaje tylko identyfikator.
 */
export function errorPage(id: string, install: InstallKind | null): string {
  return gate('Błąd wewnętrzny bramki', `<div class="help-body">
    <h1>Błąd wewnętrzny bramki</h1>
    <p>Bramka nie mogła obsłużyć tego żądania. Przyczyna została zapisana w dzienniku.</p>
    <p>Identyfikator zdarzenia: <code>${esc(id)}</code>. Wpis w dzienniku odnajduje polecenie:</p>
    ${logSearch(install, id)}
    <p><a href="${esc(problemUrl('blad-wewnetrzny'))}">Najczęstsze przyczyny i sposób zgłoszenia problemu</a></p>
    ${BACK}
  </div>`, 'help');
}

export function notFoundPage(): string {
  return gate('Nie ma takiej strony', `<div class="help-body">
    <h1>Nie ma takiej strony</h1>
    <p>Adres nie prowadzi do żadnej strony panelu.</p>
    ${BACK}
  </div>`, 'help');
}

/** Błąd po stronie żądania (4xx) zgłoszony przez serwer, na przykład za duży formularz. */
export function clientErrorPage(status: number): string {
  const tooLarge = status === 413;
  const title = tooLarge ? 'Przesłane dane są za duże' : 'Żądanie nie zostało przyjęte';
  const about = tooLarge
    ? 'Formularz albo plik przekracza dopuszczalny rozmiar.'
    : `Panel nie mógł odczytać przesłanych danych (kod ${status}).`;
  return gate(title, `<div class="help-body">
    <h1>${esc(title)}</h1>
    <p>${esc(about)}</p>
    ${BACK}
  </div>`, 'help');
}
