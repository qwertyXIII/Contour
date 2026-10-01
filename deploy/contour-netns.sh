#!/usr/bin/env bash
#
# Выход «netns»: ядерный туннель в своём namespace и мост к хосту.
#
#   contour-netns up|down|status <имя>
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
#   <имя>.env    — необязательно: AWG_ADDRESS, AWG_DNS (формат aiproxy)
#   <имя>.netns  — PROTO=amneziawg|wireguard, BRIDGE=N (пишет переключение)
#   <имя>.socks  — пароль SOCKS; создаётся здесь, если нет
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

KEYS=/etc/contour/keys
LIB=/var/lib/contour/netns
SERVICE_USER=contour
SOCKS_PORT=1080
DEFAULT_MTU=1420

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
    *) die "PROTO в $META — amneziawg или wireguard" ;;
  esac
  WG_IF="ctw$BRIDGE"
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
  # «напрямую», то есть в туннель: другого маршрута там нет. Имена ему не
  # приходят — Contour присылает уже адрес.
  (umask 077; cat > "$dir/config.yaml" <<EOF
mode: rule
log-level: warning
ipv6: false
geo-auto-update: false
listeners:
  - name: in
    type: socks
    listen: $NS_IP
    port: $SOCKS_PORT
    udp: false
    users:
      - username: $NAME
        password: $SOCKS_PASS
rules:
  - MATCH,DIRECT
EOF
  )
  chown "$SERVICE_USER:$SERVICE_USER" "$dir/config.yaml"
}

cmd_up() {
  load_meta
  require_module
  [ -f "$CONF" ] || die "нет $CONF"

  local address mtu tmp
  address=$(conf_value Address | cut -d, -f1 | tr -d ' ')
  if [ -z "$address" ] && [ -f "$ENVF" ]; then
    address=$(sed -n 's/^AWG_ADDRESS=//p' "$ENVF" | head -1 | cut -d, -f1 | tr -d ' "')
  fi
  [ -n "$address" ] || die "нет адреса интерфейса: Address в $CONF или AWG_ADDRESS в $ENVF"
  [[ "$address" == */* ]] || address="$address/32"
  mtu=$(conf_value MTU)
  mtu=${mtu:-$DEFAULT_MTU}

  echo "Поднимаю выход $NAME ($PROTO, мост $HOST_IP ↔ $NS_IP):"

  # Пересоздаём всегда: setconf на живом интерфейсе оставляет старых пиров.
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$WG_IF" 2>/dev/null || true
  ip link del "$VETH_HOST" 2>/dev/null || true

  ip netns add "$NS"
  ip -n "$NS" link set lo up
  mkdir -p "/etc/netns/$NS"
  printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "/etc/netns/$NS/resolv.conf"

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

  ip link add "$VETH_HOST" type veth peer name "$VETH_NS"
  ip link set "$VETH_NS" netns "$NS"
  ip addr add "$HOST_IP/30" dev "$VETH_HOST"
  ip link set "$VETH_HOST" up
  ip -n "$NS" addr add "$NS_IP/30" dev "$VETH_NS"
  ip -n "$NS" link set "$VETH_NS" up
  note "мост $VETH_HOST $HOST_IP ↔ $NS_IP"

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
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$VETH_HOST" 2>/dev/null || true
  echo "Выход $NAME снят. Ключ и пароль оставлены."
}

cmd_status() {
  load_meta
  ip netns list | grep -qw "$NS" || die "namespace $NS не поднят"
  ip -n "$NS" -br addr
  ip netns exec "$NS" "$TOOL" show "$WG_IF" latest-handshakes | awk '{ if ($2 > 0) print "рукопожатие", systime() - $2, "с назад"; else print "рукопожатия не было" }'
  ip netns exec "$NS" "$TOOL" show "$WG_IF" transfer | awk '{ printf "принято %.1f МБ, отправлено %.1f МБ\n", $2/1048576, $3/1048576 }'
}

case "$CMD" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) die "использование: contour-netns up|down|status <имя>" ;;
esac
