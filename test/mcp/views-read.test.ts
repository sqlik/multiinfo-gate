import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { button, buttons, field, forwardedText, num, tile, tiles, txt } from '../../src/mcp/views/client/bridge.js';
import { barChart } from '../../src/mcp/views/client/chart.js';
import { REMIND_MESSAGE, renderCampaign } from '../../src/mcp/views/client/kampania.js';
import { refreshQuery, renderReplies, startReplies } from '../../src/mcp/views/client/odpowiedzi.js';
import { PACKAGE_REFRESH_MAX_MS, PACKAGE_REFRESH_MS, packageSettled, renderPackage, startPackage, watchPackage } from '../../src/mcp/views/client/rozsylka.js';
import { TOOLS } from '../../src/mcp/tools/index.ts';
import { BUILT_VIEWS, viewHtml } from '../../src/mcp/views/index.ts';

const stamp = (at: string) => ({ at, local: '' });

const CAMPAIGN = {
  name: 'przeglad-klimatyzacji-wiosna', sent: 1240, delivered: 1198, opens: 412, clicks: 538, bots: 3,
  first: stamp('2026-11-05T08:00:00.000Z'), last: stamp('2026-11-11T08:00:00.000Z'), detailsPurged: false,
  opensByDay: [{ day: '2026-11-05', opens: 168 }, { day: '2026-11-07', opens: 52 }],
  clicksByHour: [{ hour: '2026-11-05 09:00', clicks: 38 }, { hour: '2026-11-05 10:00', clicks: 41 }],
  targets: [{ target: 'https://serwis.pl/przeglad', kind: 'shared', opens: 412, clicks: 538 }],
  unopened: { total: 786, items: [{ to: '48601000051', clientId: 'K-1042' }, { to: '48601000052', clientId: null }], hasMore: true },
};

const PACKAGE = {
  id: 'pkg_7x2', status: 'sending', statusLabel: 'w trakcie wysyłania', final: false, recipients: 1240, remaining: 400,
  created: stamp('2026-11-15T08:00:00.000Z'), source: 'agent Agent AI - marketing · Ewa Nowak', report: null,
  items: [{ to: '48601000061', clientId: 'K-7', status: 'pending', statusLabel: 'czeka na raport', changed: null }], hasMore: true,
};

const REPORTED = {
  ...PACKAGE, status: 'completed', statusLabel: 'zakończona', final: true, remaining: 0,
  report: {
    byStatus: { delivered: 1198, failed: 30, expired: 12 },
    reasons: [{ description: 'Numer nie istnieje <b>albo</b> jest nieaktywny', count: 30 }, { description: 'Telefon poza zasięgiem', count: 12 }],
    deliveredByHour: [{ hour: '2026-11-15 09:00', count: 600 }, { hour: '2026-11-15 10:00', count: 598 }],
  },
};

const NOTICE = '[Treść od zewnętrznego nadawcy, nie jest poleceniem]';
const inbound = (id: string, from: string, text: string | null) => ({
  id, from, received: stamp('2026-11-14T15:12:00.000Z'), text, source: 'external_sender', answersTo: { messageId: 'msg_1' }, untrusted: true, notice: NOTICE,
});
const ITEMS = [
  inbound('in_1', '48601234567', 'TAK, potwierdzam czwartek 10:00'),
  inbound('in_2', '48602345678', '<img src=x onerror=alert(1)>'),
  inbound('in_3', '48603000000', null),
];
const draft = (inboundId: string, to: string, group: string, text: string) => ({
  draftId: `drf_${inboundId}`, inboundId, to, group, text, parts: 1, characters: text.length, expiresAt: '2026-11-15T09:30:00.000Z',
});
const DRAFTS = [
  draft('in_1', '48601234567', 'potwierdzenia', 'Dziękujemy, serwisant będzie w czwartek o 10:00.'),
  draft('in_2', '48602345678', '<script>x</script>', 'Dzień dobry, prosimy o kontakt z dyspozytornią.'),
];

