import { silentLogger, type Logger } from '../log.ts';
import type { AdminNotifier } from '../notifications/rules.ts';
import type { ReleaseInfo, SettingsRepo } from '../store/settings.ts';
import { GATE_VERSION } from '../version.ts';

export type { ReleaseInfo };

/** Najnowsze wydanie bez szkiców i wydań testowych - GitHub sam je z tego adresu wyklucza. */
export const RELEASES_URL = 'https://api.github.com/repos/sqlik/multiinfo-gate/releases/latest';
/** Strona z listą wydań i opisami zmian. */
export const RELEASES_PAGE = 'https://github.com/sqlik/multiinfo-gate/releases';
/** Instrukcja aktualizacji: Docker w rozdziale 7.4, kontener na Proxmoxie w 9.4. */
export const UPDATE_DOCS_DOCKER = 'https://sqlik.github.io/multiinfo-gate/uruchomienie/#74-aktualizacja';
export const UPDATE_DOCS_LXC = 'https://sqlik.github.io/multiinfo-gate/uruchomienie/#94-utrzymanie-w-kontenerze';

const HOUR_MS = 3_600_000;
/** Po udanym sprawdzeniu następne za dobę; po błędzie za godzinę. */
const CHECK_INTERVAL_MS = 24 * HOUR_MS;
const RETRY_INTERVAL_MS = HOUR_MS;
const REQUEST_TIMEOUT_MS = 10_000;

/** Porównanie numerów `1.2.3` człon po członie; brakujący człon to zero. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Z odpowiedzi GitHuba bierzemy tylko numer z tagu (`v1.6.0`), odnośnik do opisu i datę.
 * Szkic albo wydanie testowe zwraca `null`, tak samo tag bez numeru w postaci `x.y.z`.
 */
export function parseRelease(body: unknown): ReleaseInfo | null {
  if (typeof body !== 'object' || body === null) return null;
  const r = body as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  if (typeof r.tag_name !== 'string' || typeof r.html_url !== 'string') return null;
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(r.tag_name.trim());
  if (!m) return null;
  return { version: m[1]!, url: r.html_url, publishedAt: typeof r.published_at === 'string' ? r.published_at : null };
}

/**
 * Jedno zapytanie do GitHuba. Do GitHuba idzie wyłącznie ono - bez numeru wersji, nazwy
 * instancji ani czegokolwiek o bramce; `User-Agent` jest wymagany przez ich API, więc stały.
 */
export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<ReleaseInfo> {
  const res = await fetchImpl(RELEASES_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'multiinfo-gate' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub odpowiedział ${res.status}`);
  const info = parseRelease(await res.json());
  if (info === null) throw new Error('odpowiedź GitHuba nie zawiera numeru wydania');
  return info;
}

export interface ReleaseCheckerDeps {
  settings: SettingsRepo;
  notifier?: AdminNotifier;
  log?: Logger;
  fetch?: typeof fetch;
  currentVersion?: string;
  /** MIG_UPDATE_CHECK: wyłączone nie woła GitHuba wcale. */
  enabled?: boolean;
}

/**
 * Raz na dobę pyta GitHub o najnowsze wydanie i zapisuje wynik w ustawieniach; panel czyta go
 * stamtąd. Nowsze wydanie zgłasza jako powiadomienie z kluczem wydania - jeden mail na numer,
 * choćby sprawdzenie powtarzało się codziennie. Błąd sieci jest cichy: wpis `info` w dzienniku
 * i kolejna próba za godzinę. Wołany z tury utrzymaniowej workera, sam łapie swoje wyjątki.
 */
export class ReleaseChecker {
  constructor(private readonly deps: ReleaseCheckerDeps) {}

  async check(now: Date): Promise<void> {
    if (this.deps.enabled === false) return;
    const next = this.deps.settings.releaseNextCheckAt();
    if (next !== null && now.getTime() < Date.parse(next)) return;
    const log = this.deps.log ?? silentLogger;
    const current = this.deps.currentVersion ?? GATE_VERSION;
    try {
      const info = await fetchLatestRelease(this.deps.fetch ?? fetch);
      this.deps.settings.setLatestRelease(info, now);
      this.deps.settings.setReleaseNextCheckAt(new Date(now.getTime() + CHECK_INTERVAL_MS).toISOString(), now);
      if (compareVersions(info.version, current) > 0) {
        log.info('wydanie.nowe', { latest: info.version, current });
        this.deps.notifier?.notify('release_available', null,
          [`Dostępne wydanie ${info.version}, zainstalowane ${current}.`, `Co nowego: ${info.url}`,
            `Jak zaktualizować: Docker ${UPDATE_DOCS_DOCKER}, kontener na Proxmoxie ${UPDATE_DOCS_LXC}`].join('\n'),
          now, `release:${info.version}`);
      } else {
        log.debug('wydanie.aktualne', { latest: info.version, current });
      }
    } catch (error) {
      this.deps.settings.setReleaseNextCheckAt(new Date(now.getTime() + RETRY_INTERVAL_MS).toISOString(), now);
      log.info('wydanie.sprawdzenie_nieudane', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** Wydanie do pokazania w panelu: nowsze od zainstalowanego i nie odłożone przez administratora. */
export function pendingRelease(settings: SettingsRepo, current: string = GATE_VERSION): ReleaseInfo | null {
  const latest = settings.latestRelease();
  if (latest === null || compareVersions(latest.version, current) <= 0) return null;
  const dismissed = settings.dismissedRelease();
  if (dismissed !== null && compareVersions(latest.version, dismissed) <= 0) return null;
  return latest;
}
