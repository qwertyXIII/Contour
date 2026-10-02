# ProxyCommand для ssh: туннель через HTTP-прокси Contour (CONNECT) — по его правилам («только через …» для корпоративной сети). Токен — из ~/.config/contour/proxy на сервере.
# ssh -o ProxyCommand="ssh server python3 project/Contour/scripts/ssh-via-contour.py %h %p" <хост>
import base64, os, socket, sys, threading, urllib.parse
u = urllib.parse.urlparse(open(os.path.expanduser("~/.config/contour/proxy")).read().strip())
s = socket.create_connection((u.hostname, u.port), 10)
auth = base64.b64encode(f"{urllib.parse.unquote(u.username)}:{urllib.parse.unquote(u.password)}".encode()).decode()
host, port = sys.argv[1], sys.argv[2]
s.sendall(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Authorization: Basic {auth}\r\n\r\n".encode())
head = b""
while b"\r\n\r\n" not in head:
    chunk = s.recv(1)
    if not chunk: sys.exit("прокси закрыл соединение")
    head += chunk
if b" 200 " not in head.split(b"\r\n")[0]: sys.exit("прокси: " + head.split(b"\r\n")[0].decode())
s.settimeout(None)
def up():
    while True:
        d = os.read(0, 65536)
        if not d: s.shutdown(socket.SHUT_WR); return
        s.sendall(d)
threading.Thread(target=up, daemon=True).start()
while True:
    d = s.recv(65536)
    if not d: break
    os.write(1, d)