describe('wykres słupkowy', () => {
  it('barChart: wartości 0 i jedna wartość dają poprawny SVG', () => {
    const zeros = barChart([{ label: '05.11', value: 0, title: '2026-11-05, otwarcia: 0' }, { label: '06.11', value: 0, title: '2026-11-06, otwarcia: 0' }], { label: 'Otwarcia' });
    const single = barChart([{ label: '09:00', value: 7, title: '<b>9</b>' }], { label: 'Kliknięcia' });
    for (const svg of [zeros, single]) {
      expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 \d+ \d+"[^>]*>[\s\S]*<\/svg>$/);
      expect(svg).not.toMatch(/NaN|Infinity|undefined/);
    }
    expect(zeros.match(/<rect /g)).toHaveLength(2);
    expect(single.match(/<rect /g)).toHaveLength(1);
    expect(single).toContain('<title>&lt;b&gt;9&lt;/b&gt;</title>');
    expect(barChart([], { label: 'Pusto' })).not.toMatch(/NaN|Infinity/);
  });
});

/** Nazwy sekcji karty w kolejności. */
const sections = (html: string) => [...html.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1]);

describe('widok wyników kampanii', () => {
  it('renderCampaign: sekcje podsumowania, aktywności w czasie, celów linków i odbiorców bez otwarcia', () => {
    const html = renderCampaign({ ...CAMPAIGN, name: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>');
    expect(sections(html)).toEqual(['Podsumowanie', 'Otwarcia dzień po dniu', 'Kliknięcia według celu linku', 'Odbiorcy bez otwarcia: 786']);
    expect(html).toContain('<p class="lead">Kampania &lt;script&gt;alert(1)&lt;/script&gt;</p>');
    // Liczby i udziały w zapisie panelu kampanii.
    expect(html).toContain(tiles(tile('Wysłane', num(1240), '05.11 - 11.11'), tile('Doręczone', num(1198), '96,6 % wysłanych'),
      tile('Otwarcia', num(412), '34,4 % doręczonych'), tile('Kliknięcia', num(538), '1,31 na otwarcie')));
    expect(html).toContain('kliknięcia automatów: 3');
    expect(html).toContain('<button type="button" class="on" data-mode="days">otwarcia dziennie</button>');
    expect(html).toContain('<title>2026-11-06, otwarcia: 0</title>');
    expect(html).toContain('<title>2026-11-11, otwarcia: 0</title>');
    expect(html).toContain('https://serwis.pl/przeglad');
  });

  it('renderCampaign: odbiorcy bez otwarcia po przecinku z identyfikatorem klienta przed numerem i cztery równe przyciski', () => {
    const html = renderCampaign(CAMPAIGN);
    expect(html).toContain('<p class="nums">K-1042\u00a048601000051, 48601000052</p>');
    expect(html).toContain('Widok pokazuje pierwszych 2 odbiorców. Pełną listę zawiera plik CSV.');
    expect(html).toContain(buttons(button('Przygotuj przypomnienie', { act: 'remind', kind: 'primary' }), button('Pokaż kolejnych odbiorców', { act: 'more' }),
      button('Pobierz CSV bez otwarcia', { act: 'csv', data: { file: 'unopened' } }), button('Pobierz CSV z otwarciem', { act: 'csv', data: { file: 'opened' } })));
    const one = renderCampaign({ ...CAMPAIGN, unopened: { total: 1, items: [{ to: '48601000053', clientId: '<b>K</b>' }], hasMore: false } });
    expect(one).toContain('<p class="nums">&lt;b&gt;K&lt;/b&gt;\u00a048601000053</p>');
    expect(one).not.toContain('Widok pokazuje');
    expect(one).not.toContain('data-act="more"');
  });

  it('renderCampaign: tryb godzin pokazuje kliknięcia od godziny pierwszej wysyłki w czasie polskim', () => {
    const html = renderCampaign(CAMPAIGN, { mode: 'hours' });
    expect(sections(html)[1]).toBe('Kliknięcia w pierwszych 48 godzinach od pierwszej wysyłki');
    expect(html).toContain('<button type="button" class="on" data-mode="hours">kliknięcia co godzinę</button>');
    expect(html).toContain('<title>2026-11-05 09:00, kliknięcia: 38</title>');
    expect(html).toContain('<title>2026-11-05 10:00, kliknięcia: 41</title>');
    expect(html).toContain('<title>2026-11-05 11:00, kliknięcia: 0</title>');
  });

  it('renderCampaign po usunięciu szczegółów: tylko kliknięcia i zdanie o okresie przechowywania', () => {
    const html = renderCampaign({ ...CAMPAIGN, detailsPurged: true, opensByDay: [], unopened: null });
    expect(sections(html)).toEqual(['Podsumowanie', 'Kliknięcia w pierwszych 48 godzinach od pierwszej wysyłki', 'Kliknięcia według celu linku']);
    expect(html).toContain('okresie przechowywania');
    expect(html).toContain('kliknięcia: 41');
    expect(html).not.toContain('otwarcia: ');
    expect(html).not.toContain('data-mode');
    expect(html).not.toContain('data-act="csv"');
    expect(html).not.toContain('data-act="remind"');
    expect(html).not.toContain('data-act="more"');
  });
});

describe('wiadomości widoków do rozmowy', () => {
  it('ui/message wyłącznie ze stałym tekstem bramki: przypomnienie bez nazwy kampanii, którą może nadać agent', () => {
    expect(REMIND_MESSAGE).toBe('Przygotuj przypomnienie dla odbiorców bez otwarcia kampanii pokazanej w widoku wyników');
    const dir = new URL('../../src/mcp/views/client/', import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'bridge.js')) {
      for (const [, arg] of readFileSync(new URL(file, dir), 'utf8').matchAll(/sendMessage\(([^)]*)\)/g)) {
        expect(arg, file).toMatch(/^[A-Z_]+$/);
      }
    }
  });
});

