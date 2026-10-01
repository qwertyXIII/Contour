#!/usr/bin/env bash
#
# Ставит Contour на сервер: пользователь, папки, свой Node 22, mihomo, ключ
# из контура aivpn, настройки, токены, unit systemd, sudoers, logrotate.
#
# Идемпотентен: повторный запуск ничего не ломает и не перезаписывает то, что
# уже есть (ключ, настройки, токены). Контур aivpn НЕ трогает и Contour НЕ
# запускает — это делает switch-from-aivpn.sh, после проверки настроек здесь.
#
# Код не копируется: сервис работает прямо из ~/project/Contour владельца,
# куда код приезжает синком. Обновление = синк + `sudo systemctl restart contour`.
#
# Запускать от root:  sudo bash /home/dxiii/project/Contour/deploy/install.sh
set -euo pipefail

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

OWNER=dxiii
SRC=/home/$OWNER/project/Contour
PREFIX=/opt/contour
SERVICE_USER=contour
ETC=/etc/contour
LIB=/var/lib/contour
LOG=/var/log/contour
NODE_MAJOR=22
AIPROXY_ETC=/etc/aiproxy

die() { echo "ОШИБКА: $*" >&2; exit 1; }
note() { echo "  $*"; }

[ "$(id -u)" -eq 0 ] || die "нужен root: sudo bash $0"
[ -d "$SRC/src" ] || die "нет кода в $SRC — синк не доехал?"

# --- пользователь и папки ---------------------------------------------------

ensure_user() {
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    note "пользователь $SERVICE_USER уже есть"
  else
    useradd --system --home-dir "$LIB" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
    note "создан пользователь $SERVICE_USER"
  fi
}

ensure_dirs() {
  install -d -m 755 "$PREFIX" "$PREFIX/bin"
  install -d -m 750 -o root -g "$SERVICE_USER" "$ETC" "$ETC/keys"
  install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$LIB"
  install -d -m 755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$LOG"
  note "папки: $PREFIX, $ETC, $LIB, $LOG"
}

# --- свой Node 22 -----------------------------------------------------------
# Системный v20 не трогаем — на нём чужие приложения. Нужен 22.18+: он
# запускает .ts без сборки.

ensure_node() {
  local version arch tarball tmp
  version=$(curl -sS --max-time 30 https://nodejs.org/dist/index.json \
    | grep -o "\"version\":\"v${NODE_MAJOR}\.[0-9.]*\"" | head -1 | cut -d'"' -f4)
  [ -n "$version" ] || die "не удалось узнать версию Node ${NODE_MAJOR} с nodejs.org"
  if [ -x "$PREFIX/node/bin/node" ] && [ "$("$PREFIX/node/bin/node" -v)" = "$version" ]; then
    note "Node $version уже в $PREFIX/node"
    return
  fi
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) die "неизвестная архитектура: $(uname -m)" ;;
  esac
  tarball="node-${version}-linux-${arch}.tar.xz"
  tmp=$(mktemp -d)
  curl -sS --max-time 300 -o "$tmp/$tarball" "https://nodejs.org/dist/${version}/${tarball}" || die "не скачался $tarball"
  rm -rf "$PREFIX/node.new"
  mkdir -p "$PREFIX/node.new"
  tar -xJf "$tmp/$tarball" -C "$PREFIX/node.new" --strip-components=1
  rm -rf "$PREFIX/node" "$tmp"
  mv "$PREFIX/node.new" "$PREFIX/node"
  note "Node $("$PREFIX/node/bin/node" -v) в $PREFIX/node"
}

# --- mihomo -----------------------------------------------------------------
# Сборка «compatible» — без требований к набору команд процессора; для нашей
# нагрузки разницы нет.

ensure_mihomo() {
  local tag asset tmp
  tag=$(curl -sS --max-time 30 https://api.github.com/repos/MetaCubeX/mihomo/releases/latest \
    | grep -o '"tag_name": *"v[0-9.]*"' | head -1 | sed 's/.*"\(v[0-9.]*\)"/\1/')
  [ -n "$tag" ] || die "не удалось узнать версию mihomo с GitHub"
  if [ -x "$PREFIX/bin/mihomo" ] && "$PREFIX/bin/mihomo" -v 2>/dev/null | grep -q "$tag"; then
    note "mihomo $tag уже в $PREFIX/bin"
    return
  fi
  asset="mihomo-linux-amd64-compatible-${tag}.gz"
  tmp=$(mktemp -d)
  curl -sSL --max-time 300 -o "$tmp/$asset" "https://github.com/MetaCubeX/mihomo/releases/download/${tag}/${asset}" \
    || die "не скачался $asset"
  gunzip -c "$tmp/$asset" > "$tmp/mihomo"
  chmod 755 "$tmp/mihomo"
  "$tmp/mihomo" -v >/dev/null 2>&1 || die "скачанный mihomo не запускается"
  mv "$tmp/mihomo" "$PREFIX/bin/mihomo"
  rm -rf "$tmp"
  note "mihomo $("$PREFIX/bin/mihomo" -v 2>/dev/null | head -1 | cut -d' ' -f1-3)"
}

