#!/usr/bin/env bash
#
# Замер: пропускает ли выход UDP — до режима шлюза (голос Discord, бои, QUIC).
# Только читает: изнутри namespace выхода DNS-запрос по UDP и STUN-запросы
# на ходовой (3478) и высокий (19302) порты; ничего не меняет.
#
#   sudo bash deploy/probe-udp.sh <имя выхода>
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

NAME="${1:-}"
[[ "$NAME" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]] || { echo "использование: sudo bash $0 <имя выхода>" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "нужен root" >&2; exit 1; }
NS="ct-$NAME"
ip netns list | grep -q "^$NS\b" || { echo "namespace $NS нет — выход не поднят" >&2; exit 1; }

echo "Выход $NAME — UDP изнутри $NS:"
for dns in 1.1.1.1 8.8.8.8; do
  if out=$(ip netns exec "$NS" dig +time=3 +tries=1 +short @"$dns" example.com A 2>/dev/null) && [ -n "$out" ]; then
    echo "  DNS $dns:53/udp — отвечает"
  else
    echo "  DNS $dns:53/udp — МОЛЧИТ"
  fi
done

ip netns exec "$NS" python3 - <<'PY'
import os, socket, struct, time

def stun(host, port):
    """STUN Binding Request: ответ — UDP туда и обратно проходит; время — задержка."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(3)
    try:
        req = struct.pack('!HHI', 0x0001, 0, 0x2112A442) + os.urandom(12)
        times = []
        for _ in range(5):
            t = time.monotonic()
            s.sendto(req, (host, port))
            s.recvfrom(2048)
            times.append((time.monotonic() - t) * 1000)
        times.sort()
        return f'отвечает, задержка {times[0]:.0f}–{times[-1]:.0f} мс'
    except socket.gaierror:
        return 'имя не разрешилось'
    except (socket.timeout, OSError):
        return 'МОЛЧИТ'
    finally:
        s.close()

for host, port in [('stun.cloudflare.com', 3478), ('stun.l.google.com', 19302), ('global.stun.twilio.com', 3478)]:
    print(f'  STUN {host}:{port}/udp — {stun(host, port)}')
PY
