#!/usr/bin/env bash
#
# Шлюз для устройств — целиком, в песочнице без root: свои пространства сети
# и монтирования (`unshare -rnm`), живую сеть сервера не трогает. Код — из
# папки, где лежит скрипт (не из ~/project/Contour и не из /opt/contour).
#
#   bash scripts/gateway-sandbox.sh
#
# Сеть песочницы:
#   dev1 (шлюз «заблокированное»)  ┐
#   dev2 (шлюз «всё через VPN»)    ├─ мост 192.168.0.0/24 ─ «сервер» (.50, здесь же
#   router (.1) ───────────────────┘    правила root/gateway.ts) ─ мосты ctv9, ctv8, ctv7
#   выходы: de1 (ct-t, мост 9, «Германия»), nl (ct-u, мост 8, «Нидерланды»),
#           de2 (ct-w, мост 7, вторая «Германия»); каждый ходит к роутеру своим
#           «туннелем» 172.31.K.0/30.
#   router: «интернет» 198.51.100.x и корпоративный 172.16.42.10 на lo.
# Эхо-сервер в «интернете» отвечает адресом, с которого пришёл запрос:
#   172.31.0.2 — через de1, 172.31.1.2 — через nl, 172.31.2.2 — через de2,
#   192.168.0.50 — напрямую через сервер.
set -euo pipefail
export PATH=/opt/node-aiproxy/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${1:-}" != inner ]; then
  exec unshare -rnm --propagation private bash "$0" inner
fi

fail=0
total=0
check() { # имя, ожидаемое, полученное
  total=$((total + 1))
  if [ "$2" = "$3" ]; then echo "  ✓ $1: $3"; else echo "  ✗ $1: ждали «$2», вышло «$3»"; fail=1; fi
}

mount -t tmpfs none /run/netns 2>/dev/null || { mkdir -p /tmp/ct-netns; mount --bind /tmp/ct-netns /run/netns; }
mount -t tmpfs none /etc/contour
mkdir -p /run/contour && mount -t tmpfs none /run/contour
# Группа contour — это мы: помощник пишет свои файлы root:contour, а chown на чужую группу в песочнице невозможен.
printf 'contour:x:0:\n' > /etc/contour/.group && mount --bind /etc/contour/.group /etc/group
ip link set lo up

for ns in dev1 dev2 router lanbr ct-t ct-u ct-w; do ip netns add "$ns"; ip -n "$ns" link set lo up; done
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

# «Интернет» на роутере.
ip -n router addr add 198.51.100.10/32 dev lo
ip -n router addr add 198.51.100.20/32 dev lo
ip -n router addr add 198.51.100.30/32 dev lo   # голосовой сервер: адреса нет в DNS, есть в подсети
for a in 40 45 50 60; do ip -n router addr add "198.51.100.$a/32" dev lo; done   # адреса классов
ip -n router addr add 172.16.42.10/32 dev lo   # корпоративный сервер: утечка напрямую ответила бы 192.168.0.50

tunnel() { # ns выхода, K: «туннель» 172.31.K.2 (выход) ↔ .1 (роутер)
  ip link add "tun$2" type veth peer name "tunr$2"
  ip link set "tun$2" netns "$1" && ip link set "tunr$2" netns router
  ip -n "$1" addr add "172.31.$2.2/30" dev "tun$2" && ip -n "$1" link set "tun$2" up
  ip -n router addr add "172.31.$2.1/30" dev "tunr$2" && ip -n router link set "tunr$2" up
  ip -n "$1" route add default via "172.31.$2.1"
}
bridge() { # ns выхода, N: мост 10.201.N.1 (сервер) ↔ .2 (выход) — как в contour-netns.sh
  ip link add "ctv$2" type veth peer name "ctv$2n"
  ip link set "ctv$2n" netns "$1"
  ip addr add "10.201.$2.1/30" dev "ctv$2" && ip link set "ctv$2" up
  ip -n "$1" addr add "10.201.$2.2/30" dev "ctv$2n" && ip -n "$1" link set "ctv$2n" up
  sysctl -qw "net.ipv4.conf.ctv$2.rp_filter=2"
}
# Часть выхода для шлюза — пересылка и подмена адреса внутри — из contour-netns.sh как есть.
for spec in 'ct-t 9 0' 'ct-u 8 1' 'ct-w 7 2'; do
  read -r ns n k <<<"$spec"
  tunnel "$ns" "$k"
  bridge "$ns" "$n"
  inns "$ns" sysctl -qw net.ipv4.ip_forward=1
  sed -n '/^table ip contour_gw {$/,/^}$/p' "$ROOT/deploy/contour-netns.sh" | sed "s/\\\$VETH_NS/ctv${n}n/" | inns "$ns" nft -f -
done
# «Как сейчас» (таблица 2701, её ведёт contour-netns.sh) в песочнице — один de1, как и было.
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
for addr in ('198.51.100.10', '198.51.100.20', '198.51.100.45'): threading.Thread(target=udp, args=(addr, 50000), daemon=True).start()
threading.Event().wait()
PY
ECHO=$!
HELPER=''
trap 'kill $ECHO $HELPER 2>/dev/null || true' EXIT
sleep 0.5

