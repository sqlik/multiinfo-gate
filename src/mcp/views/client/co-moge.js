// Widok „Co mogę?”: uprawnienia, usługi, limity i ważność połączenia według wyniku connection_status.
// Odświeżenie woła to samo narzędzie przez aplikację AI, bez kolejnego pytania do agenta.
import { applyTheme, badge, createBridge, esc, note, stamp, textOf } from './bridge.js';

const box = (title, inner) => `<section class="box"><h2>${esc(title)}</h2>${inner}</section>`;

function unavailable(data) {
  return `<p class="who">Połączenie <b>${esc(data.connection)}</b> w integracji <b>${esc(data.integration)}</b></p>`
    + '<section class="box box-wide"><h2>Połączenie jest chwilowo niedostępne</h2>'
    + `<p>${badge('fail', 'niedostępne')} ${esc(data.reason)}</p>`
    + note('Dostęp przywraca administrator bramki, a połączenie zadziała ponownie bez nowego kodu')
    + '</section>';
}

/** HTML treści widoku z `structuredContent` narzędzia connection_status; `env.scopes` to etykiety wszystkich zakresów. */
export function renderStatus(data, env = {}) {
  if (!data || data.available !== true) return unavailable(data ?? {});
  const granted = new Set((data.scopes ?? []).map((s) => s.id));
  const missing = Object.entries(env.scopes ?? {}).filter(([id]) => !granted.has(id));
  const guard = data.guard ?? {};

  const scopes = `<div class="badges">${(data.scopes ?? []).map((s) => badge('ok', s.label)).join('')}</div>`
    + (missing.length > 0 ? `<div class="badges">${missing.map(([, label]) => badge('plain', `${label}: brak`)).join('')}</div>` : '')
    + note(data.expiresAt ? `Połączenie jest ważne do ${stamp(data.expiresAt)}` : 'Połączenie jest ważne bez terminu');

  const services = `<ul class="list">${(data.services ?? []).map((s) =>
    `<li><span class="mono">${esc(s.id)}</span>${s.label ? ` ${esc(s.label)}` : ''}</li>`).join('')}</ul>`
    + note(`Limit części SMS-a: ${data.maxParts}. ${data.overflow === 'reject' ? 'Dłuższa treść zostaje odrzucona.' : 'Dłuższa treść zostaje skrócona do tego limitu.'}`);

  const limits = '<dl class="kv">'
    + `<dt>Żądania klucza</dt><dd>${esc(data.ratePerMin)} na minutę</dd>`
    + `<dt>Wysyłki</dt><dd>${esc(guard.calls)} z ${esc(guard.callLimit)}</dd>`
    + `<dt>Odbiorcy</dt><dd>${esc(guard.recipients)} z ${esc(guard.recipientLimit)}</dd>`
    + '</dl>'
    + note(guard.resetsAt
      ? `Okno ochrony przed burzą trwa ${guard.windowMinutes} minut i kończy się ${stamp(guard.resetsAt)}`
      : `Okno ochrony przed burzą trwa ${guard.windowMinutes} minut i otwiera się przy pierwszej wysyłce`);

  const groups = `<p>${data.groups > 0 ? `Grupy SMS dostępne dla klucza: ${esc(data.groups)}` : 'Do klucza nie przypisano grup SMS'}</p>`
    + note('Grupy zmienia administrator w panelu bramki');

  return `<p class="who">Połączenie <b>${esc(data.connection)}</b> w integracji <b>${esc(data.integration)}</b></p>`
    + `<div class="grid">${box('Uprawnienia połączenia', scopes)}${box('Usługi Multiinfo', services)}`
    + `${box('Limity i ochrona przed burzą', limits)}${box('Grupy SMS', groups)}</div>`;
}

/** Uruchomienie widoku w dokumencie: most, rysowanie wyniku i przycisk „Odśwież”. */
export function start(win, env) {
  const doc = win.document;
  const content = doc.getElementById('tresc');
  const notice = doc.getElementById('komunikat');

  const say = (tone, text) => {
    notice.hidden = !text;
    notice.className = `notice n-${tone}`;
    notice.textContent = text;
  };
  const show = (result) => {
    if (result.isError) return say('fail', textOf(result));
    if (result.structuredContent) content.innerHTML = renderStatus(result.structuredContent, env);
    else content.textContent = textOf(result);
    say('plain', '');
  };

  const bridge = createBridge(win, {
    version: env.version,
    onContext: (context) => applyTheme(doc, context),
    onToolResult: show,
    onToolCancelled: (reason) => say('wait', reason ? `Aplikacja AI przerwała wywołanie narzędzia: ${reason}` : 'Aplikacja AI przerwała wywołanie narzędzia'),
  });

  const action = (id, run) => doc.getElementById(id).addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await run();
    } catch (error) {
      say('fail', error instanceof Error ? error.message : String(error));
    } finally {
      button.disabled = false;
    }
  });

  action('odswiez', async () => show(await bridge.callTool('connection_status', {})));
}
