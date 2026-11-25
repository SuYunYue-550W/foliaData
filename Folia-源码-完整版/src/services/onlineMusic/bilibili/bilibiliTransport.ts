// src/services/onlineMusic/bilibili/bilibiliTransport.ts
// B站所有原始请求只在这一层发出，别的文件不碰 B站接口（平台规则留在平台目录）。
//
// 实测记录（2026-11-19）：
// - 搜索必须带 buvid3 cookie，否则 HTTP 412；buvid3 由访问 www.bilibili.com 时的 Set-Cookie 下发。
// - 推荐/热门/分区/直播/播放地址均无需登录；收藏/历史必须 SESSDATA。
// - Web 端取流要求 Referer 在 bilibili.com 域下且 UA 非空，否则 403。
// 浏览器里 Referer/Cookie 由浏览器自己带，这里只需在 Electron/Node 侧补齐。

import { OnlineProviderError } from '../../../types/onlineMusic';
import { getProviderSessionKey } from '../providerStorage';
import { createNativeFetch } from '../../nativeHttpFetch';
import { readRawSetCookies } from '../../../nativeBridge/api/setCookieHeaders.js';
import { encodeWbiQuery, signWbi } from './bilibiliWbi';

// B站接口不给 `https://localhost` 回 CORS 头，安卓 WebView 里裸 fetch 会直接
// `TypeError: Failed to fetch`（扫码登录 qr-generate 实测 176ms 就失败）。
// createNativeFetch 在安卓上走 FoliaNative.httpRequest（OkHttp，不受 CORS 且自动带
// WebView cookie），其它平台回落全局 fetch。与项目里其它页内 API 请求走的是同一条路。
const biliFetch = createNativeFetch();

export type BilibiliModule =
    | 'recommend' | 'popular' | 'ranking'
    | 'video-newlist' | 'live-areas' | 'live-rooms' | 'live-playurl'
    | 'search' | 'view' | 'playurl'
    | 'qr-generate' | 'qr-poll' | 'login-status' | 'logout'
    | 'fav-folders' | 'fav-resources' | 'history';

const API = {
    recommend: 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd',
    popular: 'https://api.bilibili.com/x/web-interface/popular',
    ranking: 'https://api.bilibili.com/x/web-interface/ranking/v2',
    'video-newlist': 'https://api.bilibili.com/x/web-interface/newlist',
    'live-areas': 'https://api.live.bilibili.com/room/v1/Area/getList',
    'live-rooms': 'https://api.live.bilibili.com/room/v3/area/getRoomList',
    'live-playurl': 'https://api.live.bilibili.com/room/v1/Room/playUrl',
    view: 'https://api.bilibili.com/x/web-interface/view',
    playurl: 'https://api.bilibili.com/x/player/playurl',
    qrGenerate: 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate',
    qrPoll: 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll',
    favFolders: 'https://api.bilibili.com/x/v3/fav/folder/created/list-all',
    favResources: 'https://api.bilibili.com/x/v3/fav/resource/list',
    history: 'https://api.bilibili.com/x/web-interface/history/cursor',
} as const;

/** B站的「稍后再试」业务码：请求过快 / 风控 / 风险验证。 */
const BILIBILI_RETRY_CODES = new Set([-509, -403, -352]);

const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/search/type';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

/** 登录态：只存 opaque 的 SESSDATA 字符串；敏感字段的加密在 electron 侧（见 bilibiliSession.cjs）。 */
export const readBilibiliSessdata = (): string | null => {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(getProviderSessionKey('bilibili', 'sessdata'));
};

/** 登录成功后写入 SESSDATA；传空串表示登出。 */
export const writeBilibiliSessdata = (value: string): void => {
    if (typeof localStorage === 'undefined') return;
    const key = getProviderSessionKey('bilibili', 'sessdata');
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
};

