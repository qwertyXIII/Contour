#!/usr/bin/env bash
#
# Включает вход для устройств домашней сети: второй адрес, «умный DNS», SNI.
#
# После него устройство, которому DNS задан как этот адрес, ходит на YouTube
# через туннель, а на всё остальное — напрямую, как раньше.
#
# Сначала:  sudo bash ~/project/Contour/deploy/install.sh
# Потом:    sudo bash ~/project/Contour/deploy/enable-lan.sh [адрес]
#
# Адрес по умолчанию 192.168.0.50 — вне пула DHCP роутера (100–199).
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ETC=/etc/contour
LOG=/var/log/contour
SRC=/home/dxiii/project/Contour
ADDRESS="${1:-192.168.0.50}"

die() { echo "ОШИБКА: $*" >&2; exit 1; }
note() { echo "  $*"; }

[ "$(id -u)" -eq 0 ] || die "нужен root: sudo bash $0"
[ -x /opt/contour/sbin/contour-addr ] || die "нет /opt/contour/sbin/contour-addr — сначала install.sh"
[ -f /etc/systemd/system/contour-dns.service ] || die "нет unit'а contour-dns — сначала install.sh"
[[ "$ADDRESS" =~ ^192\.168\.0\.[0-9]+$ ]] || die "адрес должен быть из домашней сети 192.168.0.x"

echo "Настройки:"
if grep -qE '^lan:' "$ETC/contour.yaml"; then
  note "раздел lan уже есть — оставляю как есть"
else
  cp "$ETC/contour.yaml" "$ETC/contour.yaml.before-lan"
  cat >> "$ETC/contour.yaml" <<EOF

lan:                          # вход для устройств домашней сети (телевизор…)
  enabled: true
  address: $ADDRESS           # второй адрес сервера: DNS :53, SNI :443, Host :80
  allow: 192.168.0.0/24       # откуда пускаем
  upstream: [192.168.0.1, 1.1.1.1]   # обычный DNS для всего, что не из списка
  # extraDomains: [example.com]      # ещё сайты через туннель (с поддоменами); YouTube уже в списке
EOF
  note "раздел lan дописан (прежняя версия: $ETC/contour.yaml.before-lan)"
fi
printf 'ADDRESS=%s\n' "$ADDRESS" > "$ETC/lan.env"

sudo -u contour env CONTOUR_CONFIG="$ETC/contour.yaml" CONTOUR_LOG_PRETTY=1 \
  /opt/contour/node/bin/node "$SRC/src/main.ts" --check >/dev/null || die "настройки не прошли проверку: sudo -u contour /opt/contour/node/bin/node $SRC/src/main.ts --check"
note "настройки в порядке"

echo "Второй адрес:"
systemctl enable contour-addr.service >/dev/null 2>&1
systemctl restart contour-addr.service
for i in $(seq 1 10); do ip -o -4 addr show | grep -q " inet $ADDRESS/" && break; sleep 1; done
ip -o -4 addr show | grep -q " inet $ADDRESS/" || { tail -n 5 "$LOG/addr.log"; die "адрес $ADDRESS не повесился — лог выше"; }
note "$ADDRESS на месте"

echo "DNS и SNI:"
systemctl enable contour-dns.service >/dev/null 2>&1
systemctl restart contour-dns.service
systemctl restart contour.service
sleep 4
systemctl is-active --quiet contour-dns.service || { tail -n 10 "$LOG/dns.log"; die "contour-dns не запустился"; }
systemctl is-active --quiet contour.service || { tail -n 10 "$LOG/log.log"; die "contour не запустился"; }
note "contour-dns и contour работают"

echo "Проверка:"
yt=$(dig +short +time=2 +tries=1 @"$ADDRESS" www.youtube.com A | head -1)
[ "$yt" = "$ADDRESS" ] || die "DNS: www.youtube.com → «$yt», ждал $ADDRESS"
note "DNS: www.youtube.com → $yt (наш)"
gv=$(dig +short +time=2 +tries=1 @"$ADDRESS" rr1---sn-abc.googlevideo.com A | head -1)
note "DNS: видео (googlevideo.com) → $gv"
aaaa=$(dig +short +time=2 +tries=1 @"$ADDRESS" www.youtube.com AAAA | head -1)
[ -z "$aaaa" ] && note "DNS: IPv6 для YouTube — пусто (как надо)" || note "⚠️ DNS: IPv6 для YouTube — $aaaa"
other=$(dig +short +time=2 +tries=1 @"$ADDRESS" ya.ru A | head -1)
[ -n "$other" ] && [ "$other" != "$ADDRESS" ] || die "DNS: ya.ru → «$other» — обычный DNS не отвечает"
note "DNS: ya.ru → $other (обычный, мимо туннеля)"
code=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code} за %{time_total}s' --resolve "www.youtube.com:443:$ADDRESS" https://www.youtube.com/ 2>&1 || true)
note "YouTube через SNI-вход: HTTP $code"
code=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' --resolve "ya.ru:443:$ADDRESS" https://ya.ru/ 2>/dev/null || echo 'отказ')
note "чужой сайт через SNI-вход: $code (ждал отказ — это не открытый прокси)"

echo
echo "Готово. На телевизоре Hisense (VIDAA):"
echo "  Настройки → Сеть → Конфигурация сети → IP-настройки → «Вручную»"
echo "  DNS: $ADDRESS   (второй DNS — пусто, если можно; не ставить роутер)"
echo "  Адрес, маска и шлюз — те же, что телевизор получил сам."
echo "Логи: $LOG/dns.log, $LOG/log.log (строки lan:…)"
