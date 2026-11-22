import type {
    LoginState, ProviderAudioSource, ProviderCapabilities, ProviderUser,
    AudioQualityPreference,
} from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import type { SongResult, UnifiedSong } from '../../../types';
import {
    bilibiliPlayUrlExpiry, hasBilibiliLogin, readBilibiliSessdata,
    requestBilibili, writeBilibiliSessdata,
} from './bilibiliTransport';
import {
    isBilibiliLiveSong, normalizeBilibiliLive, normalizeBilibiliSong,
} from './bilibiliNormalize';
import { getBilibiliModule } from './bilibiliModules';
import { isCapacitorAndroid } from '../../../platform/runtime';
import { proxyNativeRemoteAudioUrl } from '../../nativeRemoteAudio';
import QRCode from 'qrcode';
import { clearCookies, isNativeCookieClearAvailable } from '../../../platform/foliaNative';

// src/services/onlineMusic/bilibili/bilibiliProvider.ts
//
// B站的"音乐"是视频音轨，没有真正的曲库：搜索/推荐/热门/分区拿到的是视频，
// 播放地址是 DASH 流（视频/音频分离）。能力开关只开真实实现了的：
// - search / playback / auth / recommendations 开。
// - lyrics / albums / artists / playlists / mutations / wordByWordLyrics 关，
//   因为 B站字幕不是歌词、UP 主不是艺人、合集不是音乐专辑；关掉界面会如实显示不支持。
// 七个模块（推荐/热门/动画/影视/直播/收藏/历史）通过 explore 暴露，走 omni 的 explore 契约。

const BILIBILI_MARK = { letter: 'B', color: '#fb7299' } as const;

const capabilities: ProviderCapabilities = {
    search: true,
    playback: true,
    lyrics: false,
    auth: true,
    userLibrary: true,
    playlists: false,
    albums: false,
    artists: false,
    recommendations: true,
    mutations: false,
    wordByWordLyrics: false,
    userAlbums: false,
    likes: false,
    playlistTrackMutations: false,
};

const navUser = async (): Promise<ProviderUser | null> => {
    try {
        const { data } = await requestBilibili<any>('login-status');
        const nav = data && typeof data === 'object' ? data : {};
        if (!nav.isLogin || !nav.mid) return null;
        return {
            id: String(nav.mid),
            nickname: String(nav.uname || ''),
            avatarUrl: String(nav.face || ''),
        };
    } catch (error) {
        if (error instanceof OnlineProviderError && error.code === 'auth-required') return null;
        throw error;
    }
};

/** 扫码状态机：与 QQ 一致（waiting / scanned / confirmed / expired / error）。 */
const qrStates = new Map<string, string>();

const checkLogin = async (key: string): Promise<LoginState> => {
    try {
        const { data } = await requestBilibili<any>('qr-poll', { qrcode_key: key });
        const code = Number(data?.code);
        if (code === 0) {
            const url = String(data?.url || '');
            // poll 成功时 Set-Cookie 里带 SESSDATA；浏览器环境由浏览器保存，Node 侧由 electron 桥接保存。
            const sess = String(data?.sessdata || '') || readBilibiliSessdata() || '';
            if (!sess && typeof document !== 'undefined') {
                const found = /(?:^|;\s*)SESSDATA=([^;]+)/.exec(document.cookie);
                if (found) writeBilibiliSessdata(found[1]);
            }
            if (url || sess) return { state: 'confirmed' };
            return { state: 'waiting' };
        }
        if (code === 86090) return { state: 'scanned' };
        if (code === 86101) return { state: 'waiting' };
        if (code === 86038) return { state: 'expired' };
        return { state: 'error', message: String(data?.message || `code ${code}`) };
    } catch (error) {
        return { state: 'error', message: error instanceof Error ? error.message : String(error) };
    }
};

/**
 * 画面流：B站 DASH 的 video[]，id 越大分辨率越高（80=1080P，120=4K，125=HDR…）。
 * 取当前匿名/登录态拿到的最高一档即可；拿不到就回 null（画面退回 iframe）。
 */
const videoStreamOf = (dash: any): any => {
    const list = Array.isArray(dash?.video) ? dash.video : [];
    if (list.length === 0) return null;
    const sorted = [...list].sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0));
    // 只要普通 MP4 档（codecid 7 = AVC，1 = HEVC）：WebView 对 HEVC 的支持不齐，AVC 最稳。
    const avc = sorted.find(item => Number(item?.codecid || 0) === 7);
    return avc || sorted.find(item => Number(item?.codecid || 0) !== 1) || sorted[0];
};