# --- ключ, настройки, токены ------------------------------------------------

ensure_key() {
  if [ -f "$ETC/keys/ext.conf" ]; then
    note "ключ выхода ext уже на месте"
    return
  fi
  [ -f "$AIPROXY_ETC/awg0.conf" ] || die "нет $AIPROXY_ETC/awg0.conf — положи конфиг выхода в $ETC/keys/ext.conf сам"
  install -m 640 -o root -g "$SERVICE_USER" "$AIPROXY_ETC/awg0.conf" "$ETC/keys/ext.conf"
  if [ -f "$AIPROXY_ETC/awg0.env" ]; then
    install -m 640 -o root -g "$SERVICE_USER" "$AIPROXY_ETC/awg0.env" "$ETC/keys/ext.env"
  fi
  note "ключ выхода ext скопирован из контура aivpn (оригинал не тронут)"
}

ensure_netns_meta() {
  [ -f "$ETC/keys/ext.netns" ] && return
  printf 'PROTO=amneziawg\nBRIDGE=1\n' > "$ETC/keys/ext.netns"
  chown root:"$SERVICE_USER" "$ETC/keys/ext.netns"
  chmod 640 "$ETC/keys/ext.netns"
  note "выход ext — ядерный AmneziaWG, мост 1"
}

ensure_config() {
  if [ -f "$ETC/contour.yaml" ]; then
    note "настройки $ETC/contour.yaml уже есть"
  else
    install -m 640 -o root -g "$SERVICE_USER" "$SRC/deploy/contour.example.yaml" "$ETC/contour.yaml"
    [ -f "$ETC/keys/ext.env" ] || sed -i 's#^\( *\)env: .*#\1# env: (нет)#' "$ETC/contour.yaml"
    note "настройки записаны из примера"
  fi
}

ensure_tokens() {
  if [ -f "$ETC/tokens" ]; then
    note "токены уже есть ($(grep -c ':' "$ETC/tokens") шт.); показать: sudo cat $ETC/tokens"
    return
  fi
  local token
  token=$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 48)
  printf '# имя:токен — по строке на потребителя; файл перечитывается сам\nalter:%s\n' "$token" > "$ETC/tokens"
  chown root:"$SERVICE_USER" "$ETC/tokens"
  chmod 640 "$ETC/tokens"
  echo
  echo "  Токен Alter'а — в его настройки «Выход в интернет» → «Туннель: адрес прокси»:"
  echo "    http://alter:${token}@127.0.0.1:3128"
  echo "  (ещё раз показать: sudo cat $ETC/tokens)"
  echo
}

# Токен для консоли владельца: `curl -x "$(cat ~/.config/contour/proxy)" …`,
# yt-dlp, check.sh без sudo. Файл 600 в его доме, в чат и лог не попадает.
ensure_owner_token() {
  local token line dir="/home/$OWNER/.config/contour"
  if ! grep -q "^$OWNER:" "$ETC/tokens"; then
    token=$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 48)
    printf '%s:%s\n' "$OWNER" "$token" >> "$ETC/tokens"
  fi
  line=$(grep "^$OWNER:" "$ETC/tokens" | head -1 | cut -d: -f2-)
  install -d -m 700 -o "$OWNER" -g "$OWNER" "/home/$OWNER/.config" "$dir"
  printf 'http://%s:%s@127.0.0.1:3128\n' "$OWNER" "$line" > "$dir/proxy"
  # Адрес для Alter'а — туда же: владелец вписывает его в настройки Alter'а
  # (или просит это сделать), не перепечатывая токен из терминала.
  line=$(grep '^alter:' "$ETC/tokens" | head -1 | cut -d: -f2-)
  printf 'http://alter:%s@127.0.0.1:3128\n' "$line" > "$dir/alter-proxy"
  chown "$OWNER:$OWNER" "$dir/proxy" "$dir/alter-proxy"
  chmod 600 "$dir/proxy" "$dir/alter-proxy"
  note "токены в доме владельца: $dir/proxy (консоль), $dir/alter-proxy (для настроек Alter'а)"
  # Токен DNS-процесса: самообучение проверяет через прокси, открывается ли сайт через VPN.
  if ! grep -q '^contour-dns:' "$ETC/tokens"; then
    token=$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 48)
    printf 'contour-dns:%s\n' "$token" >> "$ETC/tokens"
    note "токен contour-dns добавлен (самообучение DNS)"
  fi
}

