/**
 * Встроенные списки настроек — умолчания `config.ts`: сайты, подсети, порты
 * игр. Отдельно от разбора настроек: это данные, а не проверка полей.
 */

/**
 * Supercell: игровой сервер — TCP 9339; все их имена — в общем списке, поэтому
 * DNS отдаёт игре наш адрес. Напрямую нельзя — Supercell не пускает российские
 * адреса. ⚠️ Нужен выход, который пропускает 9339: AmneziaWG `ext` (в России)
 * соединение принимал и сразу рвал, OpenVPN того же провайдера пропускает —
 * Brawl Stars играется (2026-10-01).
 */
export const GAME_PORTS = [
  { port: 9339, hosts: ['brawlstarsgame.com', 'clashroyaleapp.com', 'clashofclans.com', 'supercell.com', 'haydaygame.com', 'boombeachgame.com', 'squadbustersgame.com'] },
];

/** itdoginfo/allow-domains, «Russia inside» — заблокированное и недоступное из России. */
export const DEFAULT_LISTS = ['https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Russia/inside-raw.lst'];

/**
 * itdoginfo/allow-domains, Subnets/IPv4: Discord (голос — свои сети и Google
 * Cloud), Telegram и Meta (звонки Telegram и WhatsApp, которые в России режут).
 * Решение владельца 2026-10-02: «списки добавить нужно».
 */
export const DEFAULT_SUBNET_LISTS = ['discord', 'telegram', 'meta']
  .map((s) => `https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Subnets/IPv4/${s}.lst`);

/**
 * Cloudflare (cloudflare.com/ips-v4): за ним пол-интернета, и в списке Discord
 * он есть. Через VPN по подсети его не ведём — Discord и сайты на Cloudflare и
 * так идут через VPN по именам (DNS), а весь Cloudflare в туннеле — это медленно
 * и дорого по трафику. Так предложено 2026-10-02; владелец ответил «списки
 * добавить нужно», вариант с Cloudflare — заменой этого списка на [].
 */
export const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];

/**
 * YouTube целиком: страницы, API приложения для ТВ, видео (googlevideo),
 * картинки. `googleapis.com` целиком не берём — через него ходит пол-Google,
 * а замедлен именно YouTube.
 */
export const LAN_DOMAINS = [
  'youtube.com', 'youtu.be', 'yt.be', 'youtube-nocookie.com', 'youtubekids.com',
  'googlevideo.com', 'ytimg.com', 'ggpht.com',
  'youtubei.googleapis.com', 'youtube.googleapis.com', 'youtubeembeddedplayer.googleapis.com', 'jnn-pa.googleapis.com',
];

/**
 * Российские сервисы, которые не пускают заграничные адреса (itdoginfo/allow-domains,
 * «Russia outside»: Госуслуги, налоговая, mos.ru, Озон, РЖД, Почта, Кинопоиск —
 * 39 имён на 2026-10-02, банков нет). Для телефона за границей: их — через
 * выход в России (раздача, `share/rules.ts`). Банки и прочее — свой список в
 * панели и `GEOIP,RU` на телефоне.
 */
export const COUNTRY_LISTS: Record<string, string[]> = {
  RU: ['https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Russia/outside-raw.lst'],
};
