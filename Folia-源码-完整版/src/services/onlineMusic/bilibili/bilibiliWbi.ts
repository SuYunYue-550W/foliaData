// src/services/onlineMusic/bilibili/bilibiliWbi.ts
// B站 WBI 签名：推荐端点（x/web-interface/wbi/index/top/feed/rcmd）从 2023 年起要求
// wts + w_rid 两个参数，缺了会被风控挡回 -403/-412。其余六个模块走非 wbi 端点，不用签。
//
// 算法自 2023 至今未变（2026-10 仍实测 code=0），流程：
//   nav → wbi_img → img_key/sub_key → 按固定表重排取前 32 位 = mixin_key
//   参数加 wts → 按 key 排序、过滤 !'()* → urlencode → md5(query + mixin_key) = w_rid
//
// key 每小时刷新一次即可（实测资料建议），不必每次请求都取 nav。
// dm_img_list / dm_img_inter 等伪设备指纹参数可选，不传也能正常返回。

import { OnlineProviderError } from '../../../types/onlineMusic';
import { md5 } from '../../../utils/md5';
import { createNativeFetch } from '../../nativeHttpFetch';

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';
const KEY_TTL_MS = 60 * 60 * 1000;

/** img_key + sub_key 的字符重排表（官方 64 位 mixin 表）。 */
const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
] as const;

type WbiKeys = { imgKey: string; subKey: string };

let cached: { keys: WbiKeys; at: number } | null = null;
let pending: Promise<WbiKeys> | null = null;

const biliFetch = createNativeFetch();

/** 从 URL 末段取文件名（去掉扩展名）就是 key。 */
const keyOf = (url: unknown): string => {
    if (typeof url !== 'string') return '';
    const name = url.split('/').pop() ?? '';
    return name.replace(/\.[^.]*$/, '');
};

const mixinKeyOf = ({ imgKey, subKey }: WbiKeys): string => {
    const raw = imgKey + subKey;
    let key = '';
    for (const index of MIXIN_KEY_ENC_TAB) key += raw[index] ?? '';
    return key.slice(0, 32);
};

const fetchWbiKeys = async (): Promise<WbiKeys> => {
    let response: Response;
    try {
        // nav 在浏览器里会带 cookie；有登录态时拿到的 key 与匿名时一致，这里不需要 SESSDATA。
        response = await biliFetch(NAV_URL, {
            headers: { 'User-Agent': UA, Referer: REFERER, Accept: 'application/json, text/plain, */*' },
            credentials: 'include',
        });
    } catch (error) {
        throw new OnlineProviderError('network', `bilibili wbi nav: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
        throw new OnlineProviderError('service-unavailable', `bilibili wbi nav: HTTP ${response.status}`);
    }
    let json: { data?: { wbi_img?: { img_url?: string; sub_url?: string } } };
    try {
        json = await response.json() as typeof json;
    } catch {
        throw new OnlineProviderError('invalid-response', 'bilibili wbi nav: invalid JSON');
    }
    const imgKey = keyOf(json.data?.wbi_img?.img_url);
    const subKey = keyOf(json.data?.wbi_img?.sub_url);
    if (!imgKey || !subKey) {
        throw new OnlineProviderError('invalid-response', 'bilibili wbi nav: no wbi keys');
    }
    return { imgKey, subKey };
};

/** 取 key：命中 1 小时缓存就直接返回；并发只取一次。 */
export const getWbiKeys = async (): Promise<WbiKeys> => {
    if (cached && Date.now() - cached.at < KEY_TTL_MS) return cached.keys;
    if (pending) return pending;
    pending = fetchWbiKeys().then(keys => {
        cached = { keys, at: Date.now() };
        return keys;
    }).finally(() => {
        pending = null;
    });
    return pending;
};

/** 仅用于测试：注入已知 key，避免单测打网络。 */
export const __setWbiKeysForTest = (keys: WbiKeys | null): void => {
    cached = keys ? { keys, at: Date.now() } : null;
    pending = null;
};

/**
 * 序列化参数：签名和实际请求必须用**同一个** query 字符串。
 *
 * 这里刻意不用 URLSearchParams —— 它把空格编成 '+' 且不过滤 !'()*，而 wbi 签名
 * 用的是 encodeURIComponent（空格 %20）。两者不一致时，只要参数里出现空格或
 * 特殊字符，服务端算出的 w_rid 就对不上。当前 recommend 参数都是简单值，
 * 但把序列化统一到一处，将来加参数就不会踩坑。
 */
export const encodeWbiQuery = (params: Record<string, string | number>): string => (
    Object.keys(params).sort().map(key => {
        const value = String(params[key]).replace(/[!'()*]/g, '');
        return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }).join('&')
);

/** 给参数加上 wts 与 w_rid。返回的是新对象，不改入参。 */
export const signWbi = async (
    params: Record<string, string | number | undefined>,
): Promise<Record<string, string | number>> => {
    const keys = await getWbiKeys();
    const signed: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') signed[key] = value;
    }
    signed.wts = Math.round(Date.now() / 1000);

    // 按 key 排序、过滤 !'()*、urlencode —— 顺序和编码必须和官方一致，
    // 否则 md5 出来的 w_rid 服务端不认。
    const query = encodeWbiQuery(signed);
    return { ...signed, w_rid: md5(query + mixinKeyOf(keys)) };

    // 注意：返回值里的原始 value 可能仍带 !'()*（比如搜索关键词），
    // 调用方必须用 encodeWbiQuery 序列化请求，而不是 URLSearchParams。
};
