import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_MIME } from '../../src/mcp/apps.ts';
import { field, tile, tiles, txt } from '../../src/mcp/views/client/bridge.js';
import { renderStatus } from '../../src/mcp/views/client/co-moge.js';
import { BUILT_VIEWS, viewHtml, viewResources, viewUri } from '../../src/mcp/views/index.ts';

const LABELS = {
  send: 'Wysyłka SMS-ów', send_group: 'Wysyłka do grup', read_sent: 'Odczyt wysłanych',
  campaigns: 'Wyniki kampanii', read_inbound: 'Odczyt odebranych', reply: 'Odpowiedź nadawcy',
};

const STATUS = {
  available: true, connection: 'Ewa Nowak', integration: 'Agent AI - dyspozytornia',
  scopes: [{ id: 'send', label: 'Wysyłka SMS-ów' }, { id: 'read_sent', label: 'Odczyt wysłanych' }],
  expiresAt: '2027-02-12T09:00:00.000Z', services: [{ id: '20841', label: 'Dyspozytornia' }, { id: '20842', label: null }],
  maxParts: 3, overflow: 'reject', ratePerMin: 60,
  guard: { calls: 2, callLimit: 30, recipients: 15, recipientLimit: 1000, windowMinutes: 60, resetsAt: '2026-11-15T11:40:00.000Z' }, groups: 2,
};

/** Nazwy sekcji karty w kolejności. */
const sections = (html: string) => [...html.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1]);

describe('widok Co mogę?', () => {
  it('renderStatus ucieka nazwę połączenia z <script>', () => {
    const html = renderStatus({ ...STATUS, connection: '<script>alert(1)</script>', integration: 'Agent "AI" & <i>' }, { scopes: LABELS });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<i>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Agent &quot;AI&quot; &amp; &lt;i&gt;');
  });

  it('renderStatus: sekcje Połączenie, Uprawnienia, Usługi Multiinfo i Limity, informacje w polach', () => {
    const html = renderStatus(STATUS, { scopes: LABELS });
    expect(sections(html)).toEqual(['Połączenie', 'Uprawnienia', 'Usługi Multiinfo', 'Limity']);
    expect(html).toContain(field('Nazwa połączenia', txt('Ewa Nowak')));
    expect(html).toContain(field('Integracja', txt('Agent AI - dyspozytornia')));
    expect(html).toContain(field('Ważne do', txt('2027-02-12 10:00')));
    expect(html).toContain(field('Grupy SMS', txt('2 grupy dostępne dla klucza')));
    expect(html).toContain(field('Usługa 20841', txt('Dyspozytornia')));
    expect(html).toContain(field('Usługa 20842', txt('bez nazwy w panelu')));
    expect(html).toContain('Limit części SMS-a wynosi 3. Dłuższa treść zostaje odrzucona.');
    expect(html).not.toMatch(/undefined|null|NaN/);
  });

  it('renderStatus: uprawnienia nadane i brakujące w plakietkach, zdanie o tym, kto je zmienia', () => {
    const html = renderStatus(STATUS, { scopes: LABELS });
    expect(html).toContain('<span class="badge b-ok">Wysyłka SMS-ów</span>');
    expect(html).toContain('<span class="badge b-plain">Odczyt odebranych: brak</span>');
    expect(html).toContain('Uprawnienia zmienia administrator bramki w integracji Agent AI');
  });

  it('renderStatus: limity w czterech kaflach z oknem ochrony w czasie polskim', () => {
    const html = renderStatus(STATUS, { scopes: LABELS });
    expect(html).toContain(tiles(tile('Żądania klucza', '60', 'na minutę'), tile('Wysyłki', '2 z 30', 'w oknie 60 minut'),
      tile('Odbiorcy', '15 z 1000', 'w oknie 60 minut'), tile('Okno kończy się', '12:40', '2026-11-15')));
    expect(html).toContain('Ochrona przed burzą liczy wysyłki i odbiorców w oknie 60 minut');
  });

  it('renderStatus: połączenie bez terminu, bez grup i bez otwartego okna ochrony', () => {
    const html = renderStatus({ ...STATUS, expiresAt: null, groups: 0, guard: { ...STATUS.guard, calls: 0, recipients: 0, resetsAt: null } }, { scopes: LABELS });
    expect(html).toContain(field('Ważne do', txt('bez terminu')));
    expect(html).toContain(field('Grupy SMS', txt('Do klucza nie przypisano grup SMS')));
    expect(html).toContain(tile('Okno ochrony', 'nie otwarte', 'otworzy się przy wysyłce'));
    expect(renderStatus({ ...STATUS, groups: 1 }, { scopes: LABELS })).toContain(txt('1 grupa dostępna dla klucza'));
    expect(renderStatus({ ...STATUS, groups: 5 }, { scopes: LABELS })).toContain(txt('5 grup dostępnych dla klucza'));
    expect(html).not.toMatch(/undefined|null|NaN/);
  });

  it('renderStatus: niedostępne połączenie pokazuje sekcję z plakietką i powodem jako tekst', () => {
    const html = renderStatus({ available: false, connection: 'Ewa Nowak', integration: 'Agent AI - dyspozytornia', reason: 'integracja <i>wyłączona</i>' }, { scopes: LABELS });
    expect(sections(html)).toEqual(['Połączenie', 'Połączenie jest chwilowo niedostępne']);
    expect(html).toContain('<span class="badge b-fail">niedostępne</span>');
    expect(html).toContain('Przyczyna: integracja &lt;i&gt;wyłączona&lt;/i&gt;. Dostęp przywraca administrator bramki, a połączenie zadziała ponownie bez nowego kodu.');
  });
});

