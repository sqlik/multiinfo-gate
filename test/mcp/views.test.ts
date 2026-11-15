import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_MIME } from '../../src/mcp/apps.ts';
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

describe('widok Co mogę?', () => {
  it('renderStatus ucieka nazwę połączenia z <script>', () => {
    const html = renderStatus({ ...STATUS, connection: '<script>alert(1)</script>', integration: 'Agent "AI" & <i>' }, { scopes: LABELS });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<i>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Agent &quot;AI&quot; &amp; &lt;i&gt;');
  });

  it('renderStatus: uprawnienia nadane i brakujące, ważność, usługi, limity i okno ochrony w czasie polskim', () => {
    const html = renderStatus(STATUS, { scopes: LABELS });
    expect(html).toContain('Wysyłka SMS-ów');
    expect(html).toContain('Odczyt odebranych: brak');
    expect(html).toContain('2027-02-12 10:00');
    expect(html).toContain('20841');
    expect(html).toContain('Dyspozytornia');
    expect(html).toContain('20842');
    expect(html).toContain('60 na minutę');
    expect(html).toContain('2 z 30');
    expect(html).toContain('15 z 1000');
    expect(html).toContain('2026-11-15 12:40');
    expect(html).not.toMatch(/undefined|null|NaN/);
  });

  it('renderStatus: połączenie bez terminu i bez otwartego okna ochrony', () => {
    const html = renderStatus({ ...STATUS, expiresAt: null, guard: { ...STATUS.guard, calls: 0, recipients: 0, resetsAt: null } }, { scopes: LABELS });
    expect(html).toContain('bez terminu');
    expect(html).not.toMatch(/undefined|null|NaN/);
  });

  it('renderStatus: niedostępne połączenie pokazuje powód jako tekst', () => {
    const html = renderStatus({ available: false, connection: 'Ewa Nowak', integration: 'Agent AI - dyspozytornia', reason: 'integracja <i>wyłączona</i>' }, { scopes: LABELS });
    expect(html).toContain('integracja &lt;i&gt;wyłączona&lt;/i&gt;');
    expect(html).toContain('bez nowego kodu');
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

  it('dokument Co mogę? zawiera most, rysowanie, etykiety zakresów i przyciski Odśwież oraz próbę wywołania', () => {
    const html = viewHtml('co-moge');
    expect(html).toContain('function createBridge');
    expect(html).toContain('function renderStatus');
    expect(html).toContain('Odczyt odebranych');
    expect(html).toContain('Odśwież');
    expect(html).toContain('Sprawdź wywołanie z widoku');
    expect(html).toContain('prefers-color-scheme: dark');
  });

  it('zasoby widoków: adres ui://multiinfo-gate, typ APP_MIME i _meta.ui bez domen zewnętrznych', () => {
    expect(viewUri('co-moge')).toBe('ui://multiinfo-gate/co-moge');
    expect(viewResources()).toEqual([{
      uri: 'ui://multiinfo-gate/co-moge', name: 'co-moge', title: 'Co mogę?', mimeType: APP_MIME,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } },
    }]);
  });

  it('skrypt build kopiuje src/mcp/views/client do dist/mcp/views/client', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: { build: string } };
    expect(pkg.scripts.build).toContain('rm -rf dist/mcp/views/client');
    expect(pkg.scripts.build).toContain('cp -R src/mcp/views/client dist/mcp/views/client');
  });
});
