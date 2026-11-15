import { describe, expect, it } from 'vitest';
import { renderGroup } from '../../src/mcp/views/client/grupa.js';
import { renderTrace, sayAt } from '../../src/mcp/views/client/przebieg.js';
import { linkMarkup, renderSend } from '../../src/mcp/views/client/send.js';
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
  kind: 'message', id: 'msg_1', to: '48602345678', status: 'expired', statusLabel: 'wygasła', source: 'integracja Fakturownia - przypomnienia',
  created: { at: '2026-11-15T07:02:11.000Z', local: '15.11.2026 08:02' },
  stages: [stage('15.11.2026 08:02', 'Przyjęta przez bramkę, zapisana w kolejce'), stage('15.11.2026 20:02', 'Multiinfo', 'status 12 / 3 - <b>poza zasięgiem</b>')],
  operator: { code: '12/3', description: 'Telefon poza zasięgiem' }, cancellable: false,
  text: 'Serwisant odwiedzi Państwa jutro między 10 a 12.', packageId: null,
};

describe('widok wysyłki SMS', () => {
  it('renderSend: nazwa kampanii z <script> jako tekst, krótki link podświetlony', () => {
    const html = renderSend({ ...PREVIEW, links: { ...PREVIEW.links, campaign: '<script>alert(1)</script>' } }, {});
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<span class="lnk">https://l.firma.pl/0000000</span>');
  });

  it('renderSend: lista odbiorców z _meta z identyfikatorem klienta, wartości jako tekst', () => {
    const html = renderSend(PREVIEW, { recipients: [{ phone: '48601000021', clientId: null }, { phone: '48601000022', clientId: '<b>K-1042</b>' }] });
    // Przy identyfikatorach klientów każdy wiersz ma dwie kolumny, dlatego numery stoją w jednej kolumnie.
    expect(html).toContain('<div class="recips"><div><span></span><span class="mono">+48 601 000 021</span></div>');
    expect(html).toContain('<div><span>&lt;b&gt;K-1042&lt;/b&gt;</span><span class="mono">+48 601 000 022</span></div>');
    expect(renderSend(PREVIEW, { recipients: [{ phone: '48601000021', clientId: null }] }))
      .toContain('<div class="recips"><div><span class="mono">+48 601 000 021</span></div></div>');
    expect(renderSend(PREVIEW, {})).not.toContain('class="recips"');
  });

  it('renderSend: numer usługi jako „numer usługi Serwis (12345)”', () => {
    const html = renderSend(PREVIEW, {});
    expect(html).toContain('numer usługi Serwis (12345)');
    expect(html).toContain('Wyślij 12 SMS-ów');
    expect(html).toContain('Popraw treść w rozmowie');
  });

  it('renderSend: przełącznik kodowania z liczbą części obu wariantów, rozsyłka powyżej 500 odbiorców', () => {
    const html = renderSend(PREVIEW, {});
    expect(html).toContain('data-enc="unicode"');
    expect(html).toContain('data-enc="gsm"');
    expect(renderSend({ ...PREVIEW, recipients: 600, route: 'package' }, {})).toContain('Wyślij rozsyłkę do 600 odbiorców');
  });

  it('renderSend: wariant bez polskich znaków pokazuje w dymku łacińskie odpowiedniki, z polskimi znakami treść bez zmian', () => {
    const text = 'Zażółć gęślą jaźń. ŻÓŁTY ĆMA, ŚLĄSK, ŹREBIĘ, ŃANDU. Zapisy: https://l.firma.pl/0000000';
    const bubble = (html: string) => /<div class="bubble">([\s\S]*?)<\/div>/.exec(html)![1];
    expect(bubble(renderSend({ ...PREVIEW, text, encoding: 'gsm' }, {})))
      .toBe('Zazolc gesla jazn. ZOLTY CMA, SLASK, ZREBIE, NANDU. Zapisy: <span class="lnk">https://l.firma.pl/0000000</span>');
    expect(bubble(renderSend({ ...PREVIEW, text, encoding: 'ucs2' }, {}))).toContain('Zażółć gęślą jaźń.');
    expect(bubble(renderGroup({ ...GROUP, text: 'Ewa Nowak: Awaria śluzy', encoding: 'gsm' }, []))).toBe('Ewa Nowak: Awaria sluzy');
  });

  it('renderSend po wysyłce: bez przycisku wysyłki, liczby doręczeń albo samo przyjęcie bez odczytu wysłanych', () => {
    const sent = { kind: 'messages', ids: Array.from({ length: 12 }, (_, i) => `msg_${i}`), repeated: false };
    const live = renderSend(PREVIEW, { sent, deliveries: { counts: { delivered: 5, sent: 7 }, done: false } });
    expect(live).not.toContain('data-act="send"');
    expect(live).toContain('Doręczone: <b>5</b> z 12');
    expect(renderSend(PREVIEW, { sent, deliveries: { unavailable: true } })).toContain('Przyjęto 12 wiadomości');
  });

  it('linkMarkup ucieka treść poza krótkim linkiem', () => {
    expect(linkMarkup('<b>Zapisy</b> l.firma.pl/0000000', { links: { shortened: 1, domain: 'l.firma.pl' } }))
      .toBe('&lt;b&gt;Zapisy&lt;/b&gt; <span class="lnk">l.firma.pl/0000000</span>');
    expect(linkMarkup('Bez linku <i>', { links: null })).toBe('Bez linku &lt;i&gt;');
  });
});