export const readBilibiliBiliJct = (): string | null => {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(getProviderSessionKey('bilibili', 'biliJct'));
};

export const hasBilibiliLogin = (): boolean => Boolean(readBilibiliSessdata());

/** buvid3 是一次性的访客标识：本进程取过就不再重复访问首页。 */
let buvid3: string | null = null;
let buvidPromise: Promise<string | null> | null = null;

const parseBuvid = (response: Response): string | null => {
    // 浏览器把 Set-Cookie 列为 forbidden response header，headers.get() 恒为 null；
    // Android 原生桥会把它镜像到 x-folia-set-cookie。复用项目统一的读取函数，
    // 覆盖 getSetCookie() / Set-Cookie / 镜像头三种来源。
    const cookies = readRawSetCookies(response);
    for (const cookie of cookies) {
        const found = /(?:^|;\s*)buvid3=([^;]+)/.exec(cookie);
        if (found) return found[1];
    }
    return null;
};

const ensureBuvid = async (): Promise<string | null> => {
    if (buvid3) return buvid3;
    if (buvidPromise) return buvidPromise;
    buvidPromise = (async () => {
        try {
            const response = await biliFetch('https://www.bilibili.com/', {
                headers: { 'User-Agent': UA },
                credentials: 'include',
            });
            buvid3 = parseBuvid(response) || readBilibiliCookieFromDocument();
        } catch {
            buvid3 = readBilibiliCookieFromDocument();
        }
        buvidPromise = null;
        return buvid3;
    })();
    return buvidPromise;
};

/** 浏览器里 cookie 由浏览器管理，fetch 不用手动写 Cookie 头；这里只是给 Node 侧一个兜底。 */
const readBilibiliCookieFromDocument = (): string | null => {
    if (typeof document === 'undefined') return null;
    const found = /(?:^|;\s*)buvid3=([^;]+)/.exec(document.cookie);
    return found ? found[1] : null;
};

const cookieHeader = (buvid: string | null): string => {
    const parts: string[] = [];
    if (buvid) parts.push(`buvid3=${buvid}`);
    // 浏览器里 document.cookie 已有 SESSDATA，重复写同名 cookie 无害；Node 侧必须显式带。
    const sess = readBilibiliSessdata();
    if (sess) parts.push(`SESSDATA=${sess}`);
    return parts.join('; ');
};

export interface BilibiliResult<T> {
    data: T;
    /** 扫码轮询等业务码：0 成功，86101 未扫码，86090 已扫待确认，86038 过期。 */
    code: number;
    message: string;
}

