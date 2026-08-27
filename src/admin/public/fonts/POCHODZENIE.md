# Kroje pisma w panelu

Panel używa IBM Plex Sans i IBM Plex Mono. Pliki leżą w repozytorium, a nie są
pobierane z Google Fonts: panel stoi za VPN-em i nie może zależeć od dostępu do
internetu ani zgłaszać wejść administratorów do zewnętrznego serwisu.

| Plik                        | Pakiet npm             | Wersja |
|-----------------------------|------------------------|--------|
| `IBMPlexSans-Regular.woff2` | `@ibm/plex-sans`       | 1.1.0  |
| `IBMPlexSans-SemiBold.woff2`| `@ibm/plex-sans`       | 1.1.0  |
| `IBMPlexMono-Regular.woff2` | `@ibm/plex-mono`       | 2.5.0  |
| `IBMPlexMono-Medium.woff2`  | `@ibm/plex-mono`       | 2.5.0  |

Wzięte z katalogu `fonts/complete/woff2/` obu pakietów - wariant `complete`
zawiera pełny zestaw znaków w jednym pliku, łącznie z polskimi diakrytykami
i cudzysłowami drukarskimi. Wariant `split` wymagałby ładowania osobnego
podzbioru Latin2 i wielu żądań na stronę.

Licencja: SIL Open Font License 1.1, pełny tekst w `LICENSE.txt`.
Odświeżenie: `npm pack @ibm/plex-sans@<wersja> @ibm/plex-mono@<wersja>`,
rozpakować i skopiować cztery pliki z `fonts/complete/woff2/`.
