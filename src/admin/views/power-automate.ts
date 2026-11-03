import { CONNECTOR_ARTICLE, connectorAddress } from '../../api/power-automate.ts';
import { esc } from './layout.ts';

/**
 * Panel pobrania pliku konektora w formularzu i w szczegółach integracji Power Automate. Osobny
 * formularz `GET`, bo HTML nie zagnieżdża formularzy, a pola integracji (numery, nazwy) nie mogą
 * trafić do adresu pobrania. Pole jest wypełnione adresem bramki tylko wtedy, gdy ten nadaje się
 * dla Power Automate (`https://` z domeną). Adres z pola służy wyłącznie do zbudowania pliku i nie
 * jest zapisywany: wspólny adres bramki obsługuje aplikacje w sieci firmowej. `back` to strona,
 * na którą wraca komunikat o złym adresie.
 */
export function powerAutomatePanel(apiUrl: string | null, back: string): string {
  const checked = apiUrl === null ? null : connectorAddress(apiUrl);
  const value = checked?.ok ? checked.url : '';
  const portWarning = checked?.ok && checked.port !== null
    ? `<div class="warn" style="margin: 8px 0 0;">Adres zawiera port ${esc(checked.port)}. Zalecany jest adres bez portu.
        Power Automate łączy się z chmury Microsoftu, a zapory sieci firmowych zwykle przepuszczają z internetu tylko port 443</div>`
    : '';
  return `<div class="panel" style="max-width: 760px;">
      <div class="panel-h"><div class="lab">Konektor Power Automate</div></div>
      <div style="padding: 0 16px 10px; font-size: 12.5px; line-height: 1.5;">Plik konektora pozwala wysyłać SMS-y z przepływów
        Power Automate przez integracje Power Automate tej bramki. Jeden plik obsługuje wszystkie takie integracje.
        <ol style="margin: 8px 0 0; padding-left: 18px;">
          <li>Pobierz plik konektora z publicznym adresem bramki</li>
          <li>W Power Automate zaimportuj go jako łącznik niestandardowy</li>
          <li>Przy pierwszym połączeniu wklej klucz API wybrany w tej integracji</li>
        </ol>
      </div>
      <form method="get" action="/integracje/power-automate/konektor" class="form" style="padding: 0 16px 14px;">
        <input type="hidden" name="wroc" value="${esc(back)}">
        <div class="field">
          <label for="pa-adres">Publiczny adres bramki dla Power Automate</label>
          <input id="pa-adres" name="adres" value="${esc(value)}" placeholder="https://sms.firma.pl">
          <div class="hint">Adres <code>https://</code> z domeną, dostępny z internetu, najlepiej bez portu. Power Automate
            łączy się z bramką z chmury Microsoftu. Adres służy tylko do zbudowania pliku i nie jest zapisywany</div>
          ${portWarning}
        </div>
        <div class="bar">
          <button class="btn btn-p" type="submit">Pobierz konektor</button>
          <a class="btn btn-s" href="${esc(CONNECTOR_ARTICLE)}" target="_blank" rel="noopener">Instrukcja krok po kroku</a>
        </div>
      </form>
    </div>`;
}
