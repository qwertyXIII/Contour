#!/usr/bin/env bash
#
# Переключает туннель с контура aivpn на Contour и проверяет, что он ходит.
#
# Ключ один, а WireGuard помнит у пира один адрес отправителя: два туннеля с
# одним ключом выбивают друг друга. Поэтому сначала гасится aivpn, потом
# поднимается Contour. Отключение aivpn из автозагрузки — только после того,
# как через Contour виден внешний адрес туннеля. Если проверка не прошла,
# aivpn можно вернуть: sudo systemctl start aivpn-netns.
#
# Запускать от root:  sudo bash /home/dxiii/project/Contour/deploy/switch-from-aivpn.sh
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ETC=/etc/contour
LOG=/var/log/contour/log.log
PROXY_PORT=3128

die() { echo "ОШИБКА: $*" >&2; exit 1; }
note() { echo "  $*"; }

[ "$(id -u)" -eq 0 ] || die "нужен root: sudo bash $0"
[ -f "$ETC/tokens" ] || die "нет $ETC/tokens — сначала install.sh"

token=$(grep '^alter:' "$ETC/tokens" | head -1 | cut -d: -f2-)
[ -n "$token" ] || die "в $ETC/tokens нет строки alter:…"
proxy="http://alter:${token}@127.0.0.1:${PROXY_PORT}"

echo "Адрес напрямую:"
direct=$(curl -sS --max-time 10 https://api.ipify.org || echo '?')
note "$direct"

if systemctl is-active --quiet aivpn-netns.service; then
  echo "Гашу контур aivpn:"
  systemctl stop aivpn-netns.service
  note "остановлен (вернуть: systemctl start aivpn-netns)"
fi

echo "Запускаю Contour:"
systemctl restart contour.service
sleep 4
systemctl is-active --quiet contour.service || { tail -n 30 "$LOG"; die "contour не запустился — последние строки лога выше"; }
note "работает"

echo "Жду рукопожатия туннеля и проверяю адрес через прокси:"
via=''
for i in $(seq 1 12); do
  via=$(curl -sS --max-time 15 -x "$proxy" https://api.ipify.org 2>/dev/null || true)
  [ -n "$via" ] && break
  sleep 5
done
[ -n "$via" ] || { tail -n 30 "$LOG"; die "через туннель ничего не открылось — лог выше; вернуть старый контур: systemctl start aivpn-netns"; }
note "$via"
[ "$via" != "$direct" ] || die "адрес через прокси совпал с прямым — трафик не идёт в туннель"

echo "Проверяю, что заблокированное открывается:"
code=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -x "$proxy" https://www.youtube.com/ || echo '000')
note "youtube.com → HTTP $code"

echo "Отключаю aivpn из автозагрузки:"
systemctl disable aivpn-netns.service >/dev/null 2>&1 || true
note "готово; /opt/aiproxy и /etc/aiproxy не тронуты"

echo
echo "Туннель работает. В Alter'е: Настройки → Сервисы → «Выход в интернет» → «Туннель: адрес прокси»:"
echo "  $proxy"
echo "Лог Contour: tail -f $LOG"
