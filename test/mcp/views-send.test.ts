import { describe, expect, it } from 'vitest';
import { button, buttons, field, tile, tiles, txt } from '../../src/mcp/views/client/bridge.js';
import { renderStatus } from '../../src/mcp/views/client/co-moge.js';
import { renderGroup } from '../../src/mcp/views/client/grupa.js';
import { renderTrace, sayAt, startTrace } from '../../src/mcp/views/client/przebieg.js';
import { linkMarkup, renderSend, startSend } from '../../src/mcp/views/client/send.js';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/instructions.ts';
import { TOOLS } from '../../src/mcp/tools/index.ts';
import { BUILT_VIEWS, viewHtml } from '../../src/mcp/views/index.ts';

const GUARD = { calls: 28, recipients: 990, resetsAt: '2026-11-15T10:00:00.000Z' };

const PREVIEW = {
  draftId: 'drf_1', expiresAt: '2026-11-15T09:30:00.000Z', recipients: 12, duplicatesRemoved: 1, route: 'messages',
  text: 'Przypominamy o przeglądzie klimatyzacji. Zapisy: https://l.firma.pl/0000000', parts: 2, characters: 75, encoding: 'ucs2', truncated: false,
  serviceId: '12345', services: [{ id: '12345', label: 'Serwis' }], orig: null,
  senders: [{ value: null, label: 'numer usługi Serwis (12345)' }, { value: 'SERWIS-ABC', label: 'SERWIS-ABC' }],
  links: { shortened: 1, domain: 'l.firma.pl', domains: ['l.firma.pl', 'link.firma.pl'], campaign: 'przeglad-klimatyzacji-wiosna', utm: true, mode: 'sender', notice: null },
  guard: GUARD,
};

const GROUP = {
  draftId: 'drf_2', expiresAt: '2026-11-15T09:30:00.000Z', group: { id: 4, name: 'SERWIS' }, groups: ['SERWIS', 'FLOTA'], recipients: 2,
  text: 'Ewa Nowak: Awaria w hali B.', parts: 1, characters: 27, encoding: 'gsm', truncated: false, guard: GUARD,
  groupGuard: { calls: 9, recipients: null, resetsAt: null }, orig: null, service: { id: '12345', label: 'Serwis' },
};

const stage = (local: string, label: string, detail: string | null = null) => ({ at: '2026-11-15T07:02:11.000Z', local, kind: 'queued', label, detail });

const ENTRY = {
  kind: 'message', id: 'msg_1', to: '48601000082', status: 'expired', statusLabel: 'wygasła', source: 'integracja Fakturownia - przypomnienia',
  created: { at: '2026-11-15T07:02:11.000Z', local: '15.11.2026 08:02' },
  stages: [stage('15.11.2026 08:02', 'Przyjęta przez bramkę, zapisana w kolejce'), stage('15.11.2026 20:02', 'Multiinfo', 'status 12 / 3 - <b>poza zasięgiem</b>')],
  operator: { code: '12/3', description: 'Telefon poza zasięgiem' }, cancellable: false,
  text: 'Serwisant odwiedzi Państwa jutro między 10 a 12.', packageId: null, sender: null, serviceId: '12345', encoding: 'ucs2', parts: 1,
};

/** Atrapa dokumentu widoku: elementy z identyfikatorami, kliknięcie odgrywane na korzeniu treści. */
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
  const nodes = { tresc: element(), odswiez: element(), komunikat: element() };
  const parent = { postMessage: (msg: (typeof sent)[number]) => sent.push(msg) };
  const win = {
    parent, document: { getElementById: (id: keyof typeof nodes) => nodes[id], documentElement: { dataset: {}, style: { setProperty: () => undefined } } },
    addEventListener: (type: string, fn: (event: { data: unknown; source: unknown }) => void) => { if (type === 'message') listeners.push(fn); },
  };
  const deliver = (data: unknown) => { for (const fn of listeners) fn({ data, source: parent }); };
  const click = (dataset: Record<string, string>) => {
    const button = { dataset, disabled: false };
    nodes.tresc.handlers.get('click')!({ target: { closest: (sel: string) => (sel.includes('data-act') ? button : null) } });
  };
  return { win, nodes, sent, deliver, click };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Nazwy sekcji karty w kolejności. */