# --- зависимости кода -------------------------------------------------------
# От владельца, не от root: node_modules лежит в его папке.

ensure_deps() {
  sudo -u "$OWNER" -H env PATH="$PREFIX/node/bin:$PATH" \
    bash -c "cd '$SRC' && npm install --no-fund --no-audit --loglevel=error" \
    || die "npm install не прошёл"
  note "зависимости установлены"
}

# --- systemd, sudoers, logrotate -------------------------------------------

ensure_unit() {
  cat > /etc/systemd/system/contour.service <<EOF
[Unit]
Description=Contour — VPN-выходы для программ сервера и устройств сети
Documentation=file://$SRC/README.md
After=network-online.target contour-addr.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
# :443 и :80 на втором адресе — вход для устройств домашней сети.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
Group=$SERVICE_USER
WorkingDirectory=$SRC
Environment=CONTOUR_CONFIG=$ETC/contour.yaml
ExecStart=$PREFIX/node/bin/node src/main.ts
Restart=always
RestartSec=3s
StandardOutput=append:$LOG/log.log
StandardError=inherit
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$LIB $LOG

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable contour.service >/dev/null 2>&1
  note "unit contour.service записан и включён (не запущен)"
}

ensure_sudoers() {
  # Владелец перезапускает сервис после синка без пароля — только эти команды.
  local file=/etc/sudoers.d/contour
  cat > "$file.tmp" <<EOF
$OWNER ALL=(root) NOPASSWD: /usr/bin/systemctl start contour.service, /usr/bin/systemctl stop contour.service, /usr/bin/systemctl restart contour.service, /usr/bin/systemctl status contour.service, /usr/bin/systemctl restart contour-dns.service, /usr/bin/systemctl status contour-dns.service, /usr/bin/systemctl restart contour-root.service
EOF
  chmod 440 "$file.tmp"
  if visudo -cf "$file.tmp" >/dev/null; then
    mv "$file.tmp" "$file"
    note "sudoers: $OWNER может start/stop/restart/status contour и restart/status contour-dns без пароля"
  else
    rm -f "$file.tmp"
    die "sudoers не прошёл проверку visudo"
  fi
}

