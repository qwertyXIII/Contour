#!/usr/bin/env bash
#
# Выход «netns»: ядерный туннель в своём namespace и мост к хосту.
#
#   contour-netns up|down|status|socks <имя>
#
# `socks` — переписать конфиг SOCKS внутри и перезапустить только его, туннель
# не трогая (так install.sh обновляет выходы, которые уже подняты).
#
# Устанавливается в /opt/contour/sbin (root), запускается unit'ом
# contour-netns@<имя>. Из папки владельца не запускается: правка кода там
# не должна становиться root-командой.
#
# Почему ядро, а не mihomo: замер 2026-10-01 на одном ключе и одном сервере —
# ядерный AmneziaWG 19,6 МБ/с, AmneziaWG в mihomo 35 КБ/с.
#
# Устройство — как у aiproxy (setup-netns.sh), откуда и пришло:
# - интерфейс туннеля создаётся в корневом namespace и только потом переносится
#   внутрь: сокет остаётся там, где интерфейс создан, поэтому шифрованный UDP
#   уходит обычной сетью, а расшифрованный трафик живёт внутри;
# - внутри маршрут по умолчанию — только туннель: упал туннель — запросы падают,
#   а не утекают;
# - мост veth 10.201.N.1 (хост) ↔ 10.201.N.2 (внутри); внутри на .2:1080
#   слушает SOCKS с паролем (unit contour-socks@<имя>), через него ходит Contour.
#
# Файлы выхода в /etc/contour/keys:
#   <имя>.conf   — конфиг awg/wg (полный или ядерный)
#   <имя>.ovpn   — конфиг OpenVPN (вместо .conf)
#   <имя>.auth   — необязательно: логин и пароль OpenVPN, по строке; root 600
#   <имя>.env    — необязательно: AWG_ADDRESS, AWG_DNS (формат aiproxy)
#   <имя>.netns  — PROTO=amneziawg|wireguard|openvpn, BRIDGE=N, PRIORITY=N
#                  (пишет помощник; PRIORITY — метрика маршрута шлюза, меньше — главнее)
#   <имя>.socks  — пароль SOCKS; создаётся здесь, если нет
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

KEYS=/etc/contour/keys
LIB=/var/lib/contour/netns
SERVICE_USER=contour
MIHOMO=/opt/contour/bin/mihomo
SOCKS_PORT=1080
DEFAULT_MTU=1420
# Таблица маршрутов шлюза для устройств — то же число, что GW_TABLE в src/gateway.ts.
GW_TABLE=2701
# Частные и служебные сети — те же, что PRIVATE_V4 в src/inlets/fence.ts (тест сверяет).
FENCE_V4="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4"

die() { echo "ОШИБКА: $*" >&2; exit 1; }
note() { echo "  $*"; }

[ "$(id -u)" -eq 0 ] || die "нужен root"
CMD="${1:-}"
NAME="${2:-}"
[[ "$NAME" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]] || die "имя выхода: латиница, цифры, «-», «_»"

NS="ct-$NAME"
CONF="$KEYS/$NAME.conf"
ENVF="$KEYS/$NAME.env"
META="$KEYS/$NAME.netns"

load_meta() {
  [ -f "$META" ] || die "нет $META (PROTO=…, BRIDGE=…)"
  # shellcheck disable=SC1090
  . "$META"
  [[ "${BRIDGE:-}" =~ ^[0-9]+$ ]] && [ "$BRIDGE" -ge 1 ] && [ "$BRIDGE" -le 250 ] || die "BRIDGE в $META — число от 1 до 250"
  case "${PROTO:-}" in
    amneziawg) LINK_TYPE=amneziawg; TOOL=awg; MODULE=amneziawg ;;
    wireguard) LINK_TYPE=wireguard; TOOL=wg; MODULE=wireguard ;;
    openvpn) LINK_TYPE=''; TOOL=''; MODULE=tun; CONF="$KEYS/$NAME.ovpn" ;;
    *) die "PROTO в $META — amneziawg, wireguard или openvpn" ;;
  esac
  WG_IF="ctw$BRIDGE"
  TUN_IF="ctt$BRIDGE"
  OVPN_PID="/run/contour-ovpn-$NAME.pid"
  VETH_HOST="ctv$BRIDGE"
  VETH_NS="ctv${BRIDGE}n"
  HOST_IP="10.201.$BRIDGE.1"
  NS_IP="10.201.$BRIDGE.2"
}

