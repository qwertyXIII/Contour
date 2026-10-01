# HANDOFF — веб-панель Contour (в работе, 2026-10-01)

Прочитать первым, удалить после того, как панель выкачена.

## Решения владельца (2026-10-01)
- Панель — **дома, по паролю**: `http://vpn.home` и `http://192.168.0.50` (вход lan на :80 отдаёт её по Host).
- В первой версии **сразу и ключи с выходами** (добавить/удалить/перезапустить/вкл-выкл/приоритет).
- Вид — **в стиле Alter**: дизайн-система вендорится копией в `web/shared` (`scripts/vendor-alter-ui.sh`, уже скопирована, 2,3 МБ, без `client/`), отдаётся по `/shared/…` — пути внутри не меняются.
- Contour — отдельное ПО (не часть Alter'а). Код: `~/dev/Contour` ↔ `server:~/project/Contour`, mutagen-сессия `contour` (на паузе; resume → flush → pause; права файлов 644/755).
- Стандарты владельца: скилл `fullstack-dev` (БЭМ, без innerHTML, классы-компоненты, `h()` из `/shared/utils/dom.js`, константы, файлы ≤ ~300 строк).

## Сделано (бэкенд — тип-чек чист, 40 тестов зелёные, НЕ выкачено)
- `src/stats/meter.ts` — счётчик на лету (скорость окно 3 с, история по минутам 24 ч, итоги за день, топ сайтов, снимок `/var/lib/contour/stats.json`). Подключён в `relay.ts` и проброс http.
- `src/log.ts` — журнал панели через `sink` логгера (`journal`).
- `src/outlets/links.ts` — vless/vmess/trojan/ss/hysteria2 → прокси mihomo. Протоколы в config: `amneziawg|wireguard|openvpn|link|subscription`; `mihomo-config.ts` умеет ссылки и подписки (provider + url-test группа, скачивание через ядерный выход `contour-fetch`).
- `deploy/contour-netns.sh` + `deploy/contour-ovpn-up.sh` — OpenVPN в namespace (туннель создаётся снаружи и переносится скриптом --up; DCO выкл). **Не проверено — ключа нет.**
- `src/root/` — помощник от root `contour-root`: сокет `/run/contour/root.sock` root:contour 660, команды status / outlet.add (conf|ovpn|link|subscription) / remove / restart / enable / priority / contour.restart; правит `contour.yaml` через yaml Document (комментарии живут, проверка parseConfig, `.bak`); удалённые ключи → `keys/removed/`; перезапуск Contour — ПОСЛЕ ответа (500 мс). `ovpn-check.ts` режет up/down/plugin/log/… в .ovpn.
- `src/panel/` — express 5 + helmet (без HSTS/upgrade-insecure), zod, express-rate-limit: `auth.ts` (scrypt, сессии в памяти, кука HttpOnly SameSite=Strict, изменяющие запросы требуют `X-Contour: 1`), `devices.ts` (имена по MAC из `/proc/net/arp`), `sites.ts` + `src/dns/overrides.ts` (ручные решения «всегда/никогда через VPN» — файл в папке DNS, DNS перечитывает), `speedtest.ts` (speed.cloudflare.com через выход, 10 с), `state.ts` (обзор: выходы + runtime от помощника с кешем 5 с, потребители, службы), `routes.ts` (API), `server.ts` (127.0.0.1:18090 + `take(socket)` из входа lan).
- `src/dns/main.ts` — имя панели (`panel.name`, `vpn.home`) → наш адрес; overrides сильнее списков.
- config: разделы `panel` (enabled, listen, port, name, passwordFile `/etc/contour/panel.json`, dataDir `/var/lib/contour/panel`).

## Осталось
1. **Сессии на диск** (`/var/lib/contour/panel/sessions.json`, хранить sha256 id) — иначе каждый перезапуск Contour после правки выхода выкидывает из панели.
2. **Фронтенд `web/`**: `index.html` (html `theme page`, normalize + `/shared/assets/fonts/inter.css` + `/shared/pages/alter.css` + свой `pages/contour.css`), `index.js` (`startSystem` из `/shared/system.js`, потом свои компоненты), вкладки `tabs`: Обзор (метрики, chart_form_area за сутки — 15-мин корзины, выходы кратко), Устройства (row + переименование диалогом), Сайты (добавить сайт + segmented, ручные решения, топ с трафиком, выученное), Выходы (карточки kv + замер/перезапуск/вкл/удалить, диалог «Добавить выход»: имя, segmented источник, textarea + файл, приоритет; после действия — тост и ожидание `/api/me`), Журнал. Вход — карточка с паролем. Свой блок только `console` (рамка страницы). `utils/api.js` (fetch + `X-Contour: 1`, таймаут), `utils/format.js`, `utils/constants.js`. Тосты — событие `toast:show {text, tone}`; диалог — `data-dialog-open="id"`, `dialog__close`; chart читает таблицу один раз при init — для обновления заменить узел.
3. **install.sh**: копия кода для root в `/opt/contour/root-app` (src + node_modules + package.json, root:root) и unit `contour-root.service` (root, `ExecStart=/opt/contour/node/bin/node /opt/contour/root-app/src/root/main.ts`); `contour-ovpn-up` в sbin; пароль панели (сгенерировать, показать один раз, scrypt-хеш в `/etc/contour/panel.json` root:contour 640) + `deploy/panel-password.sh`; sudoers — добавить `restart contour-root`; logrotate `ovpn-*.log`.
4. Тесты: links, ovpn-check, config-edit (на копии yaml), overrides, auth (hash/check), devices.readArp, meter.
5. README (§6 экран — сделано, как устроено), check.sh.
6. Выкатка: owner `install.sh` (sudo), затем проверка панели curl'ом через 127.0.0.1:18090 и с телефона.

## Факты, которые уже стоили отладки (не терять)
- AWG в mihomo медленнее ядра в 550 раз → AWG/WG только `kind: netns`.
- :443/:80 на всех адресах держит nginx → вход lan слушает 18443/18080, nft-таблица `ip contour` делает DNAT.
- DNS: UDP-DNS в mihomo отвечал через раз → свой DoH через выход; самообучение проверяет через туннель (иначе `time.apple.com` ушёл бы в VPN).
- `dns-packet` зовёт HTTPS/SVCB `UNKNOWN_65`/`UNKNOWN_64`.
- Токен Alter'а уже вписан владельцем в Alter.