# MAC — из ip, не из /sys: /sys в песочнице показывает сеть «сервера», а не устройства.
mac() { ip -n "$1" -o link show eth0 | sed -n 's/.*link\/ether \([0-9a-f:]*\).*/\1/p'; }
MAC1=$(mac dev1)
MAC2=$(mac dev2)
printf '{"devices":{"%s":"blocked","%s":"all"}}\n' "$MAC1" "$MAC2" > /etc/contour/gateway.json
# Подсети — так их сохраняет помощник по слову DNS (setNets).
printf '{"nets":["198.51.100.24/29"]}\n' > /etc/contour/gateway-nets.json
# Выходы — помощник берёт из настроек мосты и имя прямого выхода (home, по умолчанию).
cat > /etc/contour/contour.yaml <<'YAML'
outlets:
  - { name: de1, kind: netns, bridge: 9, protocol: wireguard, conf: /etc/contour/keys/de1.conf, country: DE }
  - { name: nl, kind: netns, bridge: 8, protocol: openvpn, conf: /etc/contour/keys/nl.ovpn, country: NL }
  - { name: de2, kind: netns, bridge: 7, protocol: wireguard, conf: /etc/contour/keys/de2.conf, country: DE }
YAML

# Настоящий код помощника — одноразовым скриптом из этой же папки.
cd "$ROOT"
ts() { cat > .gw-sandbox.ts; node .gw-sandbox.ts; rm -f .gw-sandbox.ts; }
ts <<'TS'
import { allowAddresses, applyGateway } from './src/root/gateway.ts';
await applyGateway();
await allowAddresses(['198.51.100.10'], 120);
TS

tcp() { inns "$1" python3 -c "import socket,sys; s=socket.create_connection(('$2',$3),timeout=3); print(s.recv(100).decode())" 2>/dev/null || echo "нет связи"; }
udp() { inns "$1" python3 -c "import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(3); s.sendto(b'x',('$2',$3)); print(s.recv(100).decode())" 2>/dev/null || echo "нет связи"; }

echo "Шлюз в песочнице:"
check "dev1 («заблокированное») → заблокированный, TCP 9339" 172.31.0.2 "$(tcp dev1 198.51.100.10 9339)"
check "dev1 → заблокированный, UDP 50000 (голос)" 172.31.0.2 "$(udp dev1 198.51.100.10 50000)"
check "dev1 → обычный сайт — напрямую" 192.168.0.50 "$(tcp dev1 198.51.100.20 80)"
check "dev1 → адрес из подсети списка (не из DNS) — через выход" 172.31.0.2 "$(tcp dev1 198.51.100.30 80)"
check "dev1 → обычный, UDP — напрямую" 192.168.0.50 "$(udp dev1 198.51.100.20 50000)"
check "dev2 («всё через VPN») → обычный сайт — через выход" 172.31.0.2 "$(tcp dev2 198.51.100.20 80)"

check "кто на деле ходит через сервер — оба устройства" "$(printf '%s\n%s\n' "$MAC1" "$MAC2" | sort | paste -sd,)" "$(ts <<'TS'
import { seenDevices } from './src/root/gateway.ts';
console.log((await seenDevices()).sort().join(','));
TS
)"

ip route del default via 10.201.9.2 dev ctv9 table 2701
check "выход лежит: dev2 — никуда, не напрямую" "нет связи" "$(tcp dev2 198.51.100.20 80)"
check "выход лежит: dev1 → обычный — всё так же напрямую" 192.168.0.50 "$(tcp dev1 198.51.100.20 80)"

# Классы маршрута — через сокет настоящего процесса помощника: команды, очередь, сверка по тику.
start_helper() {
  node src/root/main.ts >>/run/contour/root.log 2>&1 &
  HELPER=$!
  for _ in $(seq 1 50); do [ -S /run/contour/root.sock ] && return; sleep 0.1; done
  echo "помощник не открыл сокет:"; cat /run/contour/root.log; exit 1
}
stop_helper() { kill "$HELPER"; wait "$HELPER" 2>/dev/null || true; HELPER=''; }
call() { # запрос помощнику (литерал TS), что сделать с ответом r
  ts <<TS
import { rootCall } from './src/root/protocol.ts';
const r = await rootCall($1, 10_000);
$2
TS
}
start_helper

