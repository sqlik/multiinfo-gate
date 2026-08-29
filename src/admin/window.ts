/**
 * Okno, z którego panel liczy „dziś”: kafelki przeglądu, ostrzeżenie o niedostarczonych
 * webhookach i plakietka „Odebrane”. Liczniki mają się same wygaszać - nieudana dostawa
 * sprzed tygodnia nie może straszyć bez końca.
 */
export const WINDOW_MS = 24 * 3600_000;
