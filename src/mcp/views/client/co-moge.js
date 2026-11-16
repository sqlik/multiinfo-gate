// Widok „Co mogę?”: uprawnienia, usługi, limity i ważność połączenia według wyniku connection_status.
// Odświeżenie woła to samo narzędzie przez aplikację AI, bez kolejnego pytania do agenta.
import { applyTheme, badge, CANCEL_WINDOW, createBridge, field, fields, note, plural, pluralWord, section, stamp, textOf, tile, tiles, txt } from './bridge.js';

const connectionFields = (data) => [field('Nazwa połączenia', txt(data.connection)), field('Integracja', txt(data.integration))];

function unavailable(data) {
  return section('Połączenie', fields(...connectionFields(data)))
    + section('Połączenie jest chwilowo niedostępne', `<div class="badges">${badge('fail', 'niedostępne')}</div>`
      + note(`Przyczyna: ${data.reason}. Dostęp przywraca administrator bramki, a połączenie zadziała ponownie bez nowego kodu.`));
}

const groupsText = (n) => (n > 0
  ? `${plural(n, 'grupa', 'grupy', 'grup')} ${pluralWord(n, 'dostępna', 'dostępne', 'dostępnych')} dla klucza` : 'Do klucza nie przypisano grup SMS');

/** HTML treści widoku z `structuredContent` narzędzia connection_status; `env.scopes` to etykiety wszystkich zakresów. */
export function renderStatus(data, env = {}) {
  if (!data || data.available !== true) return unavailable(data ?? {});
  const granted = new Set((data.scopes ?? []).map((s) => s.id));
  const missing = Object.entries(env.scopes ?? {}).filter(([id]) => !granted.has(id));
  const guard = data.guard ?? {};
  const window = `w oknie ${guard.windowMinutes} minut`;
  const ends = guard.resetsAt ? stamp(guard.resetsAt) : null;

  const connection = section('Połączenie', fields(...connectionFields(data),
    field('Ważne do', txt(data.expiresAt ? stamp(data.expiresAt) : 'bez terminu')), field('Grupy SMS', txt(groupsText(data.groups)))));

  const scopes = section('Uprawnienia', `<div class="badges">${(data.scopes ?? []).map((s) => badge('ok', s.label)).join('')}</div>`
    + (missing.length > 0 ? `<div class="badges">${missing.map(([, label]) => badge('plain', `${label}: brak`)).join('')}</div>` : '')
    + note('Uprawnienia zmienia administrator bramki w integracji Agent AI'));

  const services = section('Usługi Multiinfo', fields(...(data.services ?? []).map((s) => field(`Usługa ${s.id}`, txt(s.label || 'bez nazwy w panelu'))))
    + note(`Limit części SMS-a wynosi ${data.maxParts}. ${data.overflow === 'reject' ? 'Dłuższa treść zostaje odrzucona.' : 'Dłuższa treść zostaje skrócona do tego limitu.'}`));

  const limits = section('Limity', tiles(
    tile('Żądania klucza', data.ratePerMin, 'na minutę'),
    tile('Wysyłki', `${guard.calls} z ${guard.callLimit}`, window),
    tile('Odbiorcy', `${guard.recipients} z ${guard.recipientLimit}`, window),
    ends ? tile('Okno kończy się', ends.slice(11), ends.slice(0, 10)) : tile('Okno ochrony', 'nie otwarte', 'otworzy się przy wysyłce'),
  ) + note(`Ochrona przed burzą liczy wysyłki i odbiorców w oknie ${guard.windowMinutes} minut`));

  const schedule = data.schedule
    ? section('Wysyłka z terminem', note(`Termin może przypadać najwyżej ${data.schedule.maxDays} dni naprzód. ${CANCEL_WINDOW}.`)) : '';
  return connection + scopes + services + schedule + limits;
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