/** Atrapa dokumentu widoku: elementy z identyfikatorami, zegar i kliknięcie odgrywane na korzeniu treści. */
function viewWindow() {
  const listeners: Array<(event: { data: unknown; source: unknown }) => void> = [];
  const sent: Array<{ id?: number; method?: string; params?: Record<string, unknown> }> = [];
  const element = () => {
    const handlers = new Map<string, (event: unknown) => void>();
    return {
      innerHTML: '', textContent: '', hidden: false, className: '', handlers, querySelector: () => null,
      addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn),
    };
  };
  const nodes = { tresc: element(), odswiez: element(), komunikat: element(), 'na-zywo': element() };
  const parent = { postMessage: (msg: (typeof sent)[number]) => sent.push(msg) };
  const win = {
    parent, document: { getElementById: (id: keyof typeof nodes) => nodes[id], documentElement: { dataset: {}, style: { setProperty: () => undefined } } },
    addEventListener: (type: string, fn: (event: { data: unknown; source: unknown }) => void) => { if (type === 'message') listeners.push(fn); },
    setTimeout: () => undefined,
  };
  const deliver = (data: unknown) => { for (const fn of listeners) fn({ data, source: parent }); };
  const click = (dataset: Record<string, string>) => {
    const button = { dataset, disabled: false };
    nodes.tresc.handlers.get('click')!({ target: { closest: (sel: string) => (sel.includes('data-act') ? button : null) }, preventDefault: () => undefined });
  };
  const ready = async () => {
    deliver({ jsonrpc: '2.0', id: sent[0]!.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'a', version: '1' }, hostCapabilities: { serverTools: {} }, hostContext: {} } });
    await tick();
  };
  const lastCall = () => sent.filter((m) => m.method === 'tools/call').at(-1)!;
  const toggle = (id: string) => nodes.tresc.handlers.get('click')!({
    target: { closest: (sel: string) => (sel.startsWith('summary') ? { dataset: { id } } : null) }, preventDefault: () => undefined,
  });
  const change = (name: string, value: string) => nodes.tresc.handlers.get('change')!({ target: { name, value } });
  return { win, nodes, sent, deliver, click, ready, lastCall, toggle, change };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('wysłanie odpowiedzi w widoku', () => {
  it('potwierdzenie wysłania odpowiedzi pojawia się raz, przy pozycji, a komunikat pod tabelą zostaje pusty', async () => {
    const w = viewWindow();
    startReplies(w.win, { version: '1.12.0' });
    await w.ready();
    w.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], structuredContent: { items: [ITEMS[0]], drafts: [DRAFTS[0]] }, _meta: { confirm: 'k' } } });
    w.click({ act: 'send', id: 'in_1' });
    await tick();
    const call = w.sent.find((m) => m.method === 'tools/call')!;
    expect(call.params).toEqual({ name: 'send_reply', arguments: { draftId: 'drf_in_1', confirm: 'k' } });
    w.deliver({ jsonrpc: '2.0', id: call.id, result: { content: [], structuredContent: { kind: 'messages', ids: ['msg_9'] } } });
    await tick();
    expect(w.nodes.tresc.innerHTML.split('przyjęta do wysyłki').length - 1).toBe(1);
    expect(w.nodes.tresc.innerHTML).toContain('<span class="mono">msg_9</span>');
    expect(w.nodes.komunikat.textContent).toBe('');
    expect(w.nodes.komunikat.hidden).toBe(true);
  });
});

