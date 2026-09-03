#!/usr/bin/env bash

# Copyright (c) 2026 Tomasz Sawko
# Author: sqlik
# License: MIT | https://github.com/sqlik/multiinfo-gate/raw/main/LICENSE
# Source: https://github.com/sqlik/multiinfo-gate

# Instalacja bramki w kontenerze LXC z Debianem 13, bez Dockera: Node.js 22 z NodeSource, źródła
# najnowszego wydania z GitHuba, budowa, usługa systemd na osobnym koncie systemowym, klucz główny
# i pierwsze konto panelu. Uruchamiany przez silnik community-scripts z ct/multiinfogate.sh.

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

# Dane pierwszego konta przychodzą z ct/multiinfogate.sh; sprawdzane od razu, żeby błąd
# w loginie nie wyszedł dopiero po kilku minutach budowania.
admin_user="${var_admin_user:-admin}"
if [[ ! "$admin_user" =~ ^[a-z0-9._-]{3,32}$ ]]; then
  msg_error "var_admin_user: login ma od 3 do 32 znaków: małe litery, cyfry, kropka, myślnik lub podkreślenie"
  exit 1
fi
if [[ -n "${var_admin_pass:-}" && ${#var_admin_pass} -lt 12 ]]; then
  msg_error "var_admin_pass: hasło ma co najmniej dwanaście znaków"
  exit 1
fi

NODE_VERSION="22" setup_nodejs
fetch_and_deploy_gh_release "multiinfo-gate" "sqlik/multiinfo-gate" "tarball"

# Zależności natywne (better-sqlite3, argon2) mają gotowe binaria dla Debiana na x86-64 i ARM64,
# więc kompilator nie jest potrzebny. Narzędzia deweloperskie są tylko na czas budowy.
msg_info "Budowanie bramki"
cd /opt/multiinfo-gate
# better-sqlite3 buduje się skryptem instalacyjnym; od npm 12 skrypty zależności są
# domyślnie blokowane - zgodę wyraża pole allowScripts w package.json bramki.
$STD npm ci --no-audit --no-fund
$STD npm run build
$STD npm prune --omit=dev
msg_ok "Zbudowano bramkę $(cat ~/.multiinfo-gate)"

msg_info "Tworzenie konta systemowego i katalogów"
if ! id -u multiinfo-gate &>/dev/null; then
  $STD useradd --system --no-create-home --home-dir /var/lib/multiinfo-gate --shell /usr/sbin/nologin multiinfo-gate
fi
install -d -m 750 -o multiinfo-gate -g multiinfo-gate /var/lib/multiinfo-gate
install -d -m 750 -o root -g multiinfo-gate /etc/multiinfo-gate
msg_ok "Utworzono konto systemowe i katalogi"

# Klucz główny szyfruje sekrety w bazie; bez niego baza jest nie do odczytania (docs/uruchomienie.md,
# rozdział 3.2). Plik czyta tylko root i konto bramki.
msg_info "Tworzenie klucza głównego i pliku konfiguracji"
master_key="$(head -c 32 /dev/urandom | base64)"
cat <<ENV >/etc/multiinfo-gate/env
# Konfiguracja bramki Multiinfo Gate; usługa czyta ten plik przy starcie (systemctl restart multiinfo-gate).
# Znaczenie zmiennych: docs/uruchomienie.md, rozdział 7.7.

# Klucz główny. Utrata oznacza utratę dostępu do bazy; zmiana przy istniejącej bazie blokuje start.
MIG_MASTER_KEY=${master_key}

MIG_API_PORT=8080
MIG_ADMIN_PORT=8081
MIG_API_HOST=0.0.0.0
# Panel na adresie kontenera, żeby dało się wejść tunelem SSH przez hosta Proxmox albo przez odwrotne
# proxy z HTTPS (rozdział 9.2). Logowania zwykłym HTTP z sieci panel i tak nie przyjmuje.
# 127.0.0.1 chowa także ekran logowania i /healthz; wtedy tunel prowadzi do samego kontenera.
MIG_ADMIN_HOST=eth0
MIG_DATA_DIR=/var/lib/multiinfo-gate
MIG_LOG_LEVEL=info
MIG_BACKUP_RETENTION_DAYS=14
# 1 pozwala na webhooki pod adresy w sieci wewnętrznej.
MIG_WEBHOOK_ALLOW_PRIVATE=0
# Odbiór wiadomości przychodzących: oczekiwanie na odpowiedź Multiinfo (60000 to maksimum,
# ale opóźnia odbiór nawet o minutę - patrz docs 7.7) i przerwa po pustej odpowiedzi.
MIG_INBOUND_TIMEOUT_MS=10000
MIG_INBOUND_IDLE_MS=0
# Raz na dobę pytanie do GitHuba o nowsze wydanie (pasek na przeglądzie i mail); 0 wyłącza.
MIG_UPDATE_CHECK=1
ENV
chmod 640 /etc/multiinfo-gate/env
chown root:multiinfo-gate /etc/multiinfo-gate/env
msg_ok "Utworzono klucz główny i plik konfiguracji"

msg_info "Tworzenie usługi"
cat <<'UNIT' >/etc/systemd/system/multiinfo-gate.service
[Unit]
Description=Multiinfo Gate
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=multiinfo-gate
Group=multiinfo-gate
WorkingDirectory=/opt/multiinfo-gate
EnvironmentFile=/etc/multiinfo-gate/env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/multiinfo-gate/dist/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/multiinfo-gate

[Install]
WantedBy=multi-user.target
UNIT
systemctl enable -q --now multiinfo-gate
msg_ok "Utworzono usługę"

msg_info "Oczekiwanie na gotowość bramki"
ready=""
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/healthz &>/dev/null; then
    ready="tak"
    break
  fi
  sleep 1
done
if [[ -z "$ready" ]]; then
  msg_error "Bramka nie odpowiada na /healthz; dziennik: journalctl -u multiinfo-gate"
  journalctl -u multiinfo-gate --no-pager -n 20 || true
  exit 1
fi
msg_ok "Bramka odpowiada"

# Konto zakłada CLI bramki na koncie systemowym usługi, żeby baza pozostała jej własnością.
# Hasło idzie potokiem, nie argumentem, więc nie ma go w liście procesów.
msg_info "Zakładanie pierwszego konta panelu"
admin_pass="${var_admin_pass:-$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)}"
# shellcheck disable=SC2016
printf '%s\n' "$admin_pass" | $STD runuser -u multiinfo-gate -- /bin/sh -c \
  'set -a; . /etc/multiinfo-gate/env; set +a; exec /usr/bin/node /opt/multiinfo-gate/dist/cli/admin.js "$1"' sh "$admin_user"
container_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<CREDS >/root/multiinfo-gate.creds
Panel Multiinfo Gate: http://${container_ip:-<adres kontenera>}:8081
Login: ${admin_user}
Hasło: ${admin_pass}
Pierwsze logowanie wymaga włączenia drugiego składnika (aplikacja TOTP) i pokazuje kody zapasowe.
CREDS
chmod 600 /root/multiinfo-gate.creds
msg_ok "Założono konto ${admin_user}; dane logowania w /root/multiinfo-gate.creds"

motd_ssh
customize
cleanup_lxc
