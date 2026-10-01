#!/usr/bin/env bash
#
# Скрипт --up OpenVPN для выхода Contour: перенести туннель в namespace выхода
# и поставить там адрес и маршрут по умолчанию. OpenVPN зовёт его с
# переменными среды: dev, tun_mtu, ifconfig_local, ifconfig_netmask или
# ifconfig_remote (точка-точка); CT_NS — имя namespace (--setenv).
# Устанавливается в /opt/contour/sbin/contour-ovpn-up (root).
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