describe('potwierdzenie wiadomości do rozmowy', () => {
  it('po ui/message widok nie twierdzi, że prośba trafiła do rozmowy, bo aplikacja może czekać na zgodę człowieka', () => {
    expect(forwardedText('Prośba o przypomnienie'))
      .toBe('Prośba o przypomnienie została przekazana aplikacji AI. Jeżeli aplikacja poprosi o zgodę na wiadomość, zatwierdź ją w rozmowie.');
    const dir = new URL('../../src/mcp/views/client/', import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      expect(readFileSync(new URL(file, dir), 'utf8'), file).not.toContain('trafiła do rozmowy');
    }
  });
});

describe('widok postępu rozsyłki', () => {
  it('renderPackage w trakcie: sekcje rozsyłki, postępu i odbiorców, kafle postępu i przycisk kolejnych odbiorców', () => {
    const live = renderPackage(PACKAGE);
    expect(sections(live)).toEqual(['Rozsyłka pkg_7x2', 'Postęp', 'Odbiorcy']);
    expect(live).toContain(field('Stan', '<div class="txt"><span class="badge b-wait">w trakcie wysyłania</span></div>'));
    expect(live).toContain(field('Odbiorcy', txt(num(1240))));
    expect(live).toContain(tiles(tile('Odbiorcy', num(1240), 'w rozsyłce'), tile('Przekazane', num(840), 'do Multiinfo'),
      tile('Do wysłania', num(400), 'w kolejce Multiinfo'), tile('Raport', 'po wysyłce', 'widok sprawdza co 30 s')));
    expect(live).toContain('Liczby w stanach, przyczyny niedoręczeń i pliki CSV pojawią się po raporcie doręczeń');
    expect(live).not.toContain('data-act="csv"');
    expect(live).toContain('<tr><td class="nw">48601000061</td><td>K-7</td><td>czeka na raport</td><td class="nw"></td></tr>');
    expect(live).toContain(buttons(button('Pokaż kolejnych odbiorców', { act: 'more' })));
    expect(renderPackage({ ...PACKAGE, hasMore: false })).not.toContain('data-act="more"');
    expect(renderPackage({ ...PACKAGE, remaining: null })).toContain(tile('Przekazane', '-', 'czeka na Multiinfo'));
  });

  it('renderPackage po raporcie: kafle wyniku, wykres doręczeń i przyczyny z przyciskami plików', () => {
    const done = renderPackage(REPORTED);
    expect(sections(done)).toEqual(['Rozsyłka pkg_7x2', 'Wynik', 'Doręczenia w kolejnych godzinach', 'Niedoręczone według przyczyny', 'Odbiorcy']);
    expect(done).toContain(field('Stan', '<div class="txt"><span class="badge b-ok">zakończona</span></div>'));
    expect(done).toContain(tiles(tile('Doręczone', num(1198), '96,6 %', 'ok'), tile('Niedoręczone', num(30), '2,4 %'),
      tile('Przedawnione', num(12), '1,0 %'), tile('Razem', num(1240), 'odbiorców')));
    expect(done).toContain('<td>Numer nie istnieje &lt;b&gt;albo&lt;/b&gt; jest nieaktywny</td><td class="num">30</td>');
    expect(done).toContain(buttons(button('Pobierz raport CSV', { act: 'csv', kind: 'primary', data: { file: 'report' } }),
      button('Pobierz CSV niedoręczonych', { act: 'csv', data: { file: 'failed' } })));
    expect(done).toContain('<title>2026-11-15 10:00, doręczenia: 598</title>');
    const others = renderPackage({ ...REPORTED, report: { ...REPORTED.report, byStatus: { delivered: 10, cancelled: 2, blocked: 1 } } });
    expect(others).toContain('Pozostałe stany: zablokowane 1, anulowane 2');
    expect(renderPackage({ ...REPORTED, report: { ...REPORTED.report, byStatus: { delivered: 1240 } } })).not.toContain('data-file="failed"');
  });

  it('watchPackage: argumenty wywołania obliczane przy każdym odczycie, gdy przekazano funkcję', async () => {
    let limit = 25;
    const calls: unknown[] = [];
    const timers: Array<() => void> = [];
    const bridge = { callTool: async (_name: string, args: unknown) => { calls.push(args); return { structuredContent: PACKAGE }; } };
    const win = { setTimeout: (fn: () => void) => { timers.push(fn); } };
    watchPackage(bridge, win, () => ({ packageId: 'pkg_7x2', limit }), { onData: () => undefined, onEnd: () => undefined });
    timers.shift()!();
    await tick();
    limit = 50;
    timers.shift()!();
    await tick();
    expect(calls).toEqual([{ packageId: 'pkg_7x2', limit: 25 }, { packageId: 'pkg_7x2', limit: 50 }]);
  });

  it('startPackage: „Pokaż kolejnych odbiorców” pobiera porcję od liczby pokazanych i dopisuje ją do tabeli', async () => {
    const w = viewWindow();
    startPackage(w.win, { version: '1.12.0' });
    await w.ready();
    w.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], structuredContent: PACKAGE } });
    w.click({ act: 'more' });
    await tick();
    expect(w.lastCall().params).toEqual({ name: 'package_status', arguments: { packageId: 'pkg_7x2', offset: 1, limit: 25 } });
    const next = { ...PACKAGE, items: [{ ...PACKAGE.items[0], to: '48601000062', clientId: 'K-8' }], hasMore: false };
    w.deliver({ jsonrpc: '2.0', id: w.lastCall().id, result: { content: [], structuredContent: next } });
    await tick();
    expect(w.nodes.tresc.innerHTML).toContain('<td class="nw">48601000061</td><td>K-7</td>');
    expect(w.nodes.tresc.innerHTML).toContain('<td class="nw">48601000062</td><td>K-8</td>');
    expect(w.nodes.tresc.innerHTML).not.toContain('data-act="more"');
  });

  it('packageSettled: koniec odświeżania po raporcie albo po stanie ostatecznym bez raportu', () => {
    expect(packageSettled(PACKAGE)).toBe(false);
    expect(packageSettled({ ...PACKAGE, status: 'completed', final: true })).toBe(false);
    expect(packageSettled(REPORTED)).toBe(true);
    expect(packageSettled({ ...PACKAGE, status: 'failed', final: true })).toBe(true);
    expect(packageSettled({ ...PACKAGE, status: 'cancelled', final: true })).toBe(true);
  });

  it('watchPackage: package_status co 30 s do raportu, najwyżej 30 minut, błąd kończy odświeżanie', async () => {
    const run = (results: unknown[], advance: number[]) => {
      const calls: unknown[] = [];
      const timers: Array<{ fn: () => Promise<void>; ms: number }> = [];
      const events: unknown[] = [];
      let clock = 0;
      const bridge = { callTool: async (name: string, args: unknown) => { calls.push({ name, args }); return results.shift(); } };
      const win = { setTimeout: (fn: () => Promise<void>, ms: number) => { timers.push({ fn, ms }); } };
      watchPackage(bridge, win, { packageId: 'pkg_7x2', limit: 25 }, {
        onData: (d: { status: string }) => events.push(d.status), onEnd: (why: string) => events.push(`koniec: ${why}`),
      }, () => clock);
      return { calls, timers, events, step: async () => { clock += advance.shift() ?? 0; await timers.shift()!.fn(); } };
    };
    const ok = run([{ structuredContent: PACKAGE }, { structuredContent: REPORTED }], [PACKAGE_REFRESH_MS, PACKAGE_REFRESH_MS]);
    expect(ok.timers.map((t) => t.ms)).toEqual([PACKAGE_REFRESH_MS]);
    await ok.step();
    await ok.step();
    expect(ok.calls).toEqual(Array(2).fill({ name: 'package_status', args: { packageId: 'pkg_7x2', limit: 25 } }));
    expect(ok.events).toEqual(['sending', 'completed', 'koniec: settled']);
    expect(ok.timers).toEqual([]);

    const slow = run([{ structuredContent: PACKAGE }], [PACKAGE_REFRESH_MAX_MS]);
    await slow.step();
    expect(slow.events).toEqual(['sending', 'koniec: timeout']);
    expect(slow.timers).toEqual([]);

    const broken = run([{ isError: true, content: [{ type: 'text', text: 'Nie ma rozsyłki pkg_7x2.' }] }], [PACKAGE_REFRESH_MS]);
    await broken.step();
    expect(broken.events).toEqual(['koniec: error']);
    expect(broken.timers).toEqual([]);
  });
});

