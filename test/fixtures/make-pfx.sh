#!/bin/sh
# Tworzy samopodpisany certyfikat testowy i pakuje go do .pfx szyfrowanego RC2-40,
# czyli tak, jak robi to Plus. Wynik trafia do katalogu podanego jako pierwszy argument.
# Materiał jest jednorazowy i nie trafia do repozytorium.
set -e
out="$1"
mkdir -p "$out"
openssl req -x509 -newkey rsa:2048 -sha256 -days 730 -nodes \
  -keyout "$out/test-key.pem" -out "$out/test-cert.pem" \
  -subj "/CN=firma_test/O=Firma Sp. z o.o./L=Warszawa/C=PL"
openssl pkcs12 -legacy -export \
  -inkey "$out/test-key.pem" -in "$out/test-cert.pem" \
  -out "$out/test.pfx" -passout pass:tajne123