# Ядерные выходы: помощник от root и два шаблонных unit'а. Помощник копируется
# в /opt (root) — из папки владельца root ничего не запускает.
ensure_netns_units() {
  install -d -m 755 "$PREFIX/sbin"
  install -m 755 -o root -g root "$SRC/deploy/contour-netns.sh" "$PREFIX/sbin/contour-netns"
  cat > /etc/systemd/system/contour-netns@.service <<EOF
[Unit]
Description=Contour — ядерный выход %i (namespace ct-%i)
After=network-online.target
Wants=network-online.target
Before=contour.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$PREFIX/sbin/contour-netns up %i
ExecStop=$PREFIX/sbin/contour-netns down %i
TimeoutStartSec=90s

[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/contour-socks@.service <<EOF
[Unit]
Description=Contour — SOCKS внутри выхода %i
BindsTo=contour-netns@%i.service
After=contour-netns@%i.service
PartOf=contour-netns@%i.service
Before=contour.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
NetworkNamespacePath=/var/run/netns/ct-%i
ExecStart=$PREFIX/bin/mihomo -d $LIB/netns/%i -f $LIB/netns/%i/config.yaml
Restart=always
RestartSec=3s
StandardOutput=append:$LOG/socks.log
StandardError=inherit
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
ReadWritePaths=$LIB/netns/%i $LOG

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  note "ядерные выходы: $PREFIX/sbin/contour-netns, unit'ы contour-netns@ и contour-socks@"
}

# Домашняя сеть: сторож второго адреса (root) и DNS (contour). Включает их
# enable-lan.sh — здесь только ставятся.
ensure_lan_units() {
  install -m 755 -o root -g root "$SRC/deploy/contour-addr.sh" "$PREFIX/sbin/contour-addr"
  install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$LIB/dns"
  cat > /etc/systemd/system/contour-addr.service <<EOF
[Unit]
Description=Contour — второй адрес сервера для устройств домашней сети
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$ETC/lan.env
ExecStart=$PREFIX/sbin/contour-addr \${ADDRESS} \${TLS_PORT} \${HTTP_PORT}
Restart=always
RestartSec=10s
StandardOutput=append:$LOG/addr.log
StandardError=inherit

[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/contour-dns.service <<EOF
[Unit]
Description=Contour — «умный DNS» для устройств домашней сети
After=network-online.target contour-addr.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$SRC
Environment=CONTOUR_CONFIG=$ETC/contour.yaml
ExecStart=$PREFIX/node/bin/node src/dns/main.ts
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=2s
StandardOutput=append:$LOG/dns.log
StandardError=inherit
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$LOG $LIB/dns

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  note "домашняя сеть: $PREFIX/sbin/contour-addr, unit'ы contour-addr и contour-dns (включает enable-lan.sh)"
}

# Помощник от root для панели: код — КОПИЯ от root в /opt/contour/root-app,
# а не папка владельца (правка там не должна становиться командой от root).
# Обновляется только этим скриптом.
ensure_root_helper() {
  local app="$PREFIX/root-app"
  rm -rf "$app.new"
  install -d -m 755 "$app.new"
  cp -a "$SRC/src" "$SRC/node_modules" "$SRC/package.json" "$app.new/"
  chown -R root:root "$app.new"
  chmod -R go-w "$app.new"
  rm -rf "$app"
  mv "$app.new" "$app"
  install -m 755 -o root -g root "$SRC/deploy/contour-ovpn-up.sh" "$PREFIX/sbin/contour-ovpn-up"
  cat > /etc/systemd/system/contour-root.service <<EOF
[Unit]
Description=Contour — помощник от root для панели (выходы, ключи)
After=network-online.target

[Service]
Type=simple
ExecStart=$PREFIX/node/bin/node $app/src/root/main.ts
Restart=always
RestartSec=3s
StandardOutput=append:$LOG/root.log
StandardError=inherit
ProtectHome=read-only
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable contour-root.service >/dev/null 2>&1
  systemctl restart contour-root.service
  note "помощник от root: $app (копия), unit contour-root — запущен"
}

ensure_panel_password() {
  if [ -f "$ETC/panel.json" ]; then
    note "пароль панели уже задан (сменить: sudo bash $SRC/deploy/panel-password.sh)"
    return
  fi
  bash "$SRC/deploy/panel-password.sh" --generate
}

ensure_logrotate() {
  cat > /etc/logrotate.d/contour <<EOF
$LOG/log.log $LOG/socks.log $LOG/dns.log $LOG/addr.log $LOG/root.log $LOG/ovpn-*.log {
  weekly
  rotate 8
  missingok
  notifempty
  compress
  delaycompress
  copytruncate
}
EOF
  note "logrotate: $LOG/log.log, еженедельно, 8 архивов"
}

# --- проверка ---------------------------------------------------------------

verify() {
  echo
  echo "Проверка настроек от имени $SERVICE_USER:"
  sudo -u "$SERVICE_USER" env CONTOUR_CONFIG="$ETC/contour.yaml" CONTOUR_LOG_PRETTY=1 \
    "$PREFIX/node/bin/node" "$SRC/src/main.ts" --check || die "настройки не прошли проверку"
}

echo "Ставлю Contour:"
ensure_user
ensure_dirs
ensure_node
ensure_mihomo
ensure_key
ensure_netns_meta
ensure_config
ensure_tokens
ensure_owner_token
ensure_deps
ensure_unit
ensure_netns_units
ensure_lan_units
ensure_root_helper
ensure_panel_password
ensure_sudoers
ensure_logrotate
verify
echo
if grep -qE '^[[:space:]]*kind: mihomo' "$ETC/contour.yaml"; then
  echo "Готово. Выход ext ещё в mihomo (35 КБ/с) — перевести на ядро:"
  echo "  sudo bash $SRC/deploy/switch-to-kernel.sh"
elif ! grep -qE '^lan:' "$ETC/contour.yaml"; then
  echo "Готово. Чтобы телевизор и другие устройства сети ходили через туннель:"
  echo "  sudo bash $SRC/deploy/enable-lan.sh"
elif systemctl is-active --quiet contour.service; then
  echo "Готово. Contour работает; код изменился — sudo systemctl restart contour. Проверка: bash $SRC/deploy/check.sh"
else
  echo "Готово. Дальше — переключение с контура aivpn (ключ один, два туннеля не живут):"
  echo "  sudo bash $SRC/deploy/switch-from-aivpn.sh"
fi
