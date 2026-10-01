#!/usr/bin/env bash
#
# Переводит выход ext с AmneziaWG в mihomo на ядерный AmneziaWG в своём namespace.
#
# Замер 2026-10-01 на одном ключе: ядро 19,6 МБ/с, mihomo 35 КБ/с.
# Ключ один, поэтому порядок: остановить Contour (и с ним mihomo-туннель) →
# поднять ядерный выход → переписать настройки → запустить Contour → замерить.
# Если ядерный выход не поднялся — настройки не трогаются, Contour
# возвращается как был.
#
# Сначала:  sudo bash ~/project/Contour/deploy/install.sh   (ставит contour-netns и unit'ы)
# Потом:    sudo bash ~/project/Contour/deploy/switch-to-kernel.sh
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ETC=/etc/contour
NAME=ext
BRIDGE=1
LOG=/var/log/contour/log.log
URL=https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-x64.tar.xz

die() { echo "ОШИБКА: $*" >&2; exit 1; }
note() { echo "  $*"; }

[ "$(id -u)" -eq 0 ] || die "нужен root: sudo bash $0"
[ -x /opt/contour/sbin/contour-netns ] || die "нет /opt/contour/sbin/contour-netns — сначала install.sh"
[ -f /etc/systemd/system/contour-socks@.service ] || die "нет unit'а contour-socks@ — сначала install.sh"
systemctl is-active --quiet aivpn-netns.service && die "запущен старый контур aivpn — у него тот же ключ; останови его: systemctl stop aivpn-netns"

if [ ! -f "$ETC/keys/$NAME.netns" ]; then
  printf 'PROTO=amneziawg\nBRIDGE=%s\n' "$BRIDGE" > "$ETC/keys/$NAME.netns"
  chmod 640 "$ETC/keys/$NAME.netns"; chown root:contour "$ETC/keys/$NAME.netns"
fi

echo "Останавливаю Contour (туннель в mihomo держит тот же ключ):"
systemctl stop contour.service
note "остановлен"

echo "Поднимаю ядерный выход:"
if ! systemctl restart "contour-netns@$NAME.service"; then
  journalctl -u "contour-netns@$NAME" -n 20 --no-pager | tail -20
  systemctl start contour.service
  die "ядерный выход не поднялся — лог выше; Contour запущен как был"
fi
journalctl -u "contour-netns@$NAME" -n 12 --no-pager -o cat | grep -E '^  ' || true
systemctl enable "contour-netns@$NAME.service" "contour-socks@$NAME.service" >/dev/null 2>&1
systemctl restart "contour-socks@$NAME.service"
sleep 2
systemctl is-active --quiet "contour-socks@$NAME.service" || { journalctl -u "contour-socks@$NAME" -n 20 --no-pager; systemctl start contour.service; die "SOCKS внутри выхода не запустился"; }
note "SOCKS внутри выхода работает"

echo "Переписываю настройки выхода на kind: netns:"
cp "$ETC/contour.yaml" "$ETC/contour.yaml.before-kernel"
if grep -qE '^[[:space:]]*bridge:' "$ETC/contour.yaml"; then
  note "bridge уже есть — оставляю"
else
  sed -i -E "s/^([[:space:]]*)kind: mihomo(.*)$/\1kind: netns\n\1bridge: $BRIDGE/" "$ETC/contour.yaml"
fi
grep -nE 'kind:|bridge:' "$ETC/contour.yaml" | sed 's/^/  /'
note "прежняя версия: $ETC/contour.yaml.before-kernel"

echo "Запускаю Contour:"
systemctl start contour.service
sleep 6
systemctl is-active --quiet contour.service || { tail -n 20 "$LOG"; die "contour не запустился — лог выше"; }
note "работает"

token=$(grep '^alter:' "$ETC/tokens" | head -1 | cut -d: -f2-)
proxy="http://alter:${token}@127.0.0.1:3128"
echo "Замер:"
note "адрес через прокси: $(curl -sS --max-time 15 -x "$proxy" https://api.ipify.org 2>/dev/null || echo 'не открылось')"
note "youtube.com: HTTP $(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -x "$proxy" https://www.youtube.com/ 2>/dev/null || echo 000)"
note "загрузка 20 с: $(curl -sS -m 20 -o /dev/null -w '%{size_download} байт за %{time_total}s (%{speed_download} Б/с)' -x "$proxy" "$URL" 2>&1 | tail -1)"
echo
echo "Готово. Состояние туннеля: sudo /opt/contour/sbin/contour-netns status $NAME"