const sections = (html: string) => [...html.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1]);
const msgText = (html: string) => /<div class="msg-text">([\s\S]*?)<\/div><\/div>/.exec(html)![1];
const SENT = { kind: 'messages', ids: Array.from({ length: 12 }, (_, i) => `msg_${i}`), repeated: false };

describe('widok wysyłki SMS', () => {
  it('renderSend: sekcje treści, ustawień, odbiorców, podsumowania i zatwierdzenia z równymi przyciskami', () => {
    const html = renderSend(PREVIEW, {});
    expect(sections(html)).toEqual(['Treść SMS-a', 'Ustawienia wysyłki', 'Odbiorcy: 12 numerów', 'Podsumowanie', 'Zatwierdzenie']);
    expect(html).toContain('<p class="say">Wysyłkę zatwierdza człowiek w tym widoku. Agent sam jej nie wykona.</p>');
    expect(html).toContain(buttons(button('Wyślij 12 SMS-ów', { act: 'send', kind: 'primary' }), button('Popraw treść w rozmowie', { act: 'fix' })));
    expect(html).toContain('Integracja, klucz i konto nie określają nadpisu domyślnego, dlatego SMS zostanie wysłany z numeru usługi');
  });

  it('renderSend: nazwa kampanii z <script> jako tekst, krótki link z kodem zastępczym w oknie treści', () => {
    const html = renderSend({ ...PREVIEW, links: { ...PREVIEW.links, campaign: '<script>alert(1)</script>' } }, {});
    expect(html).not.toContain('<script>');
    expect(html).toContain('value="&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(msgText(html)).toContain('<span class="lnk">https://l.firma.pl/<span class="slot">0000000</span></span>');
    expect(html).toContain('<p class="note"><span class="slot">0000000</span> oznacza kod zastępczy. Każdy odbiorca otrzyma przy wysyłce link z własnym kodem.</p>');
    expect(html).toContain('Nadawca na telefonie: <b>numer usługi Serwis (12345)</b></span><span><b>75</b> znaków · <b>2</b> części · UCS-2</span>');
  });

  it('renderSend: numery z _meta po przecinku, identyfikator klienta przed numerem, wartości jako tekst', () => {
    const html = renderSend(PREVIEW, { recipients: [{ phone: '48601000021', clientId: null }, { phone: '48601000022', clientId: '<b>K-1042</b>' }] });
    expect(html).toContain('<p class="nums">48601000021, &lt;b&gt;K-1042&lt;/b&gt;\u00a048601000022</p>');
    expect(html).toContain('<p class="lead">Pojedyncze wiadomości z raportem doręczenia każdej</p>');
    expect(html).toContain('Bramka usunęła powtórzone numery: 1');
    expect(renderSend(PREVIEW, {})).not.toContain('class="nums"');
  });

  it('renderSend: nadawca, usługa i domena zawsze jako lista wyboru, także z jedną pozycją', () => {
    const html = renderSend({ ...PREVIEW, links: { ...PREVIEW.links, domains: ['l.firma.pl'] } }, {});
    expect(html).toContain('<select class="sel" name="orig"><option value="" selected>numer usługi Serwis (12345)</option><option value="SERWIS-ABC">SERWIS-ABC</option></select>');
    expect(html).toContain('<select class="sel" name="service"><option value="12345" selected>Serwis (12345)</option></select>');
    expect(html).toContain('<select class="sel" name="domain"><option value="l.firma.pl" selected>l.firma.pl</option></select>');
  });

  it('renderSend: przełączniki kodowania i skracania w ustawieniach, rozsyłka powyżej 500 odbiorców', () => {
    const html = renderSend(PREVIEW, {});
    expect(html).toContain('<button type="button" class="on" data-act="encoding" data-enc="unicode">z polskimi · 2 części</button>');
    expect(html).toContain('<button type="button" data-act="encoding" data-enc="gsm">bez polskich · 1 część</button>');
    expect(html).toContain('<button type="button" class="on" data-act="shorten" data-on="1">skracaj</button>');
    expect(html).toContain('<button type="button" data-act="shorten" data-on="0">nie skracaj</button>');
    const pkg = renderSend({ ...PREVIEW, recipients: 600, route: 'package' }, {});
    expect(pkg).toContain('Wyślij rozsyłkę do 600 odbiorców');
    expect(pkg).toContain('<p class="lead">Rozsyłka ze wspólną treścią, raport doręczeń po zakończeniu rozsyłki</p>');
  });

  it('renderSend: wariant bez polskich znaków pokazuje w oknie treści łacińskie odpowiedniki, z polskimi znakami treść bez zmian', () => {
    const text = 'Zażółć gęślą jaźń. ŻÓŁTY ĆMA, ŚLĄSK, ŹREBIĘ, ŃANDU. Zapisy: https://l.firma.pl/0000000';
    expect(msgText(renderSend({ ...PREVIEW, text, encoding: 'gsm' }, {})))
      .toBe('Zazolc gesla jazn. ZOLTY CMA, SLASK, ZREBIE, NANDU. Zapisy: <span class="lnk">https://l.firma.pl/<span class="slot">0000000</span></span>');
    expect(msgText(renderSend({ ...PREVIEW, text, encoding: 'ucs2' }, {}))).toContain('Zażółć gęślą jaźń.');
    expect(msgText(renderGroup({ ...GROUP, text: 'Ewa Nowak: Awaria śluzy', encoding: 'gsm' }, []))).toBe('Ewa Nowak: Awaria sluzy');
  });

  it('renderSend: podsumowanie w czterech kaflach z ochroną przed burzą i ważnością podglądu', () => {
    const html = renderSend(PREVIEW, {});
    expect(html).toContain(tiles(tile('Części SMS razem', 24, '12 × 2 części'), tile('Zostało wysyłek', 28, 'w oknie ochrony'),
      tile('Zostało odbiorców', 990, 'w oknie ochrony'), tile('Podgląd ważny do', '10:30', 'potem nowy podgląd')));
    expect(html).toContain('<p class="note">Okno ochrony przed burzą kończy się o 11:00</p>');
    const open = renderSend({ ...PREVIEW, guard: { calls: 30, recipients: null, resetsAt: null } }, {});
    expect(open).toContain(tile('Zostało odbiorców', 'bez limitu', 'w oknie ochrony'));
    expect(open).toContain('<p class="note">Okno ochrony przed burzą otworzy się przy pierwszej wysyłce</p>');
  });

  it('renderSend po wysyłce: listy wyłączone, kafel doręczeń i sekcja Wysyłka bez przycisków wysyłki', () => {
    const live = renderSend(PREVIEW, { sent: SENT, deliveries: { counts: { delivered: 5, sent: 7 }, done: false } });
    expect(sections(live).at(-1)).toBe('Wysyłka');
    expect(live).not.toContain('data-act="send"');
    expect(live).toContain('<select class="sel" name="orig" disabled>');
    expect(live).toContain(tile('Doręczone', '5 z 12', 'stan odświeża się sam', 'ok'));
    expect(live).toContain('<div class="sent">Przyjęto 12 SMS-ów. Doręczone: <b>5</b> z 12 · w drodze 7 · stan odświeża się sam</div>');
    const bare = renderSend(PREVIEW, { sent: SENT, deliveries: { unavailable: true } });
    expect(bare).toContain('Przyjęto 12 wiadomości');
    expect(bare).toContain(tile('Wysyłka', 'przyjęta', '12 SMS-ów'));
  });

  it('linkMarkup ucieka treść poza krótkim linkiem', () => {
    expect(linkMarkup('<b>Zapisy</b> l.firma.pl/0000000', { links: { shortened: 1, domain: 'l.firma.pl' } }))
      .toBe('&lt;b&gt;Zapisy&lt;/b&gt; <span class="lnk">l.firma.pl/<span class="slot">0000000</span></span>');
    expect(linkMarkup('Bez linku <i>', { links: null })).toBe('Bez linku &lt;i&gt;');
  });
});

describe('widok SMS do grupy', () => {
  it('renderGroup: sekcje karty, nazwa odbiorcy <img src=x onerror=alert(1)> jako tekst przed numerem', () => {
    const html = renderGroup(GROUP, [{ phone: '48601000021', name: '<img src=x onerror=alert(1)>' }, { phone: '48601000022', name: 'Anna "Ania" Wiśniewska' }]);
    expect(sections(html)).toEqual(['Treść SMS-a', 'Ustawienia wysyłki', 'Odbiorcy: 2 osoby', 'Podsumowanie', 'Zatwierdzenie']);
    expect(html).not.toContain('<img');
    expect(html).toContain('<p class="nums">&lt;img src=x onerror=alert(1)&gt;\u00a048601000021, Anna &quot;Ania&quot; Wiśniewska\u00a048601000022</p>');
    expect(html).toContain('<p class="lead">Lista grupy SERWIS</p>');
    expect(html).toContain(buttons(button('Wyślij do 2 osób', { act: 'send', kind: 'primary' }), button('Popraw treść w rozmowie', { act: 'fix' })));
  });

  it('renderGroup: grupa i nadawca jako listy wyboru, nadawca grupy w oknie treści, bez nadpisu numer usługi', () => {
    const own = renderGroup({ ...GROUP, orig: 'SERWIS-ABC' }, []);
    expect(own).toContain('Nadawca na telefonie: <b>SERWIS-ABC</b>');
    expect(own).toContain('<select class="sel" name="group"><option value="SERWIS" selected>SERWIS</option><option value="FLOTA">FLOTA</option></select>');
    expect(own).toContain('<select class="sel" aria-label="Nadawca SMS-a"><option selected>SERWIS-ABC</option></select>');
    expect(own).toContain('Nadawcę i szablon treści określa grupa. Wysyłka nie wymaga potwierdzenia SMS-em zwrotnym.');
    expect(renderGroup(GROUP, [])).toContain('Nadawca na telefonie: <b>numer usługi Serwis (12345)</b>');
    expect(renderGroup({ ...GROUP, service: { id: '24138', label: '24138' } }, [])).toContain('<option selected>numer usługi 24138</option>');
  });

  it('renderGroup: podsumowanie z oknami ochrony agenta i grupy', () => {
    const html = renderGroup(GROUP, []);
    expect(html).toContain(tiles(tile('Części SMS razem', 2, '2 × 1 część'), tile('Zostało wysyłek', 28, 'w oknie ochrony agenta'),
      tile('Zostało wysyłek grupy', 9, 'w oknie ochrony grupy'), tile('Podgląd ważny do', '10:30', 'potem nowy podgląd')));
    expect(html).toContain('<p class="note">Okno ochrony agenta kończy się o 11:00. Okno grupy otworzy się przy pierwszej wysyłce.</p>');
  });

  it('renderGroup po wysyłce: liczby doręczeń albo samo przyjęcie bez odczytu wysłanych', () => {
    const sent = { kind: 'group', ids: ['msg_1', 'msg_2'], group: 'SERWIS', repeated: false };
    const live = renderGroup(GROUP, [], { sent, deliveries: { counts: { delivered: 1, sent: 1 }, done: false } });
    expect(live).not.toContain('data-act="send"');
    expect(live).toContain('<select class="sel" name="group" disabled>');
    expect(live).toContain('Przyjęto SMS do grupy SERWIS: 2 wiadomości. Doręczone: <b>1</b> z 2 · w drodze 1 · stan odświeża się sam');
    expect(live).toContain(tile('Doręczone', '1 z 2', 'stan odświeża się sam', 'ok'));
    const bare = renderGroup(GROUP, [], { sent, deliveries: { unavailable: true } });
    expect(bare).toContain('Przyjęto SMS do grupy SERWIS: 2 wiadomości');
    expect(bare).not.toContain('Doręczone');
  });

  it('renderGroup: nazwa grupy nadana przez agenta z <script> jako tekst', () => {
    const html = renderGroup({ ...GROUP, group: { id: 4, name: '<script>x</script>' }, groups: ['<script>x</script>'] }, []);
    expect(html).not.toContain('<script>');
  });
});

const REFUSAL = 'Wiadomość została już przekazana do sieci operatora i nie można jej anulować.';
const cancelButton = (disabled: boolean) => button('Anuluj wiadomość', { act: 'cancel', kind: 'danger', disabled, data: { index: 0 } });

describe('widok przebiegu doręczenia', () => {
  it('renderTrace: sekcja pozycji z polami, oknem treści i osią czasu', () => {
    const html = renderTrace([ENTRY]);
    expect(sections(html)).toEqual(['Wiadomość msg_1']);
    expect(html).toContain(field('Odbiorca', txt('48601000082')));
    expect(html).toContain(field('Stan', '<div class="txt"><span class="badge b-fail">wygasła</span></div>'));
    expect(html).toContain(field('Przyjęta', txt('2026-11-15 08:02')));
    expect(html).toContain('Nadawca na telefonie: <b>numer usługi 12345</b></span><span><b>48</b> znaków · <b>1</b> część · UCS-2</span>');
    expect(html).toContain('<span class="sub-lbl">Przebieg</span><ul class="timeline">');
    expect(html).toContain('Kod operatora 12/3: Telefon poza zasięgiem');
    expect(html).not.toContain('<b>poza zasięgiem</b>');
    expect(renderTrace([{ ...ENTRY, sender: 'SERWIS', encoding: 'gsm', text: 'Śluza' }])).toContain('Nadawca na telefonie: <b>SERWIS</b>');
    expect(renderTrace([])).toContain('Bramka nie znalazła wiadomości');
  });

  it('renderTrace: „Anuluj wiadomość” zawsze widoczny, czerwony przy cancellable, wyszarzony z przyczyną w pozostałych stanach', () => {
    const queued = renderTrace([{ ...ENTRY, status: 'queued', statusLabel: 'w kolejce', cancellable: true }]);
    expect(queued).toContain(buttons(cancelButton(false), button('Wyślij ponownie', { act: 'resend', kind: 'primary', data: { index: 0 } })));
    expect(queued).toContain('Multiinfo nie przekazało jeszcze wiadomości do sieci operatora, dlatego można ją anulować');
    const reason = (over: object) => renderTrace([{ ...ENTRY, ...over }]);
    expect(reason({ status: 'delivered' })).toContain(cancelButton(true));
    expect(reason({ status: 'delivered' })).toContain('Wiadomość została doręczona, dlatego anulowanie nie jest możliwe');
    expect(reason({ status: 'sent' })).toContain('Wiadomość została przekazana do sieci operatora, dlatego anulowanie nie jest możliwe');
    expect(reason({ status: 'expired' })).toContain('Wiadomość osiągnęła stan ostateczny, dlatego anulowanie nie jest możliwe');
    expect(reason({ status: 'cancelled' })).toContain('Wiadomość została anulowana');
    expect(reason({ status: 'unknown' })).toContain('Stan wiadomości jest nieznany, dlatego anulowanie nie jest możliwe');
    expect(reason({ status: 'queued' })).toContain('Anulowanie wymaga uprawnienia „Wysyłka SMS-ów”, które nadaje administrator bramki w integracji Agent AI');
    expect(reason({ kind: 'package_recipient', id: 'pkg_1#1', packageId: 'pkg_1', status: 'pending' })).toContain('Odbiorcy rozsyłki nie można anulować pojedynczo');
    const bare = reason({ status: 'queued', cancellable: true, text: null });
    expect(bare).toContain(buttons(cancelButton(false)));
    expect(bare).not.toContain('Wyślij ponownie');
  });

  it('renderTrace: oczekujący etap według stanu i etapu przekazania do Multiinfo', () => {
    expect(renderTrace([{ ...ENTRY, status: 'queued' }])).toContain('<li class="pending">Oczekiwanie na przekazanie do Multiinfo</li>');
    const inMultiinfo = [...ENTRY.stages, { ...stage('15.11.2026 08:03', 'Przekazana do Multiinfo'), kind: 'sent' }];
    expect(renderTrace([{ ...ENTRY, status: 'queued', stages: inMultiinfo }])).toContain('<li class="pending">Oczekiwanie na przekazanie do sieci operatora</li>');
    expect(renderTrace([{ ...ENTRY, status: 'throttled', stages: inMultiinfo }])).toContain('<li class="pending">Wysyłka wstrzymana limitem operatora</li>');
    expect(renderTrace([{ ...ENTRY, status: 'sent' }])).toContain('<li class="pending">Oczekiwanie na raport doręczenia</li>');
    expect(renderTrace([{ ...ENTRY, status: 'delivered' }])).not.toContain('class="pending"');
  });

  it('renderTrace: po odmowie anulowania przycisk wyszarzony, a komunikat odmowy zostaje przy pozycji', () => {
    const html = renderTrace([{ ...ENTRY, status: 'throttled', statusLabel: 'wstrzymana limitem', cancellable: true }], { refused: new Map([['msg_1', REFUSAL]]) });
    expect(html).toContain(cancelButton(true));
    expect(html).toContain(`<p class="notice n-fail" data-say="0" role="status">${REFUSAL}</p>`);
    expect(html).not.toContain('można ją jeszcze anulować');
  });

  it('startTrace: odmowa anulowania z bramki wyszarza przycisk także po ponownym rysowaniu', async () => {
    const w = viewWindow();
    startTrace(w.win, { version: '1.12.0' });
    w.deliver({ jsonrpc: '2.0', id: w.sent[0]!.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'a', version: '1' }, hostCapabilities: { serverTools: {} }, hostContext: {} } });
    await tick();
    w.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], structuredContent: { entries: [{ ...ENTRY, status: 'throttled', cancellable: true }] } } });
    expect(w.nodes.tresc.innerHTML).toContain(cancelButton(false));
    w.click({ act: 'cancel', index: '0' });
    await tick();
    const call = w.sent.find((m) => m.method === 'tools/call')!;
    expect(call.params).toEqual({ name: 'cancel_message', arguments: { id: 'msg_1' } });
    w.deliver({ jsonrpc: '2.0', id: call.id, result: { isError: true, content: [{ type: 'text', text: REFUSAL }] } });
    await tick();
    expect(w.nodes.tresc.innerHTML).toContain(cancelButton(true));
    expect(w.nodes.tresc.innerHTML).toContain(`role="status">${REFUSAL}</p>`);
  });
});

