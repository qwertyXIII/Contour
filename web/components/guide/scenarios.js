// Инструкции «как подключить» — данными: сценарий → шаги, значения, оговорки.
// Адрес сервера в сети и имя панели приходят из состояния (`a`, `panel`), а не
// пишутся в текст: поменяли `lan.address` — инструкция та же. Значения в шагах
// (`kv`) показываются с кнопкой «Скопировать».
//
// У шага — сцена (`scene`): что показать на макете устройства и что там
// происходит, ударами ролика (глаголы — в reel.js, экраны — в screens/). Текст шага
// остаётся главным: его читают скринридер и тот, кто смотрит без движения.

const ROUTE_MAC = (a) => `networksetup -setadditionalroutes "Wi-Fi" 172.16.42.0 255.255.255.0 ${a}`;
const ROUTE_WIN = (a) => `route -p add 172.16.42.0 mask 255.255.255.0 ${a}`;
const CORP_RULE = '[только: corp_mixed]\n172.16.42.0/24';
// Шлюз у устройства в «Устройствах»: открыть список и выбрать «только заблокированное».
const GATEWAY_ON = (id, say) => [
  ['tap', id, { show: `${id}.pop`, say }],
  ['tap', `${id}-blocked`, { hide: `${id}.pop`, set: { [id]: { value: 'только заблокированное' } }, show: id === 'gw' ? 'wait' : null }],
];

