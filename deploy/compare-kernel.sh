#!/usr/bin/env bash
#
# Замер: тот же ключ через ядерный AmneziaWG (старый контур aivpn) против mihomo.
# Ключ один — поэтому Contour на время замера останавливается, а в конце
# возвращается как был. Около минуты без туннеля.
#
#   sudo bash ~/project/Contour/deploy/compare-kernel.sh
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
URL=https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-x64.tar.xz
[ "$(id -u)" -eq 0 ] || { echo "нужен root: sudo bash $0" >&2; exit 1; }

measure() { curl -sS -m 20 -o /dev/null -w '%{size_download} байт за %{time_total}s (%{speed_download} Б/с)\n' "$@" "$URL" 2>&1 | tail -1; }

echo "напрямую, без VPN:    $(measure)"
proxy=$(grep '^alter:' /etc/contour/tokens | head -1 | cut -d: -f2-)
echo "mihomo (Contour):     $(measure -x "http://alter:${proxy}@127.0.0.1:3128")"

systemctl stop contour.service
systemctl start aivpn-netns.service && sleep 3
echo "ядерный AWG (aivpn):  $(ip netns exec aivpn curl -sS -m 20 -o /dev/null -w '%{size_download} байт за %{time_total}s (%{speed_download} Б/с)\n' "$URL" 2>&1 | tail -1)"
systemctl stop aivpn-netns.service
systemctl start contour.service
sleep 3
echo "contour: $(systemctl is-active contour.service), aivpn-netns: $(systemctl is-active aivpn-netns.service) (как было)"
