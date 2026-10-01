#!/usr/bin/env bash
#
# Второй адрес сервера в домашней сети — для DNS и SNI-входа устройств.
#
#   contour-addr <адрес> <порт TLS> <порт HTTP>   — держать адрес и переадресацию
#
# Работает сторожем под unit'ом contour-addr (root). Держит две вещи:
#
# 1. Адрес. Не правкой /etc/network/interfaces: ошибка там — сервер без сети
#    после перезагрузки. Адрес вешается поверх того, что выдал DHCP, на тот же
#    интерфейс, с меткой `<интерфейс>:ct` — по ней видно, чей он. Адресом
#    интерфейса владеет dhcpcd и при потере аренды может снять всё, поэтому
#    раз в 20 с проверяем и возвращаем.
#
# 2. Переадресацию :443/:80 этого адреса на внутренние порты Contour. Сами
#    :443/:80 на ВСЕХ адресах сервера держит nginx (сайт Alter'а и чужие сайты),
#    и трогать его нельзя. Своя таблица nft `ip contour` с DNAT срабатывает до
#    того, как пакет увидит nginx, и касается только этого адреса. Чужие
#    таблицы и правила не трогаются; при остановке таблица снимается целиком.
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ADDR="${1:-}"
TLS_PORT="${2:-}"
HTTP_PORT="${3:-}"
TABLE=contour
[[ "$ADDR" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "использование: contour-addr <IPv4> <порт TLS> <порт HTTP>" >&2; exit 2; }
[[ "$TLS_PORT" =~ ^[0-9]+$ && "$HTTP_PORT" =~ ^[0-9]+$ ]] || { echo "порты — числа" >&2; exit 2; }
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
table_present() { nft list table ip "$TABLE" >/dev/null 2>&1; }

put_table() {
  # Пересоздаём целиком: так в ней никогда не останется старых правил.
  nft delete table ip "$TABLE" 2>/dev/null || true
  nft -f - <<EOF
table ip $TABLE {
  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    ip daddr $ADDR tcp dport 443 dnat to $ADDR:$TLS_PORT
    ip daddr $ADDR tcp dport 80 dnat to $ADDR:$HTTP_PORT
  }
  # Для запросов с самого сервера (проверка в enable-lan.sh).
  chain output {
    type nat hook output priority -100; policy accept;
    ip daddr $ADDR tcp dport 443 dnat to $ADDR:$TLS_PORT
    ip daddr $ADDR tcp dport 80 dnat to $ADDR:$HTTP_PORT
  }
}
EOF
}

cleanup() {
  nft delete table ip "$TABLE" 2>/dev/null && echo "таблица nft $TABLE снята"
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
  if ! table_present; then
    if put_table; then
      echo "переадресация $ADDR:443 → :$TLS_PORT, :80 → :$HTTP_PORT (таблица nft $TABLE)"
    else
      echo "не удалось поставить таблицу nft $TABLE — повтор" >&2
    fi
  fi
  sleep 20 &
  wait $!
done
