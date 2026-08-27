/**
 * Ikona karty przeglądarki: ciemny kwadrat z ukośnikiem w kolorze sygnałowym panelu -
 * ten sam znak, który rozdziela „Multiinfo / Gate” na pasku. Wpisana w adres `data:`,
 * więc przeglądarka nie wysyła osobnego żądania o `/favicon.ico` (które i tak
 * kończyłoby się przekierowaniem na logowanie i błędem w konsoli).
 */
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
  + '<rect width="32" height="32" rx="4" fill="#1A1D1B"/>'
  + '<path d="M20 6 12 26" stroke="#B4531A" stroke-width="4" stroke-linecap="round"/>'
  + '</svg>';

export const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(SVG)}">`;