# Значение ключа из [Interface] конфига: «Address = 10.0.0.2/32» → 10.0.0.2/32
conf_value() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//Ip" "$CONF" | head -1 | tr -d '\r'
}

require_module() {
  # tun у OpenVPN бывает встроен в ядро — тогда есть /dev/net/tun, а модуля в списке нет.
  [ "$MODULE" = tun ] && [ -c /dev/net/tun ] && return
  grep -q "^$MODULE " /proc/modules && return
  modprobe "$MODULE" 2>/dev/null || true
  grep -q "^$MODULE " /proc/modules || die "модуль ядра $MODULE не загружен и не грузится"
}

ensure_password() {
  local file="$KEYS/$NAME.socks"
  if [ ! -s "$file" ]; then
    (umask 027; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$file")
    note "пароль SOCKS создан"
  fi
  chown root:"$SERVICE_USER" "$file"
  chmod 640 "$file"
  SOCKS_PASS=$(cat "$file")
}

write_socks_config() {
  local dir="$LIB/$NAME"
  install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$LIB" "$dir"
  # mihomo внутри namespace — только как SOCKS-сервер с паролем и выходом
  # «напрямую», то есть в туннель: другого маршрута там нет. TCP Contour
  # присылает уже адресом и сам проверяет оградой. UDP (раздача, голос) приходит
  # с края мимо Contour — поэтому ограда и здесь: иначе через мост можно
  # достучаться до служб самого сервера (10.201.N.1) и домашней сети. Пришло
  # имя — mihomo разрешит его своим DNS через туннель (resolv.conf хоста внутри
  # не годится) и сверит адрес с оградой.
  local fence c
  fence=$(for c in $FENCE_V4; do printf '  - IP-CIDR,%s,REJECT\n' "$c"; done)
  (umask 077; cat > "$dir/config.yaml" <<EOF
mode: rule
log-level: warning
ipv6: false
geo-auto-update: false
dns:
  enable: true
  ipv6: false
  nameserver: [1.1.1.1, 8.8.8.8]
listeners:
  - name: in
    type: socks
    listen: $NS_IP
    port: $SOCKS_PORT
    udp: true
    users:
      - username: $NAME
        password: $SOCKS_PASS
rules:
$fence
  - MATCH,DIRECT
EOF
  )
  chown "$SERVICE_USER:$SERVICE_USER" "$dir/config.yaml"
}

# OpenVPN: процесс живёт в корневом namespace (его сокет к серверу ходит обычной
# сетью), туннель создаётся там же и переносится внутрь скриптом --up —
# тот же приём, что у AWG. Маршруты и адреса OpenVPN не ставит сам
# (--route-noexec, --ifconfig-noexec): всё ставит contour-ovpn-up внутри.
# DCO выключен: устройство ovpn-dco не переносится между namespace.
ovpn_tunnel() {
  command -v openvpn >/dev/null || die "openvpn не установлен: apt install openvpn"
  [ -f "$OVPN_PID" ] && kill "$(cat "$OVPN_PID")" 2>/dev/null || true
  rm -f "$OVPN_PID"
  # Логин и пароль — файлом после --config: голая auth-user-pass в .ovpn иначе
  # ждала бы их с клавиатуры, которой у службы нет.
  local auth=()
  if [ -f "$KEYS/$NAME.auth" ]; then
    chown root:root "$KEYS/$NAME.auth"; chmod 600 "$KEYS/$NAME.auth"
    auth=(--auth-user-pass "$KEYS/$NAME.auth" --auth-nocache)
  fi
  # Журнал openvpn создаёт закрытым (600); создаём сами открытым на чтение, как
  # остальные журналы Contour: там нет ни ключей, ни пароля, а причину отказа видно.
  local logf="/var/log/contour/ovpn-$NAME.log"
  [ -f "$logf" ] || install -m 644 /dev/null "$logf"
  openvpn --config "$CONF" "${auth[@]}" --dev "$TUN_IF" --dev-type tun --disable-dco --persist-tun \
    --route-noexec --ifconfig-noexec --script-security 2 \
    --setenv CT_NS "$NS" --up /opt/contour/sbin/contour-ovpn-up \
    --daemon "contour-ovpn-$NAME" --writepid "$OVPN_PID" --log-append "$logf"
  local i
  for i in $(seq 1 30); do
    ip -n "$NS" link show "$TUN_IF" >/dev/null 2>&1 && { note "OpenVPN: туннель $TUN_IF в $NS"; return; }
    sleep 1
  done
  tail -n 15 "$logf" >&2 || true
  die "OpenVPN не поднял туннель за 30 с — лог выше"
}

wg_tunnel() {
  local address mtu tmp
  address=$(conf_value Address | cut -d, -f1 | tr -d ' ')
  if [ -z "$address" ] && [ -f "$ENVF" ]; then
    address=$(sed -n 's/^AWG_ADDRESS=//p' "$ENVF" | head -1 | cut -d, -f1 | tr -d ' "')
  fi
  [ -n "$address" ] || die "нет адреса интерфейса: Address в $CONF или AWG_ADDRESS в $ENVF"
  [[ "$address" == */* ]] || address="$address/32"
  mtu=$(conf_value MTU)
  mtu=${mtu:-$DEFAULT_MTU}

  # setconf понимает только секции протокола: Address/DNS/MTU и прочее от wg-quick — убрать.
  tmp=$(mktemp)
  grep -viE '^[[:space:]]*(Address|DNS|MTU|Table|PreUp|PostUp|PreDown|PostDown|SaveConfig)[[:space:]]*=' "$CONF" > "$tmp"
  ip link add "$WG_IF" type "$LINK_TYPE"
  if ! "$TOOL" setconf "$WG_IF" "$tmp"; then rm -f "$tmp"; ip link del "$WG_IF"; die "$TOOL setconf не принял $CONF"; fi
  rm -f "$tmp"
  ip link set "$WG_IF" netns "$NS"
  ip -n "$NS" addr add "$address" dev "$WG_IF"
  ip -n "$NS" link set "$WG_IF" mtu "$mtu" up
  ip -n "$NS" route add default dev "$WG_IF"
  note "туннель $WG_IF: адрес $address, MTU $mtu, весь трафик namespace через него"
}

# Шлюз для устройств (src/gateway.ts, src/root/gateway.ts): их пакеты хост
# отдаёт в мост, отсюда они уходят в туннель. Внутри — пересылка и подмена
# адреса на адрес туннеля; MSS — под MTU туннеля, иначе большие TCP-пакеты
# застревают. На хосте — маршрут в таблицу шлюза с метрикой-приоритетом:
# ядро берёт поднятый выход с меньшей, а с namespace уходит и маршрут.
# Нет устройств-шлюзов — в мост ничего не приходит, правила просто ждут.
gateway_path() {
  local metric="${PRIORITY:-100}"
  [[ "$metric" =~ ^[0-9]+$ ]] || metric=100
  ip netns exec "$NS" sysctl -qw net.ipv4.ip_forward=1
  ip netns exec "$NS" nft -f - <<EOF
table ip contour_gw {
  chain gw_forward { type filter hook forward priority filter; policy accept; tcp flags syn tcp option maxseg size set rt mtu; }
  chain gw_post { type nat hook postrouting priority srcnat; policy accept; oifname != "$VETH_NS" masquerade; }
}
EOF
  # Ответы приходят из моста с чужим адресом отправителя: строгая проверка обратного пути их бы роняла.
  sysctl -qw "net.ipv4.conf.$VETH_HOST.rp_filter=2"
  ip route replace default via "$NS_IP" dev "$VETH_HOST" metric "$metric" table "$GW_TABLE"
  note "шлюз: маршрут в таблицу $GW_TABLE, метрика $metric"
}

cmd_up() {
  load_meta
  require_module
  [ -f "$CONF" ] || die "нет $CONF"

  echo "Поднимаю выход $NAME ($PROTO, мост $HOST_IP ↔ $NS_IP):"

  # Пересоздаём всегда: setconf на живом интерфейсе оставляет старых пиров.
  [ -f "$OVPN_PID" ] && kill "$(cat "$OVPN_PID")" 2>/dev/null || true
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$WG_IF" 2>/dev/null || true
  ip link del "$VETH_HOST" 2>/dev/null || true

  ip netns add "$NS"
  ip -n "$NS" link set lo up
  mkdir -p "/etc/netns/$NS"
  printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "/etc/netns/$NS/resolv.conf"

  if [ "$PROTO" = openvpn ]; then ovpn_tunnel; else wg_tunnel; fi

  ip link add "$VETH_HOST" type veth peer name "$VETH_NS"
  ip link set "$VETH_NS" netns "$NS"
  ip addr add "$HOST_IP/30" dev "$VETH_HOST"
  ip link set "$VETH_HOST" up
  ip -n "$NS" addr add "$NS_IP/30" dev "$VETH_NS"
  ip -n "$NS" link set "$VETH_NS" up
  note "мост $VETH_HOST $HOST_IP ↔ $NS_IP"
  gateway_path

  ensure_password
  write_socks_config
  note "SOCKS внутри: $NS_IP:$SOCKS_PORT (unit contour-socks@$NAME)"

  # Проверка: туннель везёт трафик. По адресу, без DNS — DNS у Contour свой.
  local i ok=''
  for i in 1 2 3 4 5 6; do
    if ip netns exec "$NS" curl -sS --max-time 5 -o /dev/null http://1.1.1.1/ 2>/dev/null; then ok=1; break; fi
    sleep 2
  done
  [ -n "$ok" ] || die "туннель поднят, но трафик не идёт (1.1.1.1 не отвечает изнутри)"
  note "трафик идёт: внешний адрес $(ip netns exec "$NS" curl -sS --max-time 8 https://api.ipify.org 2>/dev/null || echo '?')"
}

cmd_down() {
  load_meta
  if [ -f "$OVPN_PID" ]; then kill "$(cat "$OVPN_PID")" 2>/dev/null || true; rm -f "$OVPN_PID"; fi
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$VETH_HOST" 2>/dev/null || true
  echo "Выход $NAME снят. Ключ и пароль оставлены."
}

cmd_status() {
  load_meta
  ip netns list | grep -qw "$NS" || die "namespace $NS не поднят"
  ip -n "$NS" -br addr
  if [ "$PROTO" = openvpn ]; then
    [ -f "$OVPN_PID" ] && kill -0 "$(cat "$OVPN_PID")" 2>/dev/null && echo "openvpn работает (pid $(cat "$OVPN_PID"))" || echo "openvpn не запущен"
    ip -n "$NS" -s link show "$TUN_IF" 2>/dev/null | sed -n '4p;6p'
    return
  fi
  ip netns exec "$NS" "$TOOL" show "$WG_IF" latest-handshakes | awk '{ if ($2 > 0) print "рукопожатие", systime() - $2, "с назад"; else print "рукопожатия не было" }'
  ip netns exec "$NS" "$TOOL" show "$WG_IF" transfer | awk '{ printf "принято %.1f МБ, отправлено %.1f МБ\n", $2/1048576, $3/1048576 }'
}

# Переписать конфиг SOCKS и перезапустить только его: туннель, мост и шлюз остаются.
cmd_socks() {
  load_meta
  ip netns list | grep -qw "$NS" || die "namespace $NS не поднят — нечего обновлять"
  local conf="$LIB/$NAME/config.yaml"
  [ -f "$conf" ] && cp -p "$conf" "$conf.bak"
  ensure_password
  write_socks_config
  # Не принял бы mihomo конфиг — SOCKS падал бы по кругу, и выход умер бы для всех.
  if ! runuser -u "$SERVICE_USER" -- "$MIHOMO" -t -d "$LIB/$NAME" -f "$conf" >/dev/null 2>&1; then
    [ -f "$conf.bak" ] && mv "$conf.bak" "$conf"
    die "mihomo не принял новый конфиг SOCKS выхода $NAME — оставлен прежний, SOCKS не перезапускали"
  fi
  rm -f "$conf.bak"
  systemctl restart "contour-socks@$NAME.service"
  note "SOCKS выхода $NAME обновлён и перезапущен (туннель не трогали)"
}

case "$CMD" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  socks) cmd_socks ;;
  *) die "использование: contour-netns up|down|status|socks <имя>" ;;
esac
