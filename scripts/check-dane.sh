#!/bin/sh
# Szuka w repo wzorców prywatnych z pliku trzymanego poza repo.
# Brak pliku to pominięcie, nie błąd - na obcej maszynie skrypt nie ma czego sprawdzać.
plik="${MIG_DANE_PRYWATNE:-$HOME/SQLIK-PROJEKTY/multiinfo-gate-wewnetrzne/dane-prywatne.txt}"
if [ ! -f "$plik" ]; then
  echo "check:dane: pominięte (brak pliku wzorców)"
  exit 0
fi
if grep -rsniF -f "$plik" src docs test examples docker scripts proxmox README.md LICENSE package.json; then
  echo "check:dane: znaleziono dane prywatne (wyżej)"
  exit 1
fi
echo "check:dane: czysto"
