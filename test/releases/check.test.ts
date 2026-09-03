import { beforeEach, describe, expect, it } from 'vitest';
import {
  compareVersions, fetchLatestRelease, parseRelease, pendingRelease, ReleaseChecker, RELEASES_PAGE, RELEASES_URL,
} from '../../src/releases/check.ts';
import type { NotificationEvent } from '../../src/notifications/rules.ts';
import { openDatabase } from '../../src/store/db.ts';
import { SettingsRepo } from '../../src/store/settings.ts';

const T0 = new Date('2026-09-03T08:00:00Z');
const plusHours = (h: number) => new Date(T0.getTime() + h * 3_600_000);

const releaseBody = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag, html_url: `https://github.com/sqlik/multiinfo-gate/releases/tag/${tag}`,
  published_at: '2026-09-10T12:00:00Z', draft: false, prerelease: false, ...extra,
});

type Notified = { event: NotificationEvent; subjectKey: string | null; summary: string; dedupKey: string | undefined };

/** Atrapa fetch: zwraca zadaną odpowiedź albo rzuca; liczy wywołania i zapamiętuje nagłówki. */
function fakeFetch(answer: () => Response | Error) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
    const a = answer();
    if (a instanceof Error) throw a;
    return a;
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('compareVersions', () => {
  it('porównuje numerycznie człon po członie', () => {
    expect(compareVersions('1.5.0', '1.5.0')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.3')).toBeGreaterThan(0);
    expect(compareVersions('1.5.0', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('1.5', '1.5.1')).toBeLessThan(0);
  });
});

describe('parseRelease', () => {
  it('bierze numer z tagu bez „v”, odnośnik i datę', () => {
    expect(parseRelease(releaseBody('v1.6.0'))).toEqual({
      version: '1.6.0', url: 'https://github.com/sqlik/multiinfo-gate/releases/tag/v1.6.0', publishedAt: '2026-09-10T12:00:00Z',
    });
  });

  it('odrzuca szkice, wydania testowe i odpowiedzi bez tagu', () => {
    expect(parseRelease(releaseBody('v1.6.0', { draft: true }))).toBeNull();
    expect(parseRelease(releaseBody('v1.6.0-rc.1', { prerelease: true }))).toBeNull();
    expect(parseRelease({ html_url: 'x' })).toBeNull();
    expect(parseRelease(releaseBody('nightly'))).toBeNull();
    expect(parseRelease('tekst')).toBeNull();
  });

  it('odnośnik spoza repozytorium na GitHubie zastępuje stroną wydań', () => {
    expect(parseRelease(releaseBody('v1.6.0', { html_url: 'javascript:alert(1)' }))?.url).toBe(RELEASES_PAGE);
    expect(parseRelease(releaseBody('v1.6.0', { html_url: 'https://evil.example/sqlik/multiinfo-gate/releases' }))?.url).toBe(RELEASES_PAGE);
    expect(parseRelease(releaseBody('v1.6.0', { html_url: 'http://github.com/sqlik/multiinfo-gate/releases/tag/v1.6.0' }))?.url).toBe(RELEASES_PAGE);
  });
});

describe('fetchLatestRelease', () => {
  it('pyta GitHub o najnowsze wydanie z nagłówkiem User-Agent bez numeru wersji', async () => {
    const f = fakeFetch(() => json(releaseBody('v1.6.0')));
    const info = await fetchLatestRelease(f.impl);
    expect(info.version).toBe('1.6.0');
    expect(f.calls[0]!.url).toBe(RELEASES_URL);
    expect(f.calls[0]!.headers['User-Agent']).toBe('multiinfo-gate');
    expect(f.calls[0]!.headers.Accept).toBe('application/vnd.github+json');
  });

  it('błąd HTTP i niepoprawna odpowiedź są wyjątkiem z opisem', async () => {
    await expect(fetchLatestRelease(fakeFetch(() => json({ message: 'rate limit' }, 403)).impl)).rejects.toThrow('403');
    await expect(fetchLatestRelease(fakeFetch(() => json({ tag_name: 'nightly' })).impl)).rejects.toThrow('nie zawiera numeru wydania');
  });
});

describe('ReleaseChecker', () => {
  let settings: SettingsRepo;
  let notified: Notified[];
  const notifier = { notify: (event: NotificationEvent, subjectKey: string | null, summary: string, _now: Date, dedupKey?: string) => { notified.push({ event, subjectKey, summary, dedupKey }); } };
  const checker = (answer: () => Response | Error, opts: { enabled?: boolean; current?: string } = {}) => {
    const f = fakeFetch(answer);
    const c = new ReleaseChecker({ settings, notifier, fetch: f.impl, currentVersion: opts.current ?? '1.5.0', enabled: opts.enabled ?? true });
    return { c, calls: f.calls };
  };

  beforeEach(() => {
    settings = new SettingsRepo(openDatabase(':memory:'));
    notified = [];
  });

  it('nowsze wydanie zapisuje w ustawieniach i zgłasza jedno powiadomienie z kluczem wydania', async () => {
    const { c } = checker(() => json(releaseBody('v1.6.0')));
    await c.check(T0);
    expect(settings.latestRelease()).toEqual({ version: '1.6.0', url: 'https://github.com/sqlik/multiinfo-gate/releases/tag/v1.6.0', publishedAt: '2026-09-10T12:00:00Z' });
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ event: 'release_available', subjectKey: null, dedupKey: 'release:1.6.0' });
    expect(notified[0]!.summary).toContain('1.6.0');
    expect(notified[0]!.summary).toContain('1.5.0');
    expect(notified[0]!.summary).toContain('https://github.com/sqlik/multiinfo-gate/releases/tag/v1.6.0');
  });

  it('to samo albo starsze wydanie nie budzi nikogo, ale wynik sprawdzenia jest zapisany', async () => {
    const { c } = checker(() => json(releaseBody('v1.5.0')));
    await c.check(T0);
    expect(notified).toEqual([]);
    expect(settings.latestRelease()?.version).toBe('1.5.0');
    const older = checker(() => json(releaseBody('v1.4.1')));
    await older.c.check(plusHours(25));
    expect(notified).toEqual([]);
  });

  it('po udanym sprawdzeniu pyta ponownie dopiero po dobie', async () => {
    const { c, calls } = checker(() => json(releaseBody('v1.6.0')));
    await c.check(T0);
    await c.check(plusHours(1));
    await c.check(plusHours(23));
    expect(calls).toHaveLength(1);
    await c.check(plusHours(24));
    expect(calls).toHaveLength(2);
    // Drugie sprawdzenie tego samego wydania: ten sam klucz - notifier dostaje wpis, deduplikacja jest w kolejce.
    expect(notified.every((n) => n.dedupKey === 'release:1.6.0')).toBe(true);
  });

  it('po błędzie sieci albo GitHuba próbuje ponownie po godzinie i nic nie zgłasza', async () => {
    let fail = true;
    const { c, calls } = checker(() => (fail ? new Error('ECONNRESET') : json(releaseBody('v1.6.0'))));
    await c.check(T0);
    expect(notified).toEqual([]);
    expect(settings.latestRelease()).toBeNull();
    await c.check(plusHours(0.5));
    expect(calls).toHaveLength(1);
    fail = false;
    await c.check(plusHours(1));
    expect(calls).toHaveLength(2);
    expect(settings.latestRelease()?.version).toBe('1.6.0');
  });

  it('wyłączone sprawdzanie nie woła GitHuba', async () => {
    const { c, calls } = checker(() => json(releaseBody('v1.6.0')), { enabled: false });
    await c.check(T0);
    expect(calls).toEqual([]);
    expect(settings.latestRelease()).toBeNull();
  });
});

describe('pendingRelease', () => {
  let settings: SettingsRepo;
  beforeEach(() => { settings = new SettingsRepo(openDatabase(':memory:')); });

  it('zwraca nowsze wydanie, dopóki nie zostanie odłożone; nowsze od odłożonego znów widać', () => {
    expect(pendingRelease(settings, '1.5.0')).toBeNull();
    settings.setLatestRelease({ version: '1.6.0', url: 'u', publishedAt: null }, T0);
    expect(pendingRelease(settings, '1.5.0')?.version).toBe('1.6.0');
    expect(pendingRelease(settings, '1.6.0')).toBeNull();
    settings.setDismissedRelease('1.6.0', T0);
    expect(pendingRelease(settings, '1.5.0')).toBeNull();
    settings.setLatestRelease({ version: '1.6.1', url: 'u', publishedAt: null }, T0);
    expect(pendingRelease(settings, '1.5.0')?.version).toBe('1.6.1');
  });
});