describe('doręczenia bez uprawnienia Odczyt wysłanych', () => {
  it('widoki wysyłki i grupy po wysyłce wyjaśniają, że stan doręczeń wymaga uprawnienia Odczyt wysłanych', () => {
    const NOTE = 'Stan doręczeń wymaga uprawnienia „Odczyt wysłanych”, które nadaje administrator bramki w integracji Agent AI';
    const group = renderGroup(GROUP, [], { sent: { kind: 'group', ids: ['msg_1', 'msg_2'], group: 'SERWIS', repeated: false }, deliveries: { unavailable: true } });
    const send = renderSend(PREVIEW, { sent: { kind: 'messages', ids: ['msg_1'], repeated: false }, deliveries: { unavailable: true } });
    expect(group).toContain(NOTE);
    expect(send).toContain(NOTE);
    const live = renderGroup(GROUP, [], { sent: { kind: 'group', ids: ['msg_1'], group: 'SERWIS', repeated: false }, deliveries: { counts: { delivered: 1 }, done: true } });
    expect(live).not.toContain(NOTE);
  });
});

describe('jednostka limitu ochrony przed burzą', () => {
  it('widoki wysyłki, grupy i Co mogę? liczą limit w wysyłkach, jak panel', () => {
    expect(renderSend(PREVIEW, {})).toContain(tile('Zostało wysyłek', 28, 'w oknie ochrony'));
    const group = renderGroup(GROUP, []);
    expect(group).toContain(tile('Zostało wysyłek grupy', 9, 'w oknie ochrony grupy'));
    const status = renderStatus({
      available: true, connection: 'Ewa Nowak', integration: 'Agent AI - dyspozytornia', scopes: [], expiresAt: null, services: [], maxParts: 3,
      overflow: 'reject', ratePerMin: 60, guard: { calls: 2, callLimit: 30, recipients: 15, recipientLimit: 1000, windowMinutes: 60, resetsAt: null }, groups: 0,
    }, { scopes: {} });
    expect(status).toContain('<div class="lbl">Wysyłki</div><div class="v">2 z 30</div>');
    for (const html of [renderSend(PREVIEW, {}), group, status]) expect(html.toLowerCase()).not.toContain('wywoła');
  });
});

