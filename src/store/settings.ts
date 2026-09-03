import type { Database } from 'better-sqlite3';

/** Klucze ustawień instancji - stałe, żeby literówka była błędem kompilacji, nie pustym wierszem. */
export const SETTING_API_URL = 'api_url';
/** Najnowsze wydanie odczytane z GitHuba (JSON: version, url, publishedAt). */
export const SETTING_RELEASE_LATEST = 'release_latest';
/** Kiedy najwcześniej znów pytać GitHub o wydania. */
export const SETTING_RELEASE_NEXT_CHECK = 'release_next_check_at';
/** Wydanie, które administrator odłożył przyciskiem na przeglądzie - pasek wraca przy nowszym. */
export const SETTING_RELEASE_DISMISSED = 'release_dismissed';

export interface ReleaseInfo { version: string; url: string; publishedAt: string | null }

/** Ustawienia instancji w jednej tabeli klucz-wartość; brak wiersza to brak ustawienia. */
export class SettingsRepo {
  constructor(private readonly db: Database) {}

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string | null, at: Date): void {
    if (value === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      return;
    }
    this.db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(key, value, at.toISOString());
  }

  /** Adres bramki widziany przez aplikacje, bez końcowego ukośnika, np. https://sms.firma.pl albo http://10.10.10.159:8080. */
  apiUrl(): string | null {
    return this.get(SETTING_API_URL);
  }

  setApiUrl(url: string | null, at: Date): void {
    this.set(SETTING_API_URL, url, at);
  }

  latestRelease(): ReleaseInfo | null {
    const raw = this.get(SETTING_RELEASE_LATEST);
    if (raw === null) return null;
    try {
      const v = JSON.parse(raw) as Partial<ReleaseInfo>;
      if (typeof v.version !== 'string' || typeof v.url !== 'string') return null;
      return { version: v.version, url: v.url, publishedAt: typeof v.publishedAt === 'string' ? v.publishedAt : null };
    } catch {
      return null;
    }
  }

  setLatestRelease(info: ReleaseInfo, at: Date): void {
    this.set(SETTING_RELEASE_LATEST, JSON.stringify(info), at);
  }

  releaseNextCheckAt(): string | null {
    return this.get(SETTING_RELEASE_NEXT_CHECK);
  }

  setReleaseNextCheckAt(iso: string, at: Date): void {
    this.set(SETTING_RELEASE_NEXT_CHECK, iso, at);
  }

  dismissedRelease(): string | null {
    return this.get(SETTING_RELEASE_DISMISSED);
  }

  setDismissedRelease(version: string | null, at: Date): void {
    this.set(SETTING_RELEASE_DISMISSED, version, at);
  }
}
