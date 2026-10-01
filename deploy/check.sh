#!/usr/bin/env bash
#
# Быстрая проверка живого Contour: сервис, адрес через туннель, последние строки лога.
# Запускать от root (токен читается из /etc/contour/tokens):
#   sudo bash /home/dxiii/project/Contour/deploy/check.sh
set -uo pipefail
ETC=/etc/contour
LOG=/var/log/contour/log.log

[ "$(id -u)" -eq 0 ] || { echo "нужен root: sudo bash $0" >&2; exit 1; }
token=$(grep '^alter:' "$ETC/tokens" | head -1 | cut -d: -f2-)
proxy="http://alter:${token}@127.0.0.1:3128"

echo "contour: $(systemctl is-active contour.service)   aivpn-netns: $(systemctl is-active aivpn-netns.service)"
echo "напрямую:      $(curl -sS --max-time 10 https://api.ipify.org || echo '?')"
echo "через туннель: $(curl -sS --max-time 20 -x "$proxy" https://api.ipify.org || echo 'не открылось')"
echo "youtube.com:   HTTP $(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -x "$proxy" https://www.youtube.com/ || echo '000')"
echo "--- лог, последние 15 строк:"
tail -n 15 "$LOG" 2>/dev/null | cut -c1-220