describe('komunikaty akcji przebiegu', () => {
  it('renderTrace: ukryty komunikat każdej pozycji pod jej przyciskami, przed panelem ponownej wysyłki', () => {
    const html = renderTrace([{ ...ENTRY, cancellable: true }, ENTRY]);
    const [first, second] = html.split('</section>');
    expect(first).toContain('<p class="notice" data-say="0" role="status" hidden></p>');
    expect(first!.indexOf('data-act="resend"')).toBeLessThan(first!.indexOf('data-say="0"'));
    expect(first!.indexOf('data-say="0"')).toBeLessThan(first!.indexOf('data-resend="0"'));
    expect(second).toContain('data-say="1"');
  });

  it('sayAt pisze komunikat przy wskazanej pozycji, a pusty tekst go ukrywa', () => {
    const notices = new Map([['0', { hidden: true, className: '', textContent: '' }], ['1', { hidden: true, className: '', textContent: '' }]]);
    const root = { querySelector: (sel: string) => notices.get(/data-say="(\d+)"/.exec(sel)![1]!) ?? null };
    sayAt(root, 1)('fail', 'Wiadomość została już przekazana do sieci operatora i nie można jej anulować.');
    expect(notices.get('1')).toEqual({ hidden: false, className: 'notice n-fail', textContent: 'Wiadomość została już przekazana do sieci operatora i nie można jej anulować.' });
    expect(notices.get('0')!.hidden).toBe(true);
    sayAt(root, 1)('plain', '');
    expect(notices.get('1')!.hidden).toBe(true);
    expect(() => sayAt({ querySelector: () => null }, 5)('ok', 'x')).not.toThrow();
  });
});

