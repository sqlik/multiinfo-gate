#!/usr/bin/env bash
# Kreator kontenera LXC z bramką dla Proxmox VE, w formacie community-scripts (silnik:
# github.com/community-scripts/core). Uruchomiony w powłoce hosta Proxmox tworzy kontener
# i instaluje bramkę skryptem install/multiinfogate-install.sh z tego samego katalogu w repozytorium;
# uruchomiony wewnątrz kontenera (polecenie `update`) aktualizuje bramkę do najnowszego wydania.
_CS_DEFAULT_URL="https://raw.githubusercontent.com/sqlik/multiinfo-gate/main/proxmox"
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
# shellcheck disable=SC1090
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")
# Copyright (c) 2026 sqlik
# Author: sqlik
# License: MIT | https://github.com/sqlik/multiinfo-gate/raw/main/LICENSE
# Source: https://github.com/sqlik/multiinfo-gate

APP="Multiinfo Gate"
var_tags="${var_tags:-sms;api}"
var_cpu="${var_cpu:-1}"
var_ram="${var_ram:-1024}"
var_disk="${var_disk:-4}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_arm64="${var_arm64:-yes}"
var_unprivileged="${var_unprivileged:-1}"

# Pierwsze konto panelu. Bez tych zmiennych login to `admin`, a hasło losuje instalator;
# oba trafiają do /root/multiinfo-gate.creds w kontenerze. Bez eksportu nie dotarłyby do kontenera.
export var_admin_user="${var_admin_user:-}"
export var_admin_pass="${var_admin_pass:-}"

# Nagłówek ASCII silnik bierze z repozytorium community-scripts/core, gdzie bramki nie ma; wpis
# w jego pamięci podręcznej (sprawdzanej jako pierwsza) daje własny nagłówek i oszczędza zapytań z 404.
_mig_header="/usr/local/community-scripts/headers/ct/multiinfogate"
if [[ ! -s "$_mig_header" ]] && mkdir -p "${_mig_header%/*}" 2>/dev/null; then
  cat >"$_mig_header" <<'HEADER'
    __  ___      ____  _ _       ____         ______      __
   /  |/  /_  __/ / /_(_|_)___  / __/___     / ____/___ _/ /____
  / /|_/ / / / / / __/ / / __ \/ /_/ __ \   / / __/ __ `/ __/ _ \
 / /  / / /_/ / / /_/ / / / / / __/ /_/ /  / /_/ / /_/ / /_/  __/
/_/  /_/\__,_/_/\__/_/_/_/ /_/_/  \____/   \____/\__,_/\__/\___/
HEADER
fi

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -d /opt/multiinfo-gate ]]; then
    msg_error "Brak instalacji ${APP}"
    exit
  fi

  NODE_VERSION="22" setup_nodejs

  if check_for_gh_release "multiinfo-gate" "sqlik/multiinfo-gate"; then
    msg_info "Zatrzymywanie usługi"
    systemctl stop multiinfo-gate
    msg_ok "Zatrzymano usługę"

    # Kopia bazy z zatrzymaną bramką jest spójna; leży obok kopii nocnych i podlega tej samej
    # retencji. Katalog może jeszcze nie istnieć, gdy bramka nie doczekała pierwszej nocy.
    msg_info "Kopia bazy przed aktualizacją"
    install -d -m 750 -o multiinfo-gate -g multiinfo-gate /var/lib/multiinfo-gate/backups
    if [[ -f /var/lib/multiinfo-gate/multiinfo-gate.sqlite ]]; then
      install -m 640 -o multiinfo-gate -g multiinfo-gate /var/lib/multiinfo-gate/multiinfo-gate.sqlite \
        "/var/lib/multiinfo-gate/backups/przed-aktualizacja-$(cat ~/.multiinfo-gate).sqlite"
    fi
    msg_ok "Zapisano kopię bazy"

    CLEAN_INSTALL=1 fetch_and_deploy_gh_release "multiinfo-gate" "sqlik/multiinfo-gate" "tarball"

    msg_info "Budowanie bramki"
    cd /opt/multiinfo-gate
    $STD npm ci --no-audit --no-fund
    $STD npm run build
    $STD npm prune --omit=dev
    msg_ok "Zbudowano bramkę $(cat ~/.multiinfo-gate)"

    msg_info "Uruchamianie usługi"
    systemctl start multiinfo-gate
    msg_ok "Uruchomiono usługę"
    msg_ok "Zaktualizowano do wydania $(cat ~/.multiinfo-gate)"
  fi
  exit
}

start
# Telemetria silnika trafia do statystyk community-scripts, a bramka nie jest w ich katalogu;
# wyłączona niezależnie od ustawienia hosta. Silnik czyta tę zmienną dopiero w build_container.
DIAGNOSTICS="no"
build_container
description

msg_ok "Zakończono pomyślnie\n"
echo -e "${CREATING}${GN}${APP} jest zainstalowana w kontenerze ${CTID}${CL}"
echo -e "${INFO}${YW}Panel (login i hasło: pct exec ${CTID} -- cat /root/multiinfo-gate.creds):${CL}"
echo -e "${GATEWAY}${BGN}http://${IP}:8081${CL}"
echo -e "${INFO}${YW}API dla aplikacji:${CL}"
echo -e "${GATEWAY}${BGN}http://${IP}:8080${CL}"