const items = (html: string) => [...html.matchAll(/<details class="it"[^>]*>/g)].map((m) => m[0]);

describe('widok odpowiedzi klientów', () => {
  it('renderReplies: sekcja szkiców nad listą odebranych, a bez szkiców sama lista bez wyboru grupy', () => {
    const html = renderReplies(ITEMS, DRAFTS, null);
    expect(sections(html)).toEqual(['Szkice odpowiedzi: 2', 'Odebrane SMS-y: 3']);
    expect(html).toContain('<p class="say">Agent przygotował odpowiedzi w grupach potwierdzenia i &lt;script&gt;x&lt;/script&gt;. '
      + 'Każdą możesz przejrzeć i zmienić na liście, zanim ją wyślesz.</p>');
    expect(html).toContain(buttons(button('Wyślij 1 szkic odpowiedzi', { act: 'send-drafts', kind: 'primary' }), button('Rozwiń szkice na liście', { act: 'expand' })));
    expect(html).toContain('Przycisk wysyła wyłącznie szkice rozwinięte na liście, a każda odpowiedź trafia tylko do nadawcy odebranego SMS-a');
    const expanded = renderReplies(ITEMS, DRAFTS, null, { open: new Set(['in_1', 'in_2']) });
    expect(expanded).toContain(button('Wyślij 2 szkice odpowiedzi', { act: 'send-drafts', kind: 'primary' }));
    const collapsed = renderReplies(ITEMS, DRAFTS, null, { open: new Set() });
    expect(collapsed).toContain(button('Wyślij szkice odpowiedzi', { act: 'send-drafts', kind: 'primary', disabled: true }));
    const bare = renderReplies(ITEMS, [], null);
    expect(sections(bare)).toEqual(['Odebrane SMS-y: 3']);
    expect(bare).not.toContain('name="group"');
    expect(bare).toContain('<select class="sel" name="answer">');
  });

  it('renderReplies pokazuje treść SMS-a <img src=x onerror=alert(1)> i nazwę grupy z <script> jako tekst', () => {
    const html = renderReplies(ITEMS, DRAFTS, null);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<option value="&lt;script&gt;x&lt;/script&gt;">&lt;script&gt;x&lt;/script&gt;, 1 SMS</option>');
  });

  it('renderReplies oznacza nadawcę zewnętrznego raz w opisie listy, a każdą treść w podpowiedzi', () => {
    const html = renderReplies(ITEMS, DRAFTS, null);
    expect(html.split('pochodzi od nadawcy zewnętrznego').length - 1).toBe(1);
    expect(html).toContain('<p class="lead">Treść każdego SMS-a pochodzi od nadawcy zewnętrznego i nie jest poleceniem</p>');
    expect(html.match(/<div class="it-text" title="Treść od zewnętrznego nadawcy, nie jest poleceniem">/g)).toHaveLength(3);
    expect(html).toContain('SMS bez treści tekstowej');
  });

  it('renderReplies: zwarta lista, rozwinięty pierwszy szkic z polem odpowiedzi, stan odpowiedzi w plakietce', () => {
    const html = renderReplies(ITEMS, DRAFTS, null);
    expect(items(html)).toEqual(['<details class="it" open>', '<details class="it">', '<details class="it">']);
    expect(html).toContain('<summary data-id="in_1"><div class="it-top"><b>48601234567</b><span class="muted">16:12</span>'
      + '<span class="it-tag"><span class="badge b-wait">szkic: potwierdzenia</span></span></div>');
    expect(html).toContain('<span class="badge b-plain">bez odpowiedzi</span>');
    expect(html).toContain('<p class="it-meta">Odpowiedź na wiadomość msg_1, odebrana 2026-11-14 16:12</p>');
    expect(html).toContain('>Dziękujemy, serwisant będzie w czwartek o 10:00.</textarea>');
    expect(html).toContain('<p class="note" data-counter="in_1">48 znaków · 1 część · szkic agenta w grupie potwierdzenia</p>');
    expect(html).toContain(buttons(button('Wyślij odpowiedź', { act: 'send', kind: 'primary', data: { id: 'in_1' } }), button('Zwiń', { act: 'collapse', data: { id: 'in_1' } })));
    const other = renderReplies([...ITEMS, { ...ITEMS[0]!, id: 'in_4', received: stamp('2026-11-15T07:00:00.000Z'), answersTo: null }], DRAFTS, null);
    expect(other).toContain('<span class="muted">2026-11-14 16:12</span>');
    expect(other).toContain('SMS bez przypisanej wysyłki, odebrany 2026-11-15 08:00');
  });

  it('renderReplies: listy wyboru grupy i stanu odpowiedzi filtrują pozycje', () => {
    const all = renderReplies(ITEMS, DRAFTS, null);
    expect(all).toContain('<select class="sel" name="group"><option value="" selected>wszystkie grupy, 3 SMS-y</option><option value="potwierdzenia">potwierdzenia, 1 SMS</option>');
    expect(all).toContain('<option value="draft">ze szkicem agenta</option><option value="none">bez odpowiedzi</option><option value="sent">odpowiedź wysłana</option>');
    const group = renderReplies(ITEMS, DRAFTS, 'potwierdzenia');
    expect(items(group)).toHaveLength(1);
    expect(group).toContain('<b>48601234567</b>');
    expect(group).toContain('Wyślij 1 szkic odpowiedzi');
    const none = renderReplies(ITEMS, DRAFTS, null, { answer: 'none' });
    expect(items(none)).toHaveLength(1);
    expect(none).toContain('<b>48603000000</b>');
    const sent = renderReplies(ITEMS, DRAFTS, null, { answer: 'sent', sent: new Map([['in_2', 'msg_9']]) });
    expect(items(sent)).toHaveLength(1);
    expect(sent).toContain('<span class="badge b-ok">odpowiedź wysłana</span>');
    expect(sent).toContain('Wyślij 1 szkic odpowiedzi');
    const done = renderReplies(ITEMS, DRAFTS, null, { sent: new Map([['in_1', 'msg_8'], ['in_2', 'msg_9']]) });
    expect(done).toContain(button('Wszystkie szkice wysłane', { act: 'send-drafts', kind: 'primary', disabled: true }));
  });

  it('refreshQuery pomija until, gdy bramka zgłosiła koniec przedziału bliski chwili odczytu', () => {
    const input = { since: '2026-11-15 08:00', until: '2026-11-15 09:55', sender: '601234567' };
    expect(refreshQuery(input, true)).toEqual({ since: '2026-11-15 08:00', sender: '601234567' });
    expect(refreshQuery(input, false)).toBe(input);
    expect(input.until).toBe('2026-11-15 09:55');
  });

  it('startReplies: bez rozwinięcia „Wyślij” obejmuje tylko szkic widoczny na liście', async () => {
    const w = viewWindow();
    startReplies(w.win, { version: '1.12.0' });
    await w.ready();
    w.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], structuredContent: { items: ITEMS.slice(0, 2), drafts: DRAFTS }, _meta: { confirm: 'k' } } });
    w.click({ act: 'send-drafts' });
    await tick();
    expect(w.lastCall().params).toEqual({ name: 'send_reply', arguments: { draftId: 'drf_in_1', confirm: 'k' } });
    const calls = w.sent.filter((m) => m.method === 'tools/call').length;
    w.deliver({ jsonrpc: '2.0', id: w.lastCall().id, result: { content: [], structuredContent: { kind: 'messages', ids: ['msg_8'] } } });
    await tick();
    expect(w.sent.filter((m) => m.method === 'tools/call')).toHaveLength(calls);
    expect(w.nodes.tresc.innerHTML).toContain('Wyślij szkice odpowiedzi');
  });

  it('startReplies: po „Rozwiń szkice na liście” „Wyślij 2 szkice odpowiedzi” wysyła szkice po kolei z kluczem potwierdzenia', async () => {
    const w = viewWindow();
    startReplies(w.win, { version: '1.12.0' });
    await w.ready();
    w.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], structuredContent: { items: ITEMS.slice(0, 2), drafts: DRAFTS }, _meta: { confirm: 'k' } } });
    w.click({ act: 'expand' });
    w.click({ act: 'send-drafts' });
    await tick();
    expect(w.lastCall().params).toEqual({ name: 'send_reply', arguments: { draftId: 'drf_in_1', confirm: 'k' } });
    w.deliver({ jsonrpc: '2.0', id: w.lastCall().id, result: { content: [], structuredContent: { kind: 'messages', ids: ['msg_8'] } } });
    await tick();
    expect(w.lastCall().params).toEqual({ name: 'send_reply', arguments: { draftId: 'drf_in_2', confirm: 'k' } });
    w.deliver({ jsonrpc: '2.0', id: w.lastCall().id, result: { content: [], structuredContent: { kind: 'messages', ids: ['msg_9'] } } });
    await tick();
    expect(w.nodes.tresc.innerHTML.match(/<span class="badge b-ok">odpowiedź wysłana<\/span>/g)).toHaveLength(2);
    expect(w.nodes.tresc.innerHTML).toContain('Wszystkie szkice wysłane');
    expect(w.nodes.komunikat.hidden).toBe(true);
  });

  it('startReplies: błąd drugiej odpowiedzi przerywa wysyłanie i podaje, ile odpowiedzi wysłano', async () => {
    const w = viewWindow();
    startReplies(w.win, { version: '1.12.0' });
    await w.ready();
    w.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], structuredContent: { items: ITEMS.slice(0, 2), drafts: DRAFTS }, _meta: { confirm: 'k' } } });
    w.click({ act: 'expand' });
    w.click({ act: 'send-drafts' });
    await tick();
    w.deliver({ jsonrpc: '2.0', id: w.lastCall().id, result: { content: [], structuredContent: { kind: 'messages', ids: ['msg_8'] } } });
    await tick();
    w.deliver({ jsonrpc: '2.0', id: w.lastCall().id, result: { isError: true, content: [{ type: 'text', text: 'Szkic wygasł.' }] } });
    await tick();
    expect(w.nodes.komunikat.textContent).toBe('Wysłano 1 z 2 odpowiedzi. Szkic wygasł.');
  });

  it('startReplies: kliknięcie wiersza rozwija i zwija pozycję, a lista stanu odpowiedzi filtruje', async () => {
    const w = viewWindow();
    startReplies(w.win, { version: '1.12.0' });
    await w.ready();
    w.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], structuredContent: { items: ITEMS, drafts: DRAFTS } } });
    w.toggle('in_3');
    expect(items(w.nodes.tresc.innerHTML)).toEqual(['<details class="it" open>', '<details class="it">', '<details class="it" open>']);
    w.click({ act: 'collapse', id: 'in_1' });
    expect(items(w.nodes.tresc.innerHTML)).toEqual(['<details class="it">', '<details class="it">', '<details class="it" open>']);
    w.click({ act: 'expand' });
    expect(items(w.nodes.tresc.innerHTML)).toEqual(['<details class="it" open>', '<details class="it" open>', '<details class="it" open>']);
    w.change('answer', 'none');
    expect(items(w.nodes.tresc.innerHTML)).toHaveLength(1);
  });
});

describe('dokumenty widoków odczytu', () => {
  it('narzędzia campaign_results, package_status, list_inbound i prepare_replies wskazują widoki, które mają dokument', () => {
    for (const name of ['campaign_results', 'package_status', 'list_inbound', 'prepare_replies']) {
      const view = TOOLS.find((t) => t.name === name)!.view!;
      expect(BUILT_VIEWS, name).toContain(view);
      expect(viewHtml(view)).toContain('<script type="module">');
    }
    expect(viewHtml('odpowiedzi')).toContain('function measure');
  });
});