const send = async <T>(
    url: string,
    params: Record<string, string | number | undefined>,
    module: BilibiliModule,
    options: { signed?: boolean } = {},
): Promise<BilibiliResult<T>> => {
    // wbi 端点（目前只有 recommend）必须先签名：wts + w_rid 要参与 query 的
    // md5 计算，不能在拼完 URL 之后再加。签名需要额外取一次 nav，key 缓存 1 小时。
    const finalParams = options.signed ? await signWbi(params) : params;
    // 签名请求必须用与 w_rid 计算完全相同的序列化（%20 而非 +、过滤 !'()*）。
    // 非签名端点沿用 URLSearchParams，行为不变。
    const queryString = options.signed
        ? encodeWbiQuery(finalParams as Record<string, string | number>)
        : new URLSearchParams(
            Object.entries(finalParams).filter(([, value]) => value !== undefined && value !== null && value !== '')
                .map(([key, value]) => [key, String(value)]),
        ).toString();
    const target = queryString ? `${url}?${queryString}` : url;
    const buvid = await ensureBuvid();
    const headers: Record<string, string> = {
        'User-Agent': UA,
        Referer: REFERER,
        Accept: 'application/json, text/plain, */*',
    };
    const cookie = cookieHeader(buvid);
    if (cookie) headers.Cookie = cookie;

    let response: Response;
    try {
        response = await biliFetch(target, { headers, credentials: 'include' });
    } catch (error) {
        throw new OnlineProviderError('network', `bilibili ${module}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
        throw new OnlineProviderError('service-unavailable', `bilibili ${module}: HTTP ${response.status}`);
    }
    let json: { code?: number; message?: string; data?: T };
    try {
        json = await response.json() as { code?: number; message?: string; data?: T };
    } catch {
        throw new OnlineProviderError('invalid-response', `bilibili ${module}: invalid JSON`);
    }
    if (typeof json.code !== 'number' || json.code !== 0) {
        // 未登录是业务事实，不当作网络错误：调用方据此决定提示登录。
        if (json.code === -101) {
            throw new OnlineProviderError('auth-required', `bilibili ${module}: ${json.message || '账号未登录'}`);
        }
        // B站的风控码不像 HTTP 429 那样带 Retry-After，但它们是「稍后再试」而不是永久失败：
        // -509 请求过快、-403 风控拦截、-352 风险验证。带上退避时长让上层走现有的
        // rate-limited 通道，而不是把所有错误都当成 service-unavailable（不重试）。
        const backoff = typeof json.code === 'number' && BILIBILI_RETRY_CODES.has(json.code) ? 3000 : undefined;
        throw new OnlineProviderError(
            backoff ? 'rate-limited' : 'service-unavailable',
            `bilibili ${module}: ${json.code} ${json.message || ''}`,
            undefined,
            undefined,
            undefined,
            backoff,
        );
    }
    return { data: json.data as T, code: json.code, message: json.message || 'OK' };
};

export const requestBilibili = async <T>(module: BilibiliModule, params: Record<string, string | number | undefined> = {}): Promise<BilibiliResult<T>> => {
    switch (module) {
        case 'qr-generate': return send<T>(API.qrGenerate, {}, module);
        case 'qr-poll': return send<T>(API.qrPoll, params, module);
        case 'login-status': return send<T>('https://api.bilibili.com/x/web-interface/nav', {}, module);
        case 'logout': return send<T>('https://api.bilibili.com/x/web-interface/nav', {}, module);
        case 'search': return send<T>(SEARCH_URL, { search_type: 'video', ...params }, module);
        case 'recommend': return send<T>(API.recommend, { fresh_type: 4, feed_version: 'V8', fresh_idx: 1, fresh_idx_1h: 1, fetch_row: 1, ps: 12, ...params }, module, { signed: true });
        case 'popular': return send<T>(API.popular, { ps: 20, pn: 1, ...params }, module);
        case 'ranking': return send<T>(API.ranking, { rid: 0, type: 'all', ...params }, module);
        case 'video-newlist': return send<T>(API['video-newlist'], { rid: 1, pn: 1, ps: 20, ...params }, module);
        case 'live-areas': return send<T>(API['live-areas'], {}, module);
        case 'live-rooms': return send<T>(API['live-rooms'], { parent_area_id: 1, area_id: 0, page: 1, page_size: 20, sort_type: 'online', ...params }, module);
        case 'live-playurl': return send<T>(API['live-playurl'], { qn: 80, platform: 'web', ...params }, module);
        case 'view': return send<T>(API.view, params, module);
        case 'playurl': return send<T>(API.playurl, { qn: 64, fnval: 16, fnver: 0, fourk: 1, ...params }, module);
        case 'fav-folders': return send<T>(API.favFolders, params, module);
        case 'fav-resources': return send<T>(API.favResources, { pn: 1, ps: 20, ...params }, module);
        case 'history': return send<T>(API.history, { max: 0, ps: 20, ...params }, module);
        default: throw new OnlineProviderError('unsupported', `bilibili module ${module}`);
    }
};

/** 取流地址带鉴权参数且会过期：provider 缓存必须按此时间失效。 */
export const bilibiliPlayUrlExpiry = (): number => Date.now() + 1000 * 60 * 90;
