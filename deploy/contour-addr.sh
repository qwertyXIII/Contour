#!/usr/bin/env bash
#
# Второй адрес сервера в домашней сети — для DNS и SNI-входа устройств.
#
#   contour-addr <адрес>     — держать адрес (сторож, работает под unit'ом contour-addr)
#
# Не правкой /etc/network/interfaces: ошибка там — сервер без сети после
# перезагрузки. Адрес вешается поверх того, что выдал DHCP, на тот же
# интерфейс, с меткой `<интерфейс>:ct` — по ней видно, чей он. Сеть адресом
# не трогаем: маска та же, что у основного, маршруты не меняются.
#
# Сторож, а не разовая команда: адресом владеет dhcpcd, и при потере аренды
# он может снять с интерфейса всё. Раз в 20 с проверяем и возвращаем.
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ADDR="${1:-}"
[[ "$ADDR" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "использование: contour-addr <IPv4>" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "нужен root" >&2; exit 1; }

# Интерфейс и маска — те, через которые сервер видит этот адрес сейчас.
detect() {
  local route
  route=$(ip -o -4 route get "$ADDR" 2>/dev/null) || return 1
  IFACE=$(sed -n 's/.* dev \([^ ]*\).*/\1/p' <<<"$route")
  PREFIX=$(ip -o -4 addr show dev "$IFACE" scope global | grep -v ':ct' | head -1 | sed -n 's#.* inet [0-9.]*/\([0-9]*\).*#\1#p')
  [ -n "$IFACE" ] && [ -n "$PREFIX" ]
}

present() { ip -o -4 addr show | grep -q " inet $ADDR/"; }

cleanup() {
  if [ -n "${IFACE:-}" ] && present; then
    ip addr del "$ADDR/$PREFIX" dev "$IFACE" 2>/dev/null && echo "адрес $ADDR снят с $IFACE"
  fi
  exit 0
}
trap cleanup TERM INT

until detect; do echo "нет маршрута к $ADDR — жду сеть"; sleep 5; done

# Чужой адрес занимать нельзя: если кто-то в сети уже на нём — громко падаем.
# arping на сервере нет, поэтому ping + таблица соседей: ответил или хотя бы
# отозвался на ARP (появился MAC) — занято.
occupied() {
  ping -c 2 -W 1 -I "$IFACE" "$ADDR" >/dev/null 2>&1 && return 0
  ip neigh show "$ADDR" dev "$IFACE" | grep -q lladdr
}
if ! present && occupied; then
  echo "ОШИБКА: $ADDR уже занят кем-то в сети ($(ip neigh show "$ADDR" dev "$IFACE")) — выбери другой адрес (lan.address)" >&2
  exit 1
fi

while :; do
  if ! present; then
    if ip addr add "$ADDR/$PREFIX" dev "$IFACE" label "$IFACE:ct"; then
      echo "адрес $ADDR/$PREFIX на $IFACE"
    else
      echo "не удалось повесить $ADDR на $IFACE — повтор" >&2
    fi
  fi
  sleep 20 &
  wait $!
done