echo "Классы маршрута:"
check "объявлены: каким выходом идёт каждый" "country-de:de1,country-nl:nl,only-corp:nl,country-ru:home" "$(call "{ cmd: 'gateway.classes', classes: [
  { name: 'country-de', outlets: ['de1', 'de2'], country: 'DE' },
  { name: 'country-nl', outlets: ['nl'], country: 'NL' },
  { name: 'only-corp', outlets: ['nl'], only: true, nets: ['172.16.42.0/24'] },
  { name: 'country-ru', outlets: ['home'], country: 'RU' },
] }" "console.log((r as Array<{ name: string; via: string | null }>).map((c) => \`\${c.name}:\${c.via}\`).join(','));")"
for spec in '40 country-de' '45 country-de' '50 country-nl' '60 country-ru'; do
  read -r a route <<<"$spec"
  call "{ cmd: 'gateway.route', ips: ['198.51.100.$a'], ttl: 120, route: '$route' }" ''
done
check "dev1 → адрес класса DE — через DE (de1), не NL" 172.31.0.2 "$(tcp dev1 198.51.100.40 80)"
check "dev2 («всё через VPN») → адрес класса NL — через NL, хотя «как сейчас» лежит" 172.31.1.2 "$(tcp dev2 198.51.100.50 80)"
check "dev1 → корпоративный 172.16.42.10 — «только через nl»" 172.31.1.2 "$(tcp dev1 172.16.42.10 80)"
check "dev2 → адрес класса RU (прямой выход) — через роутер" 192.168.0.50 "$(tcp dev2 198.51.100.60 80)"

# Прилипание: начатое через DE доезжает через DE, даже когда адрес ушёл в другой класс.
STICK=$(mktemp -d)
inns dev1 python3 - "$STICK" > "$STICK/out" <<'PY' &
import os, socket, sys, time
d = sys.argv[1]
def ask(s):
    try:
        s.sendto(b'x', ('198.51.100.45', 50000)); return s.recv(100).decode()
    except Exception:
        return 'нет связи'
def sock():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3); return s
s = sock()
print(ask(s), flush=True)
open(os.path.join(d, 'first'), 'w').close()
while not os.path.exists(os.path.join(d, 'go')): time.sleep(0.05)
print(ask(s), flush=True)
print(ask(sock()), flush=True)
PY
CLIENT=$!
for _ in $(seq 1 80); do [ -f "$STICK/first" ] && break; sleep 0.05; done
call "{ cmd: 'gateway.route', ips: ['198.51.100.45'], ttl: 120, route: 'country-nl' }" ''
touch "$STICK/go"
wait "$CLIENT" || true
check "UDP начат через DE" 172.31.0.2 "$(sed -n 1p "$STICK/out")"
check "адрес ушёл в NL — начатое доезжает через DE (ct mark)" 172.31.0.2 "$(sed -n 2p "$STICK/out")"
check "новое соединение — уже через NL" 172.31.1.2 "$(sed -n 3p "$STICK/out")"
rm -rf "$STICK"

ip link del ctv9   # de1 лёг: ядро снимает его маршруты вместе с мостом
check "de1 лёг: класс DE — вторым выходом DE (de2), сразу" 172.31.2.2 "$(tcp dev1 198.51.100.40 80)"
ip link del ctv7   # de2 лёг
check "оба DE легли: dev1 → адрес DE — никуда (не NL, не напрямую)" "нет связи" "$(tcp dev1 198.51.100.40 80)"
check "оба DE легли: dev2 («всё через VPN») → адрес DE — никуда" "нет связи" "$(tcp dev2 198.51.100.40 80)"

bridge ct-t 9      # de1 снова поднят — маршрут вернёт сверка помощника по тику
sleep 6
check "de1 снова поднят: сверка по тику вернула маршрут — DE через de1" 172.31.0.2 "$(tcp dev1 198.51.100.40 80)"

# Новые правила после install.sh пересоздают таблицу — адреса наборов не должны потеряться.
stop_helper
echo stale > /run/contour/gateway.ruleset
start_helper
for _ in $(seq 1 50); do [ "$(cat /run/contour/gateway.ruleset)" != stale ] && break; sleep 0.1; done
check "таблица пересоздана: адрес класса DE на месте" 172.31.0.2 "$(tcp dev1 198.51.100.40 80)"
check "таблица пересоздана: адрес «как сейчас» на месте" 1 "$(nft -j list set ip contour_gw vpn_dst | grep -c '"198.51.100.10"' || true)"

ip link del ctv8   # nl лёг
check "nl лёг: корпоративный — никуда, никогда напрямую" "нет связи" "$(tcp dev1 172.16.42.10 80)"
stop_helper

printf '{"devices":{}}\n' > /etc/contour/gateway.json
ts <<'TS'
import { applyGateway } from './src/root/gateway.ts';
await applyGateway();
TS
check "шлюз выключен: пересылки нет" "0" "$(cat /proc/sys/net/ipv4/ip_forward)"
check "шлюз выключен: dev1 → обычный — никуда" "нет связи" "$(tcp dev1 198.51.100.20 80)"
check "шлюз выключен: правил шлюза и классов нет" 0 "$(ip rule show | grep -c 'lookup 27[0-9][0-9]' || true)"

[ "$fail" = 0 ] && echo "Всё сходится: $total из $total." || { echo "Есть расхождения ($total проверок)."; cat /run/contour/root.log; exit 1; }