/** `s` — `{ a: '192.168.0.50', panel: 'vpn.home' }`. */
export function scenarios(s) {
  return [
    {
      id: 'tv',
      icon: 'tv',
      title: 'Телевизор',
      lead: 'Заблокированные сайты и приложения-сайты (YouTube) — через VPN, остальное — как было. На телевизоре меняется только DNS.',
      steps: [
        {
          title: 'Открой настройки сети телевизора', text: 'Hisense VIDAA: Настройки → Сеть → Конфигурация сети → IP-настройки → «Вручную». Остальные поля (IP, маска, шлюз) оставь как есть.',
          scene: [
            ['screen', 'tv.home'], ['focus', 'video'],
            ['key', 'menu', { go: 'tv.settings' }],
            ['focus', 'picture'], ['focus', 'sound'], ['focus', 'network'], ['ok', { go: 'tv.network' }],
            ['focus', 'netconf'], ['ok', { go: 'tv.netconf' }],
            ['focus', 'type'], ['focus', 'wifi'], ['focus', 'ipset'], ['ok', { go: 'tv.ip' }],
            ['focus', 'mode'], ['key', 'right', { set: { mode: { value: '‹ Вручную ›' } }, say: 'Пульт: вправо — «Вручную»' }],
            ['mark', 'addr', 'IP, маску и шлюз не трогай'],
          ],
        },
        {
          title: 'Впиши DNS', text: 'Один DNS — адрес сервера. Второй оставь пустым или тем же адресом: роутер вторым DNS ломает работу через раз — телевизор спрашивает оба.', kv: [['DNS', s.a]],
          scene: [
            ['focus', 'mask'], ['focus', 'gw'], ['focus', 'dns1'], ['ok'],
            ['type', 'dns1', s.a, { tap: false }],
            ['mark', 'dns2', 'DNS 2 — пусто или тот же адрес'],
            ['focus', 'save'], ['ok', { show: 'saved' }],
          ],
        },
        {
          title: 'Проверь', text: 'Телевизор появится в панели во вкладке «Устройства» с трафиком. Открой YouTube.',
          scene: [
            ['key', 'home', { go: 'tv.home' }],
            ['focus', 'live'], ['focus', 'video'], ['ok', { go: 'tv.video', say: 'Открой видео' }],
            ['play', 'clip', 2400],
            ['go', 'panel.tvnew'],
            ['show', 'tv', { say: 'В панели, во вкладке «Устройства», — телевизор с трафиком' }],
            ['mark', 'tv', 'Телевизор ходит через сервер'],
            ['done', 'Работает'],
          ],
        },
      ],
      warn: 'Сервер становится DNS телевизора: выключен сервер — у телевизора нет интернета. Вернуть как было — IP-настройки «Автоматически».',
      note: 'Android TV и приставки с зашитым DNS (8.8.8.8 в приложении) могут не послушаться — для них шлюз (вкладка «Всё через сервер»).',
    },
    {
      id: 'dns',
      icon: 'phone',
      title: 'Телефон или ноутбук дома',
      lead: 'Только сайты, ничего не ставить: DNS устройства — сервер. Для голоса, звонков и игр — «Всё через сервер».',
      steps: [
        {
          title: 'iPhone', text: 'Настройки → Wi-Fi → ⓘ у домашней сети → «Настройка DNS» → «Вручную» → удали остальные адреса → «Добавить сервер».', kv: [['DNS', s.a]],
          scene: [
            ['screen', 'ios.settings'],
            ['tap', 'wifi', { go: 'ios.wifi' }],
            ['tap', 'home.info', { go: 'ios.net' }],
            ['scroll', 'dnsmode'],
            ['tap', 'dnsmode', { go: 'ios.dns' }],
            ['pick', 'manual', { show: ['old.minus', 'add'] }],
            ['tap', 'old.minus', { show: 'old.del', say: 'Удали остальные адреса' }],
            ['tap', 'old.del', { gone: 'old' }],
            ['tap', 'add', { show: 'new', gone: 'add' }],
            ['type', 'new', s.a, { tap: false }],
            ['tap', 'save', { set: { 'ios.net#dnsmode': { value: 'Вручную' } }, go: 'ios.net', how: 'back' }],
            ['mark', 'dnsmode', 'DNS — вручную, адрес сервера'],
          ],
        },
        {
          title: 'Mac', text: 'Системные настройки → Сеть → Wi-Fi → «Подробнее» у сети → DNS → «+» → адрес сервера; остальные адреса удали.',
          scene: [
            ['go', 'mac.general'],
            ['tap', 'net', { go: 'mac.net' }],
            ['tap', 'wifi', { go: 'mac.wifi' }],
            ['tap', 'more', { show: 'details', say: '«Подробнее…» у сети' }],
            ['pick', 'dns', { show: 'p-dns', gone: 'p-tcp' }],
            ['tap', 'srv-old', { set: { 'srv-old': { on: true } }, say: 'Выдели старый адрес' }],
            ['tap', 'minus', { gone: 'srv-old', say: '«−» — удалить' }],
            ['tap', 'plus', { show: 'srv-new', say: '«+» — добавить' }],
            ['type', 'srv-new', s.a, { tap: false }],
            ['tap', 'ok', { hide: 'details' }],
            ['done', 'DNS — адрес сервера'],
          ],
        },
        {
          title: 'Windows', text: 'Параметры → Сеть и Интернет → Wi-Fi → свойства сети → «Назначение DNS-сервера» → «Изменить» → «Вручную», IPv4 — адрес сервера.',
          scene: [
            ['go', 'win.home', 'open'],
            ['tap', 'net', { go: 'win.net' }],
            ['tap', 'wifi', { go: 'win.wifi' }],
            ['tap', 'props', { go: 'win.props' }],
            ['tap', 'dns-edit', { show: 'dlg', say: '«Изменить» у «Назначение DNS»' }],
            ['tap', 'mode', { show: 'mode.pop' }],
            ['tap', 'm-manual', { hide: 'mode.pop', set: { mode: { value: 'Вручную' } }, show: 'v4' }],
            ['toggle', 'v4on', true, { show: 'pref' }],
            ['type', 'pref', s.a],
            ['tap', 'save', { hide: 'dlg', set: { dnsa: { value: 'Вручную' } } }],
            ['mark', 'dnsa', 'DNS — вручную'],
          ],
        },
        {
          title: 'Выключи обход DNS', text: 'iPhone: в той же сети выключи «Ограничить отслеживание IP-адреса», в iCloud — «Частный узел». Браузеры: «Безопасный DNS» (Chrome, Edge) или DNS через HTTPS (Firefox) — выключить: иначе они спрашивают мимо сервера.',
          scene: [
            ['go', 'ios.net'],
            ['toggle', 'limit', false],
            ['go', 'ios.settings', 'back'],
            ['tap', 'account', { go: 'ios.icloud', say: '«Учётная запись» → iCloud' }],
            ['tap', 'relay', { go: 'ios.relay' }],
            ['toggle', 'relay-on', false],
            ['go', 'web.secure'],
            ['toggle', 'secure', false, { say: 'В браузере: выключи «Безопасный DNS»' }],
            ['done', 'Адреса спрашивают у сервера'],
          ],
        },
      ],
      warn: 'Ушёл из дома — сеть другая, настройка домашней сети не мешает. Сервер выключен — сайты дома не откроются, пока не вернёшь DNS «Автоматически».',
    },
    {
      id: 'gateway',
      icon: 'route',
      title: 'Всё через сервер',
      lead: 'Голос Discord, звонки, игры, приложения со своими адресами: сервер — маршрутизатор устройства. Заблокированное (или всё — в режиме «всё через VPN») идёт через VPN любым протоколом.',
      steps: [
        {
          title: 'Включи шлюз в панели', text: 'Вкладка «Устройства» → у устройства «Шлюз»: «только заблокированное» или «всё через VPN». Устройство должно уже быть в списке — сначала поставь ему DNS (вкладка «Телефон или ноутбук»).',
          scene: [
            ['screen', 'panel.devices'],
            ...GATEWAY_ON('gw', '«Шлюз» у iPhone'),
            ['mark', 'wait', 'IP для устройства панель пишет в его строке'],
          ],
        },
        {
          title: 'На устройстве — IP вручную', text: 'iPhone: Настройки → Wi-Fi → ⓘ у сети → «Настройка IP» → «Вручную». IP — тот, что панель пишет в строке устройства: у каждого свой, чужой не бери.', kv: [['Маска', '255.255.255.0'], ['Маршрутизатор', s.a], ['DNS', s.a]],
          scene: [
            ['go', 'ios.wifi'],
            ['tap', 'home.info', { go: 'ios.net' }],
            ['tap', 'ipmode', { go: 'ios.ip' }],
            ['pick', 'manual', { show: ['mhead', 'mgroup'] }],
            ['type', 'ip', '192.168.0.200', { say: 'IP — из строки устройства в панели' }],
            ['type', 'mask', '255.255.255.0'],
            ['type', 'router', s.a, { say: `Маршрутизатор — ${s.a}` }],
            ['tap', 'save', { set: { 'ios.net#ipmode': { value: 'Вручную' } }, go: 'ios.net', how: 'back' }],
            ['scroll', 'dnsmode'],
            ['mark', 'dnsmode', `DNS — тоже ${s.a}`],
          ],
        },
        {
          title: 'Проверь', text: 'В строке устройства пропадёт «шлюз ждёт» — пакеты правда идут через сервер. Открой заблокированное и позвони в Discord.',
          scene: [
            ['go', 'panel.devices'],
            ['gone', 'wait', { say: '«Шлюз ждёт» пропал' }],
            ['show', 'gwok', { say: 'Пакеты идут через сервер' }],
            ['mark', 'gwok', 'Теперь — звонки, игры, всё'],
            ['done', 'Шлюз работает'],
          ],
        },
      ],
      warn: 'Сервер выключен — у этого устройства дома нет интернета вообще. Вернуть как было — «Настройка IP» → «Автоматически».',
    },
    {
      id: 'corp',
      icon: 'lock',
      title: 'Рабочая сеть',
      lead: 'Подсеть, которая открывается только через свой туннель (корпоративные серверы): правило «только через …» во вкладке «Правила». Проще всего — Shadowrocket на устройстве (сценарий «Через Shadowrocket»): подсеть из правил уже в его конфиге, свой корпоративный VPN держи выключенным. Без Shadowrocket — шлюз и маршрут только этой подсети, шаги ниже.',
      steps: [
        {
          title: 'Правило', text: 'Вкладка «Правила» → «Новый список» → «Вручную», свой формат: раздел [только: имя выхода], под ним подсеть. Проверь там же: «Куда пойдёт сайт» → адрес из подсети → «только через: …».', kv: [['Пример', CORP_RULE]],
          scene: [
            ['screen', 'panel.rules'],
            ['tap', 'new', { show: 'dlg' }],
            ['pick', 'src-manual'],
            ['type', 'text', CORP_RULE, { say: 'Раздел [только: corp_mixed], под ним подсеть' }],
            ['tap', 'add', { hide: 'dlg', show: 'mylist' }],
            ['type', 'host', '172.16.42.10'],
            ['tap', 'check', { show: 'result' }],
            ['mark', 'verdict', '«только через: corp_mixed»'],
          ],
        },
        {
          title: 'Шлюз устройству', text: 'Вкладка «Устройства» → у устройства «Шлюз: только заблокированное». Без этого сервер пакеты устройства не пересылает.',
          scene: [
            ['go', 'panel.devices'],
            ...GATEWAY_ON('mgw', '«Шлюз» у ноутбука'),
            ['mark', 'mgw', 'Шлюз: только заблокированное'],
          ],
        },
        {
          title: 'Маршрут на устройстве', text: 'Только эта подсеть — через сервер, VPN на устройстве не нужен. Mac — навсегда, для Wi-Fi (убрать — та же команда без адресов); Windows — навсегда, ключ -p.', kv: [['Mac', ROUTE_MAC(s.a)], ['Windows', ROUTE_WIN(s.a)]],
          scene: [
            ['go', 'term.mac', 'open'],
            ['type', 'sh', ROUTE_MAC(s.a), { say: 'Mac — в Терминале' }],
            ['enter', 'sh', []],
            ['go', 'term.win', 'open'],
            ['type', 'cmd', ROUTE_WIN(s.a), { say: 'Windows — командная строка от администратора' }],
            ['enter', 'cmd', [' ОК!']],
          ],
        },
        {
          title: 'Проверь', text: 'Открой адрес из подсети. Лёг выход правила — подсеть недоступна, но никуда больше не уходит: ни в другой туннель, ни напрямую.',
          scene: [
            ['go', 'corp.site', 'open'],
            ['type', 'url', 'http://172.16.42.10'],
            ['show', 'page', { say: 'Открылось — через corp_mixed' }],
            ['done', 'Подсеть — только через свой туннель'],
          ],
        },
      ],
      note: 'Маршрут привязан к Wi-Fi устройства, не к дому: вне дома он смотрит в пустоту — там — корпоративный VPN или Shadowrocket. SSH через Contour и с сервера: ssh -o ProxyCommand="ssh server python3 project/Contour/scripts/ssh-via-contour.py %h %p" <хост> — туннель через прокси Contour по тем же правилам.',
    },
    {
      id: 'router',
      icon: 'home',
      title: 'Вся сеть сразу',
      lead: 'DNS всем устройствам дома раздаёт роутер — ничего не настраивать на каждом. Делать после того, как телевизор и телефон проверены по одному.',
      steps: [
        {
          title: 'Настройки DHCP роутера', text: 'TP-Link Archer: «Дополнительные настройки» → «Сеть» → «DHCP-сервер». Другие роутеры — раздел DHCP / LAN.',
          scene: [
            ['screen', 'router.home'],
            ['tap', 'adv', { go: 'router.adv' }],
            ['tap', 'net', { show: ['inet', 'lan', 'dhcp'] }],
            ['tap', 'dhcp', { go: 'router.dhcp' }],
          ],
        },
        {
          title: 'Первичный DNS — сервер', text: 'Вторичный — пусто (или тот же адрес): с роутером во вторичном устройства ходили бы мимо сервера через раз.', kv: [['Первичный DNS', s.a]],
          scene: [
            ['type', 'dns1', s.a],
            ['mark', 'dns2', 'Вторичный — пусто или тот же адрес'],
            ['tap', 'save', { show: 'saved' }],
            ['done', 'DNS всем — сервер'],
          ],
        },
        {
          title: 'Переподключи устройства', text: 'Новый DNS устройства берут при новой аренде адреса: выключи и включи Wi-Fi.',
          scene: [
            ['go', 'ios.wifi'],
            ['toggle', 'wifi-on', false, { gone: ['home', 'nets-head', 'nets'] }],
            ['wait', 500],
            ['toggle', 'wifi-on', true, { show: ['home', 'nets-head', 'nets'] }],
            ['done', 'Новый DNS получен'],
          ],
        },
      ],
      warn: 'Теперь от сервера зависит интернет всей квартиры: выключен сервер — DNS нет ни у кого. Вернуть — в DHCP роутера пустой DNS (или адрес роутера).',
    },
    {
      id: 'away',
      icon: 'globe',
      title: 'Через Shadowrocket',
      lead: 'iPhone или Mac с процессором Apple — из любой сети, дома тоже: Shadowrocket с подпиской одним QR. Правила те же, что у всего Contour, рабочая сеть из «Правил» — тоже.',
      steps: [
        {
          title: 'Добавь устройство', text: 'Вкладка «Раздача» → «Телефоны» → имя → «Добавить». У каждого устройства свой ключ. Нужны страны для поездок — отметь их чипами в карточке.',
          scene: [
            ['screen', 'panel.share'],
            ['type', 'name', 'iPhone'],
            ['tap', 'add', { show: ['iphone', 'countries'], set: { name: { value: '' } } }],
            ['tap', 'c-tr', { set: { 'c-tr': { on: true } }, say: 'Страны для поездок — чипами' }],
          ],
        },
        {
          title: 'Подписка', text: '«Подключить» → «Подписка». iPhone — сканер слева вверху в Shadowrocket; Mac — «Скопировать ссылку», в Shadowrocket ⊕ → Subscribe → вставить. Добавятся «Contour» и серверы стран. Подписку не переименовывай в «Contour»: правила зовут сервер по этому имени.',
          scene: [
            ['tap', 'connect', { show: 'qrsheet' }],
            ['mark', 'code', 'QR подписки — все серверы телефона'],
            ['go', 'rocket.home'],
            ['tap', 'scan', { go: 'rocket.scan', how: 'rise', say: 'Сканер — слева вверху' }],
            ['scan', 'cam'],
            ['go', 'rocket.home', 'sink'],
            ['gone', 'none'],
            ['show', ['contour', 'de', 'tr'], { say: 'Добавились «Contour» и серверы стран' }],
            ['done', 'Подписка добавлена'],
          ],
        },
        {
          title: 'Правила', text: 'Из того же окна — ссылка на правила: Shadowrocket → «Конфиг» → ⊕ → вставить → «Загрузить» → выбрать `contour.conf` (не default.conf).',
          scene: [
            ['tap', 't-conf', { go: 'rocket.conf', how: 'fade' }],
            ['tap', 'cplus', { show: 'add' }],
            ['paste', 'url', 'http://…/contour.conf', { say: 'Вставь ссылку на правила из панели' }],
            ['tap', 'load', { hide: 'add', show: 'contour' }],
            ['pick', 'contour', { say: 'Выбери contour.conf — не default.conf' }],
            ['mark', 'contour', 'Галочка — на contour.conf'],
          ],
        },
        {
          title: 'Включи', text: 'На главной: «Глобальная маршрутизация» — «Конфиг», сервер — Contour; группы стран — DIRECT, уехал — сервер страны.',
          scene: [
            ['tap', 't-home', { go: 'rocket.home', how: 'fade' }],
            ['mark', 'route', '«Глобальная маршрутизация» — «Конфиг»'],
            ['pick', 'contour', { say: 'Сервер — Contour' }],
            ['toggle', 'power', true, { set: { power: { on: true, value: 'Подключено' } } }],
            ['done', 'Подключено'],
          ],
        },
      ],
      note: 'Дома с включённым Shadowrocket телефон ходит к своему же внешнему адресу — работает, если роутер умеет петлю NAT; не умеет — дома выключай Shadowrocket и пользуйся DNS.',
    },
    {
      id: 'programs',
      icon: 'server',
      title: 'Программы на сервере',
      lead: 'Alter и программы самого сервера — через HTTP-прокси с токеном: каждая программа — своё имя, своя строка в «Устройствах».',
      steps: [
        {
          title: 'Адрес прокси', text: 'Токены — в /etc/contour/tokens (sudo); владельцу — готовая строка в ~/.config/contour/proxy.', kv: [['Прокси', 'http://<имя>:<токен>@127.0.0.1:3128']],
          scene: [
            ['screen', 'term.srv'],
            ['type', 'sh', 'cat ~/.config/contour/proxy'],
            ['enter', 'sh', ['http://owner:••••••••@127.0.0.1:3128']],
            ['type', 'sh', 'export PROXY=$(cat ~/.config/contour/proxy)'],
            ['enter', 'sh', []],
            ['type', 'sh', 'curl -x "$PROXY" -sI https://example.com'],
            ['enter', 'sh', ['HTTP/1.1 200 Connection Established', 'HTTP/2 200']],
          ],
        },
        {
          title: 'Страна выхода', text: 'Заголовок к прокси выбирает страну: нет выхода в этой стране — отказ, не другая страна.', kv: [['Заголовок', 'Contour-Exit: RU']],
          scene: [
            ['type', 'sh', 'curl -x "$PROXY" -H "Contour-Exit: RU" -sI https://example.com'],
            ['enter', 'sh', ['HTTP/1.1 200 Connection Established', 'HTTP/2 200']],
            ['type', 'sh', 'curl -x "$PROXY" -H "Contour-Exit: JP" -sI https://example.com', { say: 'Выхода в этой стране нет —' }],
            ['enter', 'sh', ['HTTP/1.1 502 Bad Gateway']],
            ['mark', 'sh', 'Отказ, а не другая страна'],
          ],
        },
        {
          title: 'Куда пойдёт сайт', text: 'Вкладка «Правила» → «Куда пойдёт сайт» — какое правило берёт сайт и через какой выход он пойдёт.',
          scene: [
            ['go', 'panel.site', 'open'],
            ['type', 'host', 'youtube.com'],
            ['tap', 'check', { show: 'result' }],
            ['mark', 'route', 'Сайт → правило → выход'],
          ],
        },
      ],
    },
  ];
}