describe('widok SMS do grupy', () => {
  it('renderGroup pokazuje nazwę odbiorcy <img src=x onerror=alert(1)> jako tekst', () => {
    const html = renderGroup(GROUP, [{ phone: '48601000021', name: '<img src=x onerror=alert(1)>' }, { phone: '48601000022', name: 'Anna "Ania" Wiśniewska' }]);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Anna &quot;Ania&quot; Wiśniewska');
    expect(html).toContain('Wyślij do 2 osób');
  });

  it('renderGroup: nadawca grupy w dymku i w wierszu „Nadawca SMS-a”, bez nadpisu numer usługi', () => {
    const own = renderGroup({ ...GROUP, orig: 'SERWIS-ABC' }, []);
    expect(own).toContain('<div class="phone-from">SERWIS-ABC</div>');
    expect(own).toContain('<dt>Nadawca SMS-a</dt><dd>SERWIS-ABC, według ustawień grupy</dd>');
    expect(renderGroup(GROUP, [])).toContain('<div class="phone-from">numer usługi Serwis (12345)</div>');
    expect(renderGroup({ ...GROUP, service: { id: '24138', label: '24138' } }, [])).toContain('<dd>numer usługi 24138, według ustawień grupy</dd>');
  });

  it('renderGroup po wysyłce: liczby doręczeń albo samo przyjęcie bez odczytu wysłanych', () => {
    const sent = { kind: 'group', ids: ['msg_1', 'msg_2'], group: 'SERWIS', repeated: false };
    const live = renderGroup(GROUP, [], { sent, deliveries: { counts: { delivered: 1, sent: 1 }, done: false } });
    expect(live).not.toContain('data-act="send"');
    expect(live).toContain('Przyjęto SMS do grupy SERWIS: 2 wiadomości. Doręczone: <b>1</b> z 2 · w drodze 1 · stan odświeża się sam');
    const bare = renderGroup(GROUP, [], { sent, deliveries: { unavailable: true } });
    expect(bare).toContain('Przyjęto SMS do grupy SERWIS: 2 wiadomości');
    expect(bare).not.toContain('Doręczone');
  });

  it('renderGroup: nazwa grupy nadana przez agenta z <script> jako tekst', () => {
    const html = renderGroup({ ...GROUP, group: { id: 4, name: '<script>x</script>' }, groups: ['<script>x</script>'] }, []);
    expect(html).not.toContain('<script>');
  });
});

describe('widok przebiegu doręczenia', () => {
  it('renderTrace: „Anuluj” tylko przy cancellable, „Wyślij ponownie” tylko przy treści', () => {
    const plain = renderTrace([ENTRY]);
    expect(plain).not.toContain('Anuluj');
    expect(plain).toContain('Wyślij ponownie');
    expect(plain).not.toContain('<b>poza zasięgiem</b>');
    expect(plain).toContain('Telefon poza zasięgiem');
    const cancellable = renderTrace([{ ...ENTRY, status: 'queued', statusLabel: 'w kolejce', cancellable: true, text: null }]);
    expect(cancellable).toContain('Anuluj');
    expect(cancellable).not.toContain('Wyślij ponownie');
    expect(renderTrace([])).toContain('Bramka nie znalazła wiadomości');
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
