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
#
# 3. Чужое из домашней сети на адресах Contour — отказ. Программы сервера
#    слушают на всех адресах (0.0.0.0), и с нашим адресом и мостами выходов
#    (10.201.N.1, `contour-netns.sh`) они вдруг стали доступны из сети: мосты —
#    устройствам, у которых шлюз — этот адрес. Живьём 2026-10-05 это сломало
#    голос Alter'а: WebRTC предлагает телефону все адреса сервера, проверка на
#    мост или на этот адрес приходила первой, и сервер закреплял пару, ответы
#    которой уходят с основного адреса, — устройство их выбрасывает. Поэтому:
#    на этот адрес по UDP — только DNS (TCP — DNS, SNI-вход и панель, их не
#    трогаем), к мостам — ничего. `reject`, а не `drop`: «порт закрыт» сразу,
#    как и раньше, когда там никто не слушал, — QUIC мгновенно уходит на TCP.
#    Шлюз это не задевает: пересылка идёт в чужие адреса, а не на наши.
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ADDR="${1:-}"
TLS_PORT="${2:-}"
HTTP_PORT="${3:-}"
TABLE=contour
# Мосты выходов: 10.201.N.1 на хосте (`contour-netns.sh`, N от 1 до 250).
BRIDGES=10.201.0.0/16
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
# По цепочке input, а не по таблице: таблицу прошлой версии (без отказа чужому) — переложить.
table_present() { nft list chain ip "$TABLE" input >/dev/null 2>&1; }

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
  # Из домашней сети: на этот адрес по UDP — только DNS, к мостам выходов — ничего (пункт 3 шапки).
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "$IFACE" ip daddr $BRIDGES reject
    iifname "$IFACE" ip daddr $ADDR udp dport != 53 reject
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
