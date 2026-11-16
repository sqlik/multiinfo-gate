import type { Preset } from './types.ts';

/**
 * Agent AI: jedyna pozycja katalogu dla rodzaju `agent`. Kafelek stoi w katalogu „do SMS” po Power Automate.
 * Formularz nie zawiera szablonu ani warunku: treść i odbiorców ustala pracownik w rozmowie z agentem.
 */
export const agentAi: Preset = {
  id: 'agent-ai',
  name: 'Agent AI',
  blurb: 'Wysyłka SMS-ów, przebieg doręczenia i wyniki kampanii w rozmowie z aplikacją AI, na przykład claude.ai albo ChatGPT',
  kinds: ['agent'],
  listedUnder: 'webhook_in',
  fields: [],
  guide: `Integracja pozwala pracownikom wysyłać SMS-y i sprawdzać ich doręczenie w rozmowie z aplikacją AI, na przykład claude.ai, ChatGPT albo Claude Code. Aplikacja łączy się z bramką przez protokół MCP, a bramka pokazuje w rozmowie podgląd wysyłki, przebieg doręczenia i wyniki kampanii.

Zakresy określają, co agent może zrobić w imieniu pracownika. W claude.ai i ChatGPT wysyłkę zatwierdza pracownik przyciskiem „Wyślij” w podglądzie bramki. W aplikacjach bez widoków agent prosi o potwierdzenie w rozmowie, a w n8n przepływ wysyła SMS-y bez udziału człowieka.

Wysyłki agenta przechodzą przez ustawienia tej integracji. Integracja określa domyślnego nadawcę i usługę, limit części oraz ochronę przed burzą, a dziennik rejestruje każdą wysyłkę z nazwą połączenia.

Połączenia pracowników dodaje się w szczegółach integracji po jej utworzeniu. Dla połączenia z logowaniem panel generuje jednorazowy kod, który pracownik wpisuje w aplikacji przy pierwszym połączeniu. Dla aplikacji z kluczem w nagłówku panel generuje token połączenia. Aplikacje z logowaniem, na przykład claude.ai i ChatGPT, wymagają bramki dostępnej z internetu pod adresem \`https://\` z domeną.

Opis krok po kroku znajdziesz w artykule „Agenci AI” w dokumentacji bramki.`,
};
