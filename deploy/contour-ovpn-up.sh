#!/usr/bin/env bash
#
# Скрипт --up OpenVPN для выхода Contour: перенести туннель в namespace выхода
# и поставить там адрес и маршрут по умолчанию. OpenVPN зовёт его с
# переменными среды: dev, tun_mtu, ifconfig_local, ifconfig_netmask или
# ifconfig_remote (точка-точка); CT_NS — имя namespace (--setenv).
# Устанавливается в /opt/contour/sbin/contour-ovpn-up (root).
#
# Ещё — DNS, который выдал сервер (`dhcp-option DNS` в foreign_option_N), в
# /run/contour/outlet-dns/<выход>: по нему Contour спрашивает имена правил
# «только через этот выход» — корпоративный DNS знает внутренние адреса
# (Confluence изнутри — 10.x, снаружи — вход, который чужим отвечает 503).
# Сервер DNS не выдал — файл снимается.
set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

NS="${CT_NS:?нет CT_NS}"
DEV="${dev:?нет dev}"

# 255.255.255.0 → 24
mask2cidr() {
  local bits=0 octet
  IFS=. read -r -a parts <<<"$1"
  for octet in "${parts[@]}"; do
    while [ "$octet" -gt 0 ]; do bits=$((bits + (octet & 1))); octet=$((octet >> 1)); done
  done
  echo "$bits"
}

ip link set "$DEV" netns "$NS"
ip -n "$NS" link set "$DEV" mtu "${tun_mtu:-1500}" up
if [ -n "${ifconfig_remote:-}" ]; then
  ip -n "$NS" addr add "$ifconfig_local" peer "$ifconfig_remote" dev "$DEV"
else
  ip -n "$NS" addr add "$ifconfig_local/$(mask2cidr "${ifconfig_netmask:-255.255.255.255}")" dev "$DEV"
fi
ip -n "$NS" route replace default dev "$DEV"

# DNS сервера — до трёх адресов IPv4, по строке; читает процесс Contour (группа contour).
OUTLET_DNS=/run/contour/outlet-dns
NAME="${NS#ct-}"
dns=()
i=1
while var="foreign_option_$i"; [ -n "${!var:-}" ]; do
  if [[ "${!var}" =~ ^dhcp-option\ DNS\ ([0-9]{1,3}(\.[0-9]{1,3}){3})$ ]] && [ "${#dns[@]}" -lt 3 ]; then
    dns+=("${BASH_REMATCH[1]}")
  fi
  i=$((i + 1))
done
mkdir -p "$OUTLET_DNS" && chmod 755 "$OUTLET_DNS"
if [ "${#dns[@]}" -gt 0 ]; then
  printf '%s\n' "${dns[@]}" > "$OUTLET_DNS/$NAME.tmp" && chmod 644 "$OUTLET_DNS/$NAME.tmp" && mv -f "$OUTLET_DNS/$NAME.tmp" "$OUTLET_DNS/$NAME"
else
  rm -f "$OUTLET_DNS/$NAME"
fi
