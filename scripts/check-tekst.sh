#!/bin/sh
# Szuka w repo długich myślników i łącznika niełamiącego - w interfejsie i dokumentacji
# obowiązuje zwykły "-". Znaki zapisane kodami bajtowymi, żeby skrypt nie wpadał we własne sito.
em=$(printf '\342\200\224')
en=$(printf '\342\200\223')
nb=$(printf '\342\200\221')
if grep -rsn -e "$em" -e "$en" -e "$nb" src docs test examples docker scripts proxmox .github mkdocs.yml README.md LICENSE .gitignore package.json; then
  echo "check:tekst: znaleziono niedozwolone znaki (wyżej)"
  exit 1
fi
echo "check:tekst: czysto"
