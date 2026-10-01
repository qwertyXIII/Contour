#!/usr/bin/env bash
#
# Пароль панели Contour: задать свой или сгенерировать. Хранится только хеш
# (scrypt) в /etc/contour/panel.json, root:contour 640. Сам пароль печатается
# один раз — сгенерированный — и больше нигде не лежит.
#
#   sudo bash ~/project/Contour/deploy/panel-password.sh          # спросит пароль (пусто — сгенерировать)
#   sudo bash ~/project/Contour/deploy/panel-password.sh --generate
set -euo pipefail
FILE=/etc/contour/panel.json
NODE=/opt/contour/node/bin/node
AUTH=/opt/contour/root-app/src/panel/auth.ts

[ "$(id -u)" -eq 0 ] || { echo "нужен root: sudo bash $0" >&2; exit 1; }
[ -x "$NODE" ] && [ -f "$AUTH" ] || { echo "сначала install.sh" >&2; exit 1; }

pass=''
if [ "${1:-}" != "--generate" ] && [ -t 0 ]; then
  read -r -s -p "Новый пароль панели (Enter — сгенерировать): " pass; echo
fi
generated=''
if [ -z "$pass" ]; then
  pass=$(head -c 64 /dev/urandom | tr -dc 'a-hjkmnp-z2-9' | head -c 12)
  generated=1
fi
[ "${#pass}" -ge 8 ] || { echo "пароль короче 8 знаков" >&2; exit 1; }

PASS="$pass" "$NODE" --input-type=module -e "
  const { hashPassword } = await import('$AUTH');
  process.stdout.write(JSON.stringify(await hashPassword(process.env.PASS)));
" > "$FILE.tmp"
chown root:contour "$FILE.tmp"
chmod 640 "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
if [ -n "$generated" ]; then
  echo
  echo "  Пароль панели: $pass"
  echo "  (запиши — он больше нигде не показывается; сменить — этот же скрипт)"
fi
echo "  Пароль панели сохранён. Панель: http://vpn.home или http://192.168.0.50"
