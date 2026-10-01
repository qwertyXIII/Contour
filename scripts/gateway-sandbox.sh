#!/usr/bin/env bash
#
# Шлюз для устройств — целиком, в песочнице без root: свои пространства сети
# и монтирования (`unshare -rnm`), живую сеть сервера не трогает.
#
#   bash scripts/gateway-sandbox.sh
#
# Сеть песочницы:
#   dev1 (шлюз «заблокированное»)  ┐
#   dev2 (шлюз «всё через VPN»)    ├─ мост 192.168.0.0/24 ─ «сервер» (.50, здесь же
#   router (.1) ───────────────────┘    правила root/gateway.ts) ─ мост ctv9 ─ выход ct-t
#   router: «интернет» 198.51.100.10 (заблокированный) и .20 (обычный) на lo;
#           выход ct-t ходит к нему своим «туннелем» 172.31.0.0/30.
# Эхо-сервер в «интернете» отвечает адресом, с которого пришёл запрос:
#   172.31.0.2 — пришло через выход, 192.168.0.50 — напрямую через сервер.
set -euo pipefail
export PATH=/opt/node-aiproxy/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${1:-}" != inner ]; then
  exec unshare -rnm --propagation private bash "$0" inner
fi

fail=0
check() { # имя, ожидаемое, полученное
  if [ "$2" = "$3" ]; then echo "  ✓ $1: $3"; else echo "  ✗ $1: ждали «$2», вышло «$3»"; fail=1; fi
}

mount -t tmpfs none /run/netns 2>/dev/null || { mkdir -p /tmp/ct-netns; mount --bind /tmp/ct-netns /run/netns; }
mount -t tmpfs none /etc/contour
mkdir -p /run/contour && mount -t tmpfs none /run/contour
ip link set lo up

for ns in dev1 dev2 router lanbr ct-t; do ip netns add "$ns"; ip -n "$ns" link set lo up; done
inns() { local ns=$1; shift; nsenter --net="/run/netns/$ns" "$@"; }

# Мост домашней сети и порты в него.
ip -n lanbr link add br0 type bridge && ip -n lanbr link set br0 up
port() { # ns, интерфейс в ns, адрес
  ip link add "p-$1" type veth peer name "$2"
  ip link set "p-$1" netns lanbr && ip -n lanbr link set "p-$1" master br0 up
  if [ "$1" = srv ]; then ip addr add "$3" dev "$2"; ip link set "$2" up
  else ip link set "$2" netns "$1"; ip -n "$1" addr add "$3" dev "$2"; ip -n "$1" link set "$2" up; fi
}
port srv lan0 192.168.0.50/24
port dev1 eth0 192.168.0.21/24
port dev2 eth0 192.168.0.22/24
port router eth0 192.168.0.1/24
ip route add default via 192.168.0.1 dev lan0
ip -n dev1 route add default via 192.168.0.50
ip -n dev2 route add default via 192.168.0.50

# «Интернет» на роутере и «туннель» выхода к нему.
ip -n router addr add 198.51.100.10/32 dev lo
ip -n router addr add 198.51.100.20/32 dev lo
ip -n router addr add 198.51.100.30/32 dev lo   # голосовой сервер: адреса нет в DNS, есть в подсети
ip link add tun0 type veth peer name tunr
ip link set tun0 netns ct-t && ip link set tunr netns router
ip -n ct-t addr add 172.31.0.2/30 dev tun0 && ip -n ct-t link set tun0 up
ip -n router addr add 172.31.0.1/30 dev tunr && ip -n router link set tunr up
ip -n ct-t route add default via 172.31.0.1

# Мост выхода — как в contour-netns.sh, и его часть для шлюза оттуда же.
ip link add ctv9 type veth peer name ctv9n
ip link set ctv9n netns ct-t
ip addr add 10.201.9.1/30 dev ctv9 && ip link set ctv9 up
ip -n ct-t addr add 10.201.9.2/30 dev ctv9n && ip -n ct-t link set ctv9n up
inns ct-t sysctl -qw net.ipv4.ip_forward=1
sed -n '/^table ip contour_gw {$/,/^}$/p' "$ROOT/deploy/contour-netns.sh" | sed 's/\$VETH_NS/ctv9n/' | inns ct-t nft -f -
sysctl -qw net.ipv4.conf.ctv9.rp_filter=2
ip route replace default via 10.201.9.2 dev ctv9 metric 10 table 2701

