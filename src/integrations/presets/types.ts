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
  /** Tryb prosty: listy wyboru w języku użytkownika; bez niego formularz otwiera się od razu zaawansowany. */
  simple?: { inbound?: SimpleInbound; outbound?: SimpleOutbound };
}

// --- tryb prosty ---------------------------------------------------------------------------
// Gotowe ustawienie opisuje decyzje użytkownika w jego języku: kto dostaje SMS, kiedy, co w nim jest
// i jak aplikacja się przedstawia. Formularz prosty rysuje z tego listy wyboru, a tryb zaawansowany
// pokazuje wynikową konfigurację w polach silnika.

/** Wariant „kiedy wysyłać SMS”; pierwszy na liście jest domyślny. */
export interface SimpleWhen { id: string; label: string; condition: InboundConfig['condition'] }

/** Wariant „co ma być w SMS-ie”; formularz pokazuje wynik na próbce zamiast szablonu. */
export interface SimpleText { id: string; label: string; text: InboundConfig['text'] }

/** Jak aplikacja przedstawia się bramce - jedno, które dana aplikacja obsługuje. */
export type SimpleAuth =
  | { kind: 'header'; name: string; prefix: string; label: string; where: string }
  | { kind: 'basic'; user: string; label: string; where: string }
  | { kind: 'none'; note: string };

export interface SimpleInbound {
  /** Gdzie wkleić adres wejściowy, np. „w Uptime Kumie w polu Post URL”. */
  addressField: string;
  /** Skąd numer odbiorcy: z listy w bramce albo z ładunku aplikacji; zdanie wyjaśnia dlaczego. */
  recipients: { source: 'list' | 'payload'; note: string };
  when: SimpleWhen[];
  text: SimpleText[];
  auth: SimpleAuth;
}

/** Parametr wpisywany do szablonu body, np. numer skrzynki; w szablonie JSON jako `"klucz": wartość`. */
export interface SimpleParam { key: string; label: string; hint: string; digits: boolean }

/** Sekret w trybie prostym: co użytkownik wpisuje i jak bramka to przerabia na wartość sekretu. */
export interface SimpleSecret { ref: string; label: string; hint: string; transform: 'raw' | 'bearer' | 'basic-x' }

export interface SimpleOutbound {
  address: { label: string; hint: string; placeholder: string };
  secrets: SimpleSecret[];
  params: SimpleParam[];
  /** Zdanie o tym, co aplikacja zrobi z odebranym SMS-em. */
  note: string;
}
