import type { Preset } from './types.ts';

/**
 * Power Automate: jedyna pozycja katalogu dla rodzaju `power_automate`. Kafelek stoi w katalogu
 * „do SMS” obok n8n. Formularz nie ma szablonu ani warunku: treść i odbiorców buduje przepływ.
 */
export const powerAutomate: Preset = {
  id: 'power-automate',
  name: 'Power Automate',
  blurb: 'SMS z przepływu Microsoft Power Automate: do jednego numeru, rozsyłką albo do listy odbiorców prowadzonej w bramce',
  kinds: ['power_automate'],
  listedUnder: 'webhook_in',
  fields: [],
  sampleSource: 'Przepływ własny bramki, 2026-11-03',
  guide: `Integracja przyjmuje wywołania z przepływów Microsoft Power Automate. Przepływ wysyła SMS akcją konektora Multiinfo Gate: „Wyślij SMS” do jednego numeru, „Wyślij rozsyłkę” do listy odbiorców z przepływu albo „Wyślij SMS do grupy” do listy odbiorców prowadzonej w tej integracji.

Konektor to plik, który pobiera się niżej, w panelu „Konektor Power Automate”. W Power Automate importuje się go jako łącznik niestandardowy. Jeden plik obsługuje wszystkie integracje Power Automate tej bramki. Integrację wybiera się w akcji, w polu „Integracja”.

Każde wywołanie przechodzi przez ustawienia tej integracji. Integracja wyznacza nadawcę, usługę i limit części. Ochrona przed burzą zatrzymuje zapętlony przepływ. Dziennik pokazuje każde wywołanie, a gdy przepływ to poda, także osobę, która zleciła wysyłkę.

Łącznik niestandardowy wymaga licencji Power Automate Premium. Bramka musi być dostępna z internetu pod adresem \`https://\` z domeną. Krok po kroku opisuje to artykuł „Power Automate” w dokumentacji bramki.`,
};