# Эхо в «интернете»: TCP и UDP, ответ — адрес отправителя.
inns router python3 - <<'PY' &
import socket, threading
def tcp(port):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('0.0.0.0', port)); s.listen()
    while True:
        c, a = s.accept(); c.sendall(a[0].encode()); c.close()
def udp(addr, port):
    # К адресу, а не к 0.0.0.0: иначе ответ уйдёт с адреса интерфейса, и conntrack его не узнает.
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind((addr, port))
    while True:
        d, a = s.recvfrom(100); s.sendto(a[0].encode(), a)
for p in (9339, 80): threading.Thread(target=tcp, args=(p,), daemon=True).start()
for addr in ('198.51.100.10', '198.51.100.20'): threading.Thread(target=udp, args=(addr, 50000), daemon=True).start()
threading.Event().wait()
PY
ECHO=$!
trap 'kill $ECHO 2>/dev/null || true' EXIT
sleep 0.5

# MAC — из ip, не из /sys: /sys в песочнице показывает сеть «сервера», а не устройства.
mac() { ip -n "$1" -o link show eth0 | sed -n 's/.*link\/ether \([0-9a-f:]*\).*/\1/p'; }
MAC1=$(mac dev1)
MAC2=$(mac dev2)
printf '{"devices":{"%s":"blocked","%s":"all"}}\n' "$MAC1" "$MAC2" > /etc/contour/gateway.json
# Подсети — так их сохраняет помощник по слову DNS (setNets; chown в песочнице не сделать).
printf '{"nets":["198.51.100.24/29"]}\n' > /etc/contour/gateway-nets.json

# Настоящий код помощника: правила, режимы, набор «через VPN».
cd "$ROOT"
cat > .gw-sandbox.ts <<'TS'
import { allowAddresses, applyGateway } from './src/root/gateway.ts';
await applyGateway();
await allowAddresses(['198.51.100.10'], 120);
TS
node .gw-sandbox.ts; rm -f .gw-sandbox.ts

tcp() { inns "$1" python3 -c "import socket,sys; s=socket.create_connection(('$2',$3),timeout=3); print(s.recv(100).decode())" 2>/dev/null || echo "нет связи"; }
udp() { inns "$1" python3 -c "import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(3); s.sendto(b'x',('$2',$3)); print(s.recv(100).decode())" 2>/dev/null || echo "нет связи"; }

echo "Шлюз в песочнице:"
check "dev1 («заблокированное») → заблокированный, TCP 9339" 172.31.0.2 "$(tcp dev1 198.51.100.10 9339)"
check "dev1 → заблокированный, UDP 50000 (голос)" 172.31.0.2 "$(udp dev1 198.51.100.10 50000)"
check "dev1 → обычный сайт — напрямую" 192.168.0.50 "$(tcp dev1 198.51.100.20 80)"
check "dev1 → адрес из подсети списка (не из DNS) — через выход" 172.31.0.2 "$(tcp dev1 198.51.100.30 80)"
check "dev1 → обычный, UDP — напрямую" 192.168.0.50 "$(udp dev1 198.51.100.20 50000)"
check "dev2 («всё через VPN») → обычный сайт — через выход" 172.31.0.2 "$(tcp dev2 198.51.100.20 80)"

cat > .gw-sandbox.ts <<'TS'
import { seenDevices } from './src/root/gateway.ts';
console.log((await seenDevices()).sort().join(','));
TS
check "кто на деле ходит через сервер — оба устройства" "$(printf '%s\n%s\n' "$MAC1" "$MAC2" | sort | paste -sd,)" "$(node .gw-sandbox.ts)"
rm -f .gw-sandbox.ts

ip route del default via 10.201.9.2 dev ctv9 table 2701
check "выход лежит: dev2 — никуда, не напрямую" "нет связи" "$(tcp dev2 198.51.100.20 80)"
check "выход лежит: dev1 → обычный — всё так же напрямую" 192.168.0.50 "$(tcp dev1 198.51.100.20 80)"

printf '{"devices":{}}\n' > /etc/contour/gateway.json
cat > .gw-sandbox.ts <<'TS'
import { applyGateway } from './src/root/gateway.ts';
await applyGateway();
TS
node .gw-sandbox.ts; rm -f .gw-sandbox.ts
check "шлюз выключен: пересылки нет" "0" "$(cat /proc/sys/net/ipv4/ip_forward)"
check "шлюз выключен: dev1 → обычный — никуда" "нет связи" "$(tcp dev1 198.51.100.20 80)"

[ "$fail" = 0 ] && echo "Всё сходится." || { echo "Есть расхождения."; exit 1; }