describe('dokumenty widoków wysyłki, grupy i przebiegu', () => {
  it('narzędzia prepare_sms, prepare_group_sms i delivery_trace wskazują widoki, które mają dokument', () => {
    for (const name of ['prepare_sms', 'prepare_group_sms', 'delivery_trace']) {
      const view = TOOLS.find((t) => t.name === name)!.view!;
      expect(BUILT_VIEWS, name).toContain(view);
      expect(viewHtml(view)).toContain('<script type="module">');
    }
    expect(viewHtml('przebieg')).toContain('function renderSend');
  });
});

describe('wysyłka z terminem w widokach', () => {
  const SCHEDULE = { startAt: '2026-11-20T07:00:00.000Z', handoverAt: '2026-11-20T06:50:00.000Z' };
  const CANCEL_HINT = 'Anulowanie jest możliwe do chwili przekazania rozsyłki do Multiinfo, zwykle 10 minut przed terminem';
  const SCHEDULED = { ...PREVIEW, recipients: 1, route: 'package', schedule: SCHEDULE };
  const PACKAGE_SENT = { kind: 'package', id: 'pkg_9', recipients: 1, repeated: false, schedule: SCHEDULE };

  it('widok wysyłki z terminem: wiersz Termin, przycisk Zaplanuj, po wysyłce kafel Zaplanowana na i Anuluj rozsyłkę', () => {
    const html = renderSend(SCHEDULED, {});
    expect(html).toContain(field('Termin', txt('2026-11-20 08:00'), CANCEL_HINT));
    expect(html).toContain(button('Zaplanuj rozsyłkę do 1 odbiorcy', { act: 'send', kind: 'primary' }));
    expect(html).toContain('<p class="lead">Rozsyłka z terminem, raport doręczeń po zakończeniu rozsyłki</p>');
    expect(renderSend(PREVIEW, {})).not.toContain('<span class="lbl">Termin</span>');

    const after = renderSend(SCHEDULED, { sent: PACKAGE_SENT });
    expect(after).toContain(tile('Zaplanowana na', '2026-11-20 08:00', 'anulowanie do 07:50'));
    expect(after).toContain('<div class="sent">Zaplanowano rozsyłkę <span class="mono">pkg_9</span> do 1 odbiorcy na 2026-11-20 08:00</div>');
    expect(after).toContain(button('Anuluj rozsyłkę', { act: 'cancel-package', kind: 'danger' }));
    expect(after).not.toContain('Sprawdź postęp rozsyłki');
    const cancelled = renderSend(SCHEDULED, { sent: PACKAGE_SENT, cancelled: true });
    expect(cancelled).toContain('<div class="sent">Rozsyłka <span class="mono">pkg_9</span> została anulowana</div>');
    expect(cancelled).toContain(tile('Rozsyłka', 'anulowana', 'przed przekazaniem do Multiinfo'));
    expect(cancelled).not.toContain('data-act="cancel-package"');
  });

  it('widok grupy z terminem: wiersz Termin, przycisk Zaplanuj, po wysyłce kafel Zaplanowana na i Anuluj rozsyłkę', () => {
    const scheduled = { ...GROUP, schedule: SCHEDULE };
    const html = renderGroup(scheduled, []);
    expect(html).toContain(field('Termin', txt('2026-11-20 08:00'), CANCEL_HINT));
    expect(html).toContain(button('Zaplanuj wysyłkę do 2 osób', { act: 'send', kind: 'primary' }));
    expect(html).toContain('Odbiorcy rozsyłki z terminem pochodzą z listy grupy w chwili zatwierdzenia');
    const after = renderGroup(scheduled, [], { sent: { ...PACKAGE_SENT, recipients: 2 } });
    expect(after).toContain(tile('Zaplanowana na', '2026-11-20 08:00', 'anulowanie do 07:50'));
    expect(after).toContain('<div class="sent">Zaplanowano rozsyłkę <span class="mono">pkg_9</span> do 2 odbiorców na 2026-11-20 08:00</div>');
    expect(after).toContain(button('Anuluj rozsyłkę', { act: 'cancel-package', kind: 'danger' }));
  });

  it('startSend: „Anuluj rozsyłkę” po zaplanowaniu woła cancel_package i pokazuje anulowanie', async () => {
    const w = viewWindow();
    startSend(w.win, { version: '1.13.0' });
    w.deliver({ jsonrpc: '2.0', id: w.sent[0]!.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'a', version: '1' }, hostCapabilities: { serverTools: {} }, hostContext: {} } });
    await tick();
    w.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], structuredContent: SCHEDULED, _meta: { confirm: 'mig_cf_x' } } });
    w.click({ act: 'send' });
    await tick();
    const send = w.sent.filter((m) => m.method === 'tools/call').at(-1)!;
    w.deliver({ jsonrpc: '2.0', id: send.id, result: { content: [], structuredContent: PACKAGE_SENT } });
    await tick();
    w.click({ act: 'cancel-package' });
    await tick();
    const cancel = w.sent.filter((m) => m.method === 'tools/call').at(-1)!;
    expect(cancel.params).toEqual({ name: 'cancel_package', arguments: { id: 'pkg_9' } });
    w.deliver({ jsonrpc: '2.0', id: cancel.id, result: { content: [{ type: 'text', text: 'Rozsyłka pkg_9 została anulowana.' }], structuredContent: { id: 'pkg_9', status: 'cancelled' } } });
    await tick();
    expect(w.nodes.tresc.innerHTML).toContain('została anulowana</div>');
    expect(w.nodes.tresc.innerHTML).not.toContain('data-act="cancel-package"');
  });

  it('instrukcje serwera i Co mogę?: termin, anulowanie, granica 30 dni, list_packages', () => {
    expect(SERVER_INSTRUCTIONS).toContain('startAt');
    expect(SERVER_INSTRUCTIONS).toContain('najwyżej 30 dni naprzód');
    expect(SERVER_INSTRUCTIONS).toContain('cancel_package');
    expect(SERVER_INSTRUCTIONS).toContain('list_packages');
    const status = renderStatus({
      available: true, connection: 'Ewa Nowak', integration: 'Agent AI - biuro handlowe', scopes: [{ id: 'send', label: 'Wysyłka SMS' }], expiresAt: null,
      services: [{ id: '12345', label: 'Serwis' }], maxParts: 3, overflow: 'reject', ratePerMin: 60, groups: 0,
      guard: { calls: 0, callLimit: 30, recipients: 0, recipientLimit: 1000, windowMinutes: 60, resetsAt: null },
      schedule: { maxDays: 30 },
    });
    expect(status).toContain('<h3>Wysyłka z terminem</h3>');
    expect(status).toContain(`Termin może przypadać najwyżej 30 dni naprzód. ${CANCEL_HINT}.`);
  });
});
