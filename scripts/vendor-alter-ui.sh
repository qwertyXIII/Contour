#!/usr/bin/env bash
#
# Копия дизайн-системы Alter'а в панель Contour: web/shared ← Alter/public/shared.
#
# Копией, а не ссылкой: Contour — отдельная программа и не должен зависеть от
# того, лежит ли рядом Alter. Обновление — запустить ещё раз (как логгер
# владельца в src/vendor). Клиент движка Alter'а (client/) не нужен — его нет.
#
#   bash scripts/vendor-alter-ui.sh [путь к Alter/public/shared]
set -euo pipefail
SRC="${1:-$HOME/dev/Alter/public/shared}"
DST="$(cd "$(dirname "$0")/.." && pwd)/web/shared"
[ -f "$SRC/system.js" ] || { echo "нет дизайн-системы в $SRC" >&2; exit 1; }
# В копии бывают локальные правки, ещё не перенесённые в Alter (список — в VENDORED.txt).
# Перезаписать их молча — потерять; поэтому только с FORCE=1, когда они уже в Alter.
if grep -q 'Локальные правки' "$DST/VENDORED.txt" 2>/dev/null && [ "${FORCE:-}" != 1 ]; then
  echo "в копии есть локальные правки (см. $DST/VENDORED.txt) — перенеси их в Alter и запусти с FORCE=1" >&2
  exit 1
fi
rm -rf "$DST.new"
mkdir -p "$DST.new"
( cd "$SRC" && tar --exclude='./client' --exclude='./assets/app-icons' --exclude='.DS_Store' -cf - . ) | ( cd "$DST.new" && tar -xf - )
rm -rf "$DST"
mv "$DST.new" "$DST"
printf 'Копия дизайн-системы Alter (public/shared), %s.\nНе править здесь — обновлять: bash scripts/vendor-alter-ui.sh\n' "$(date +%F)" > "$DST/VENDORED.txt"
echo "дизайн-система скопирована в $DST ($(du -sh "$DST" | cut -f1))"
