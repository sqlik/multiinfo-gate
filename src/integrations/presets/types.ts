import type { InboundConfig, IntegrationKind, OutboundConfig } from '../config.ts';

export interface PresetField { path: string; label: string }

export interface PresetSecret { ref: string; label: string; hint: string }

/**
 * Gotowe ustawienie: wypełnia formularz i podpowiada pola; po zapisie nie ma sprzężenia
 * z ustawieniem. Każde ma test „przykładowy ładunek daje oczekiwany wynik”, który strzeże
 * szablonu przed regresją - stąd `sample` i `expect` obok konfiguracji.
 */
export interface Preset {
  id: string;
  name: string;
  /** Jedno zdanie pod nazwą na kafelku. */
  blurb: string;
  kinds: IntegrationKind[];
  /** Przykładowy ładunek przychodzący (do podglądu i testu). */
  sample?: unknown;
  /** Pola ładunku z opisami po polsku - lista obok szablonu. */
  fields: PresetField[];
  inbound?: Partial<InboundConfig>;
  outbound?: Partial<OutboundConfig>;
  /** Sekrety, o które formularz zapyta. */
  secrets?: PresetSecret[];
  /** Oczekiwany wynik przykładowego ładunku. */
  expect?: { recipients?: string[]; text?: string; skipped?: boolean; outboundJson?: Record<string, unknown>; outboundText?: string };
  /** Instrukcja „co ustawić w aplikacji” do panelu i dokumentacji, Markdown. */
  guide: string;
  /** Skąd wzięła się próbka: nazwa źródła i data; „do potwierdzenia” przed wydaniem wypada z listy. */
  sampleSource?: string;
}
