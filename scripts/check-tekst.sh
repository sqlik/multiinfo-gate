#!/bin/sh
# Szuka w repo długich myślników i łącznika niełamiącego - w interfejsie i dokumentacji
# obowiązuje zwykły "-". Znaki zapisane kodami bajtowymi, żeby skrypt nie wpadał we własne sito.
em=$(printf '\342\200\224')
en=$(printf '\342\200\223')
nb=$(printf '\342\200\221')
KATALOGI="src docs test examples docker scripts proxmox .github mkdocs.yml README.md LICENSE .gitignore package.json"
if grep -rsn -e "$em" -e "$en" -e "$nb" $KATALOGI; then
  echo "check:tekst: znaleziono niedozwolone znaki (wyżej)"
  exit 1
fi
# Nazwy z x odmieniamy przez x: w Proxmoxie, z Bitrixa. Zapis przez "ks" jest błędem.
# Wzorce sklejane ze zmiennej, żeby skrypt nie wpadał we własne sito.
ks="ks"
if grep -rsn -e "Proxmo$ks" -e "Bitri$ks" $KATALOGI; then
  echo "check:tekst: nazwa z x odmieniona przez ks (wyżej)"
  exit 1
fi
echo "check:tekst: czysto"
