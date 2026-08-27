#!/bin/sh
# Składnia każdego pliku PHP i test weryfikacji podpisu. Uruchamiać z katalogu examples/php.
set -e
cd "$(dirname "$0")"
for f in $(find . -name '*.php' -not -path './data/*'); do
  php -l "$f" > /dev/null
done
echo "składnia: czysto"
php tests/webhook.test.php