const audioQualityOf = (dash: any, wanted: AudioQualityPreference): any => {
    const list = Array.isArray(dash?.audio) ? dash.audio : [];
    if (list.length === 0) return null;
    // B站音频 id 越大码率越高：30280(192k) > 30232(132k) > 30216(64k)。
    const sorted = [...list].sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0));
    if (wanted === 'standard') return sorted[sorted.length - 1];
    if (wanted === 'high') return sorted[Math.max(0, sorted.length - 2)];
    return sorted[0]; // lossless / hires 取最高可用，并如实标记实际质量
};

export const bilibiliProvider: any = {
    id: 'bilibili',
    displayName: '哔哩哔哩',
    shortName: 'B站',
    mark: BILIBILI_MARK,
    capabilities,
    normalizeSong: normalizeBilibiliSong,
    getAvailability: () => ({ configured: true, reason: null }),

    search: {
        async searchSongs(query: string, limit: number, offset: number): Promise<any> {
            if (!query.trim()) return { items: [], hasMore: false, nextOffset: offset };
            const page = Math.floor(offset / limit) + 1;
            const { data } = await requestBilibili<any>('search', { keyword: query, page, page_size: limit });
            const list = Array.isArray(data?.result) ? data.result : [];
            const items = list.filter((item: any) => item?.bvid).map(normalizeBilibiliSong);
            return { items, hasMore: list.length >= limit, nextOffset: offset + items.length };
        },
    },

    playback: {
        async getSongDetail(id: string): Promise<UnifiedSong | null> {
            if (String(id).startsWith('room:')) {
                const roomId = Number(String(id).slice(5));
                if (!Number.isFinite(roomId)) return null;
                const { data } = await requestBilibili<any>('live-rooms', { page: 1, page_size: 1, roomid: roomId });
                const room = (Array.isArray(data?.list) ? data.list : [])[0];
                return room ? normalizeBilibiliLive(room) : null;
            }
            const { data } = await requestBilibili<any>('view', { bvid: id });
            return data?.bvid ? normalizeBilibiliSong(data) : null;
        },
        async getAudioSource(song: SongResult, quality: AudioQualityPreference): Promise<ProviderAudioSource | null> {
            const ref = song.sourceRef;
            if (!ref || ref.kind !== 'online' || ref.providerId !== 'bilibili') return null;
            const mediaId = ref.mediaId;
            let url: string;
            let videoUrl: string | null = null;
            let isLive = false;
            if (String(mediaId).startsWith('room:')) {
                const roomId = String(mediaId).slice(5);
                const { data } = await requestBilibili<any>('live-playurl', { cid: roomId });
                const first = Array.isArray(data?.durl) ? data.durl[0] : null;
                if (!first?.url) return null;
                url = String(first.url);
                isLive = true;
            } else {
                /*
                 * cid 不是 bvid：搜索接口（x/web-interface/search/type）只给 bvid，不给 cid，
                 * 所以从搜索结果直接点播放的那首歌，providerData 里没有 cid。早先这里
                 * Number(undefined) 得到 NaN 就静默 return null，playurl 请求根本没发出去，
                 * 上层看到「没抛错但也没 url」就报「B站未返回音频」—— 三端一致，全都放不了。
                 *
                 * view 接口按 bvid 能拿到 cid（getSongDetail 上面就是这么做的），补一次即可。
                 */
                let cid = Number(ref.providerData?.cid);
                if (!Number.isFinite(cid) || cid <= 0) {
                    const { data: detail } = await requestBilibili<any>('view', { bvid: mediaId });
                    cid = Number(detail?.cid);
                    if (!Number.isFinite(cid) || cid <= 0) return null;
                    // 回写，避免这首歌下次播放（或预取）再查一次 view。
                    if (ref.providerData) ref.providerData.cid = cid;
                }
                const { data } = await requestBilibili<any>('playurl', { bvid: mediaId, cid });
                const audio = audioQualityOf(data?.dash, quality);
                // B站常同时给 baseUrl 与 backupUrl；baseUrl 缺失时备用地址一样能播。
                const audioUrl = audio?.baseUrl || (Array.isArray(audio?.backupUrl) ? audio.backupUrl[0] : null);
                if (!audioUrl) return null;
                url = String(audioUrl);
                // 画面是另一条流：同一个 DASH 回答里的 video[]。
                const video = videoStreamOf(data?.dash);
                videoUrl = video?.baseUrl
                    ? String(video.baseUrl)
                    : (Array.isArray(video?.backupUrl) ? String(video.backupUrl[0]) : null);
            }
            // Electron 里把流地址登记到主进程策略：它会给这个域名的请求注入 Referer/CORS。
            // Web 侧浏览器自己带 Referer，不需要额外处理。
            if (typeof window !== 'undefined' && typeof (window as any).electron?.bilibiliRegisterMedia === 'function') {
                void (window as any).electron.bilibiliRegisterMedia(url);
                if (videoUrl) void (window as any).electron.bilibiliRegisterMedia(videoUrl);
            }
            // Android WebView 不能给 <video>/<audio> 自定义 Referer：走原生回环代理，
            // OkHttp 带 Referer 拉流，再把 127.0.0.1 的地址交给 WebView（支持 Range）。
            if (isCapacitorAndroid()) {
                const headers = { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
                url = await proxyNativeRemoteAudioUrl(url, { headers, allowAnyHost: true });
                if (videoUrl) videoUrl = await proxyNativeRemoteAudioUrl(videoUrl, { headers, allowAnyHost: true });
            }
            return {
                url,
                ...(videoUrl ? { videoUrl } : {}),
                fetchedAt: Date.now(),
                quality: isLive ? 'standard' : quality,
                expiresAt: bilibiliPlayUrlExpiry(),
                sourceTier: isLive ? 'live' : 'dash-audio',
            } as ProviderAudioSource;
        },
    },

    auth: {
        async getLoginStatus(): Promise<ProviderUser | null> { return navUser(); },
        async logout(): Promise<void> {
            writeBilibiliSessdata('');
            qrStates.clear();
            // 扫码登录把会话存进了原生 CookieManager，只清 localStorage 的话那份登录态还在，
            // 下次启动 nav 请求又带着它 —— 表现为「登出后重启又自动登录回去了」。
            // 只清 B 站这个域，别家平台的会话不动。
            try {
                if (isNativeCookieClearAvailable()) {
                    await clearCookies({ domain: 'bilibili.com' });
                }
            } catch {
                // 原生桥不可用（桌面 / 纯网页）时没有 CookieManager 这一层，清本地那份就够了。
            }
        },
        async startLogin(): Promise<string> {
            const { data } = await requestBilibili<any>('qr-generate');
            const key = String(data?.qrcode_key || '');
            if (!key) throw new OnlineProviderError('invalid-response', 'bilibili qr has no key', 'bilibili');
            qrStates.set(key, 'waiting');
            return key;
        },
        async createQr(key: string): Promise<string> {
            // B站的扫码地址本身是**网页**（account.bilibili.com/.../scan-web），不是图片。
            // 早先这里直接把那个 https URL 交回去，LoginTile 拿它当 <img src> 渲染，于是显示成破图。
            // 现在本地生成二维码（项目已依赖 qrcode），交回 data URL —— 与项目里其它扫码
            // 登录平台交回真图片的做法一致，也省掉一次第三方二维码服务。
            const scanUrl = `https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=${encodeURIComponent(key)}`;
            return QRCode.toDataURL(scanUrl, {
                errorCorrectionLevel: 'M',
                margin: 2,
                width: 352,
                color: {
                    dark: '#000000',
                    light: '#ffffff',
                },
            });
        },
        checkLogin,
        async cancelLogin(key: string): Promise<void> { qrStates.delete(key); },
        getLoginTexts: () => ({ title: 'home.loginTitleBilibili', note: 'home.loginNoteBilibili' }),
        getLoginMethods: () => [{ id: 'bilibili', labelKey: 'home.bilibiliLoginMethodScan', iconKey: 'bilibili' }],
        getLoginTtlMs: () => 180_000,
        showsKeptAccountAtStart: true,
    },

    // 七个模块通过 explore 暴露：sections 为七个入口，sectionItems 为对应内容。
    explore: {
        async getFeed(): Promise<any> {
            return {
                sections: [
                    { id: 'recommend', titleKey: 'home.biliModuleRecommend', kind: 'songs' },
                    { id: 'popular', titleKey: 'home.biliModulePopular', kind: 'songs' },
                    { id: 'anime', titleKey: 'home.biliModuleAnime', kind: 'songs' },
                    { id: 'film', titleKey: 'home.biliModuleFilm', kind: 'songs' },
                    { id: 'live', titleKey: 'home.biliModuleLive', kind: 'songs' },
                    { id: 'favorites', titleKey: 'home.biliModuleFavorites', kind: 'songs' },
                    { id: 'history', titleKey: 'home.biliModuleHistory', kind: 'songs' },
                ],
                refreshReadsAnew: true,
            };
        },
        async getSectionItems(cursor: string): Promise<any> {
            const id = cursor as any;
            const page = await getBilibiliModule(id, {});
            return { items: page.items, hasMore: page.hasMore, nextCursor: cursor };
        },
    },

    describeFailure: (operation: string, error: unknown) => {
        if (error instanceof OnlineProviderError) {
            return { code: error.code, message: error.message } as any;
        }
        return null;
    },
};

export const bilibiliIsLive = isBilibiliLiveSong;
export const bilibiliHasLogin = hasBilibiliLogin;