describe('dokumenty widoków', () => {
  it('każdy widok bez http:// i https:// w atrybutach src i href stylów', () => {
    for (const id of BUILT_VIEWS) {
      const html = viewHtml(id);
      expect(html).toMatch(/^<!doctype html>/);
      expect(html).not.toMatch(/\b(src|href)\s*=\s*["']?(https?:)?\/\//i);
      expect(html).not.toMatch(/url\(\s*["']?(https?:)?\/\//i);
      expect(html).not.toMatch(/@import/i);
      expect(html).not.toMatch(/^\s*import\s/m);
      expect(html).toContain('<script type="module">');
    }
  });

  it('skrypt każdego dokumentu jest poprawnym modułem: pliki widoku nie powtarzają nazw po wklejeniu', () => {
    const dir = mkdtempSync(join(tmpdir(), 'widoki-'));
    try {
      for (const id of BUILT_VIEWS) {
        const script = /<script type="module">([\s\S]*)<\/script>/.exec(viewHtml(id))![1]!;
        const file = join(dir, `${id}.mjs`);
        writeFileSync(file, script);
        const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        expect(check.stderr).toBe('');
        expect(check.status).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dokument Co mogę? zawiera most, rysowanie, etykiety zakresów i przycisk Odśwież, bez prób punktu kontrolnego A', () => {
    const html = viewHtml('co-moge');
    expect(html).toContain('function createBridge');
    expect(html).toContain('function renderStatus');
    expect(html).toContain('Odczyt odebranych');
    expect(html).toContain('Odśwież');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).not.toMatch(/id="proba|view_probe|hostSummary/);
  });

  it('zasoby widoków: adres ui://multiinfo-gate, typ APP_MIME i _meta.ui bez domen zewnętrznych', () => {
    expect(viewUri('co-moge')).toBe('ui://multiinfo-gate/co-moge');
    const meta = { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } };
    expect(viewResources()).toEqual([
      { uri: 'ui://multiinfo-gate/co-moge', name: 'co-moge', title: 'Co mogę?', mimeType: APP_MIME, _meta: meta },
      { uri: 'ui://multiinfo-gate/wysylka', name: 'wysylka', title: 'Wysyłka SMS', mimeType: APP_MIME, _meta: meta },
      { uri: 'ui://multiinfo-gate/grupa', name: 'grupa', title: 'SMS do grupy', mimeType: APP_MIME, _meta: meta },
      { uri: 'ui://multiinfo-gate/przebieg', name: 'przebieg', title: 'Przebieg doręczenia', mimeType: APP_MIME, _meta: meta },
      { uri: 'ui://multiinfo-gate/kampania', name: 'kampania', title: 'Wyniki kampanii', mimeType: APP_MIME, _meta: meta },
      { uri: 'ui://multiinfo-gate/rozsylka', name: 'rozsylka', title: 'Postęp rozsyłki', mimeType: APP_MIME, _meta: meta },
      { uri: 'ui://multiinfo-gate/odpowiedzi', name: 'odpowiedzi', title: 'Odpowiedzi klientów', mimeType: APP_MIME, _meta: meta },
      { uri: 'ui://multiinfo-gate/plik', name: 'plik', title: 'Rozsyłka z pliku', mimeType: APP_MIME, _meta: meta },
      { uri: 'ui://multiinfo-gate/rozmowa', name: 'rozmowa', title: 'Rozmowa z numerem', mimeType: APP_MIME, _meta: meta },
    ]);
  });

  it('skrypt build kopiuje src/mcp/views/client do dist/mcp/views/client', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: { build: string } };
    expect(pkg.scripts.build).toContain('rm -rf dist/mcp/views/client');
    expect(pkg.scripts.build).toContain('cp -R src/mcp/views/client dist/mcp/views/client');
  });
});
