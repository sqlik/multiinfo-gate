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
  guide: `Integracja przyjmuje zlecenia wysyłki z przepływów Microsoft Power Automate. Przepływ wysyła SMS za pomocą akcji konektora Multiinfo Gate: „Wyślij SMS” do jednego numeru, „Wyślij rozsyłkę” do listy odbiorców przygotowanej w przepływie albo „Wyślij SMS do grupy” do listy odbiorców zapisanej w tej integracji.

Konektor jest plikiem, który pobierasz w panelu „Konektor Power Automate” poniżej formularza i importujesz w Power Automate jako łącznik niestandardowy. Jeden plik obsługuje wszystkie integracje Power Automate tej bramki, a właściwą integrację wybiera się w akcji, w polu „Integracja”.

Każde wywołanie przechodzi przez ustawienia tej integracji. Integracja określa nadawcę, usługę i limit części, a ochrona przed burzą zatrzymuje zapętlony przepływ. Dziennik rejestruje każde wywołanie oraz, jeżeli przepływ poda tę informację, osobę zlecającą wysyłkę.

Łącznik niestandardowy wymaga licencji Power Automate Premium, a bramka musi być dostępna z internetu pod adresem \`https://\` z domeną. Opis krok po kroku znajdziesz w artykule „Power Automate” w dokumentacji bramki.`,
};
