import { esc } from './layout.ts';

/**
 * Panel z adresem bramki widzianym przez aplikacje. Bez adresu panel pokazuje same ścieżki
 * (`/hooks/…`), z adresem - gotowe adresy do wklejenia. Formularz wraca na stronę, z której przyszedł.
 */
export function apiAddressPanel(current: string | null, back: string, opts: { error?: string; open?: boolean } = {}): string {
  const open = opts.open ?? current === null;
  const form = `<form method="post" action="/adres-bramki" class="form" style="padding: 0 16px 14px;">
      <input type="hidden" name="wroc" value="${esc(back)}">
      <div class="field">
        <label for="apiUrl">Adres, pod którym aplikacje widzą bramkę</label>
        <input id="apiUrl" name="apiUrl" value="${esc(current ?? '')}" placeholder="https://sms.firma.pl">
        <div class="hint">Bez ścieżki na końcu. Bramka pod domeną (Docker z Caddy, nginx albo Traefikiem): <code>https://sms.firma.pl</code>.
          Kontener na Proxmoxie dostępny w sieci firmowej: <code>http://10.10.10.159:8080</code> (adres kontenera i port API).
          Ten sam adres aplikacje wpisują przed <code>/v1/messages</code> i przed adresami wejściowymi integracji.</div>
      </div>
      <div class="bar">
        <button class="btn btn-p" type="submit">Zapisz adres</button>
        ${current === null ? '' : '<button class="btn btn-s" type="submit" name="wyczysc" value="1">Wyczyść</button>'}
      </div>
    </form>`;
  if (!open) {
    return `<div class="panel" style="max-width: 760px;">
      <div class="panel-h"><div class="lab">Adres bramki dla aplikacji</div>
        <details style="margin: 0;"><summary class="dim" style="cursor: pointer; font-size: 12px;">Zmień</summary>${form}</details>
      </div>
      <div class="keyline"><div class="keybox" id="api-url">${esc(current!)}</div><button class="btn btn-s" type="button" data-copy="#api-url">Kopiuj</button></div>
    </div>`;
  }
  return `<div class="panel" style="max-width: 760px;">
      <div class="panel-h"><div class="lab">Adres bramki dla aplikacji</div></div>
      ${opts.error ? `<div class="warn" style="margin: 0 16px 12px;">${esc(opts.error)}</div>` : ''}
      <div style="padding: 0 16px 10px; font-size: 12.5px; line-height: 1.5;">Panel nie wie, pod jakim adresem aplikacje docierają do bramki
        - podaj go raz, a przy każdym kluczu i integracji zobaczysz gotowy adres do wklejenia zamiast samej ścieżki.</div>
      ${form}
    </div>`;
}

/** Pełny adres do wklejenia albo sama ścieżka, gdy adres bramki nie jest jeszcze znany. */
export const fullUrl = (apiUrl: string | null, path: string): string => (apiUrl === null ? path : `${apiUrl}${path}`);
