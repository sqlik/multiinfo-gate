// Widok „Co mogę?”: uprawnienia, usługi, limity i ważność połączenia według wyniku connection_status.
// Odświeżenie woła to samo narzędzie przez aplikację AI, bez kolejnego pytania do agenta.
import { applyTheme, createBridge, esc, stamp } from './bridge.js';

const badge = (tone, text) => `<span class="badge b-${tone}">${esc(text)}</span>`;
const box = (title, inner) => `<section class="box"><h2>${esc(title)}</h2>${inner}</section>`;
const note = (text) => `<p class="note">${esc(text)}</p>`;

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
    + `<dt>Wywołania wysyłające</dt><dd>${esc(guard.calls)} z ${esc(guard.callLimit)}</dd>`
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

const textOf = (result) => (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' ');

/** Opis aplikacji z wyniku ui/initialize do próby punktu kontrolnego A; zadanie 13 usuwa go razem z view_probe. */
export function hostSummary(host) {
  const info = host?.info ?? {};
  const caps = Object.keys(host?.capabilities ?? {}).sort();
  const context = host?.context ?? {};
  const modes = Array.isArray(context.availableDisplayModes) ? context.availableDisplayModes.join(', ') : 'brak danych';
  return `Aplikacja ${info.name ? `${info.name}${info.version ? ` ${info.version}` : ''}` : 'bez nazwy'}. `
    + `Możliwości: ${caps.length > 0 ? caps.join(', ') : 'brak'}. `
    + `Tryb ${context.displayMode ?? 'nieznany'}, dostępne: ${modes}.`;
}

const PROBE_MESSAGE = 'Próba widoku bramki: tę wiadomość wysłał widok „Co mogę?”. Odpowiedz jednym zdaniem, że ją otrzymałeś.';
const PROBE_LINK = 'https://sqlik.github.io/multiinfo-gate/';

const clock = (iso) => new Date(iso).toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw' });

/** Uruchomienie widoku w dokumencie: most, rysowanie wyniku, przyciski „Odśwież” i próba wywołania. */
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
  action('proba', async () => {
    const result = await bridge.callTool('view_probe', {});
    if (result.isError) return say('fail', textOf(result));
    const probe = result.structuredContent ?? {};
    say('ok', `Wywołanie z widoku działa: bramka odpowiedziała o ${clock(probe.at)}${probe.session ? `, sesja ${probe.session}` : ''}. ${hostSummary(bridge.host())}`);
  });
  action('proba-wiadomosc', async () => {
    const sent = await bridge.sendMessage(PROBE_MESSAGE);
    say(sent ? 'ok' : 'fail', sent ? 'Aplikacja przyjęła wiadomość z widoku' : 'Aplikacja nie obsługuje wiadomości z widoku albo ją odrzuciła');
  });
  action('proba-link', async () => {
    const opened = await bridge.openLink(PROBE_LINK);
    say(opened ? 'ok' : 'fail', opened ? 'Aplikacja przyjęła prośbę o otwarcie linku' : 'Aplikacja nie obsługuje otwierania linków albo odmówiła');
  });
  action('proba-ekran', async () => say('plain', `Aplikacja ustawiła tryb: ${await bridge.requestDisplayMode('fullscreen')}`));
}
