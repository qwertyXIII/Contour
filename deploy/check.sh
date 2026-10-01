#!/usr/bin/env bash
#
# Быстрая проверка живого Contour: сервис, адрес через туннель, последние строки лога.
# От владельца без sudo (токен — ~/.config/contour/proxy, его кладёт install.sh)
# или от root (токен из /etc/contour/tokens):
#   bash ~/project/Contour/deploy/check.sh
set -uo pipefail
LOG=/var/log/contour/log.log

if [ -r "$HOME/.config/contour/proxy" ]; then
  proxy=$(cat "$HOME/.config/contour/proxy")
elif [ "$(id -u)" -eq 0 ]; then
  proxy="http://alter:$(grep '^alter:' /etc/contour/tokens | head -1 | cut -d: -f2-)@127.0.0.1:3128"
else
  echo "нет ~/.config/contour/proxy — запусти install.sh ещё раз или проверяй под sudo" >&2
  exit 1
fi

# Код, байты и время одной строкой; при обрыве curl печатает свой код выхода отдельно.
probe() {
  local out
  out=$(curl -sS --max-time 20 -o /dev/null -w 'HTTP %{http_code}, %{size_download} байт за %{time_total}s' -x "$proxy" "$1" 2>/dev/null) || out="$out — обрыв (curl $?)"
  printf '%-14s %s\n' "$2" "$out"
}

echo "contour: $(systemctl is-active contour.service)   aivpn-netns: $(systemctl is-active aivpn-netns.service)"
echo "напрямую:      $(curl -sS --max-time 10 https://api.ipify.org || echo '?')"
echo "через туннель: $(curl -sS --max-time 20 -x "$proxy" https://api.ipify.org 2>/dev/null || echo 'не открылось')"
probe http://cp.cloudflare.com/generate_204 'cloudflare:'
probe https://www.youtube.com/ 'youtube.com:'
probe 'https://speed.cloudflare.com/__down?bytes=1000000' '1 МБ https:'
echo "--- лог без graph, последние 12 строк:"
grep -v '"type":"graph"' "$LOG" 2>/dev/null | tail -n 12 | sed -E 's/.*"type":"([a-z]+)".*"content":\["(.*)"\],"trace".*/\1: \2/' | cut -c1-200
