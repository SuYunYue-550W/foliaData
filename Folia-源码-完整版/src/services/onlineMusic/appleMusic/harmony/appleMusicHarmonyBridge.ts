import { Capacitor, registerPlugin } from '@capacitor/core';
import { isCapacitorHarmony } from '../../../../platform/runtime';
import { appleMusicPageHandleRequest } from '../pageScript';
import type { AppleMusicOperation, AppleMusicParams, AppleMusicBridgeResult } from '../appleMusicTransport';

// src/services/onlineMusic/appleMusic/harmony/appleMusicHarmonyBridge.ts
// Apple Music 在鸿蒙 App 上的这一侧封口：桌面版把「大脑」放在主进程（electron/appleMusic/
// companionRequests.cjs）由 companion 子进程执行；鸿蒙没有主进程，页面运行时（pageScript.ts，
// 与桌面逐行对齐）整个注入进宿主 WebView 里的 music.apple.com，本文件把 omni 的请求按
// 桌面同一套校验规则送过去。原生侧（FoliaAppleMusicPlugin + AppleMusicHostActivity）只做
// 「导航/求值/显隐/清 cookie」这些哑活，不解释业务。
//
// 请求校验照搬桌面 validateRequest：鸿蒙桥不另立规则，两边永远一致（改一处必改另一处）。
// 「把页面挪到账号的 storefront 区域」那一手（桌面 nativeSpawn 的 accountStatus 后导航）鸿蒙
// v1 不做：页面的 MusicKit 由 alignStorefront 就地对齐，大陆 /cn 落点照样能放歌。

/** 桌面 companionRequests.cjs 的同一套合法操作表；两边必须同步改。 */
const OPERATIONS = new Set<AppleMusicOperation>(['songOriginal', 'catalogSong', 'catalogAlbum', 'catalogAlbumTracks', 'catalogArtist', 'catalogArtistSongs', 'catalogArtistAlbums', 'libraryAlbums', 'librarySongs', 'libraryAlbumTracks', 'stations', 'station', 'personalFm', 'showWindow', 'hideWindow', 'logout', 'accountStatus', 'search', 'playlists', 'playlistTracks', 'playlistTrackCount', 'lyrics', 'playbackStatus', 'likeSong', 'addPlaylistTracks', 'playStation', 'playSong', 'pause', 'resume', 'seek', 'setVolume', 'setRepeatOne', 'prepareNext']);
const REQUEST_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const RESOURCE_ID = /^[a-zA-Z0-9._-]{1,200}$/;

type NativePrepareResult = { ready?: unknown };
type NativeRequestResult = { ok?: unknown; data?: unknown; error?: unknown; httpStatus?: unknown; playbackStage?: unknown };

type FoliaAppleMusicNative = {
    prepare(options: { script: string }): Promise<NativePrepareResult>;
    request(options: { operation: string; params: AppleMusicParams }): Promise<NativeRequestResult>;
    setForeground(options: { active: boolean }): Promise<void>;
    logout(): Promise<void>;
    dispose(): Promise<void>;
};

const plugin = registerPlugin<FoliaAppleMusicNative>('FoliaAppleMusic');

const hasNativeHost = (): boolean => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'harmony';

// ── 请求校验（桌面 companionRequests.cjs validateRequest 的逐行移植）──

/** 桌面 companionRequests.cjs 的同一套校验，导出给测试钉住两边一致性。 */
export const validateHarmonyAppleMusicRequest = (operation: AppleMusicOperation, params: AppleMusicParams): AppleMusicParams | null => validated(operation, params);

const validated = (operation: AppleMusicOperation, params: AppleMusicParams): AppleMusicParams | null => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
    if (['showWindow', 'hideWindow', 'logout', 'accountStatus'].includes(operation)) return {};
    if (operation === 'stations') return { limit: 20, offset: 0 };
    if (operation === 'station' || operation === 'playStation') {
        if (typeof params.stationId !== 'string' || !/^ra\.[a-zA-Z0-9._-]{1,196}$/.test(params.stationId)) return null;
        return { stationId: params.stationId, limit: 1, offset: 0 };
    }
    if (operation === 'personalFm') return { limit: 2, offset: 0 };
    if (operation === 'playbackStatus' || ['pause', 'resume'].includes(operation)) return {};
    if (operation === 'seek') {
        if (typeof params.seconds !== 'number' || !Number.isFinite(params.seconds) || params.seconds < 0 || params.seconds > 604800) return null;
        return { seconds: params.seconds };
    }
    if (operation === 'setVolume') {
        if (typeof params.volume !== 'number' || !Number.isFinite(params.volume) || params.volume < 0 || params.volume > 1) return null;
        return { volume: params.volume };
    }
    if (operation === 'setRepeatOne') {
        if (typeof params.enabled !== 'boolean') return null;
        return { enabled: params.enabled };
    }
    if (operation === 'addPlaylistTracks') {
        if (typeof params.playlistId !== 'string' || !/^p\.[a-zA-Z0-9._-]{1,198}$/.test(params.playlistId)
            || !Array.isArray(params.catalogIds) || params.catalogIds.length < 1 || params.catalogIds.length > 100
            || params.catalogIds.some(id => typeof id !== 'string' || !/^\d{1,40}$/.test(id))) return null;
        return { playlistId: params.playlistId, catalogIds: [...new Set(params.catalogIds)] };
    }
    if (operation === 'likeSong') {
        if (typeof params.catalogId !== 'string' || !/^\d{1,40}$/.test(params.catalogId) || typeof params.liked !== 'boolean') return null;
        return { catalogId: params.catalogId, liked: params.liked };
    }
    if (operation === 'prepareNext') {
        if (typeof params.catalogId !== 'string' || !/^\d{1,40}$/.test(params.catalogId)
            || !Array.isArray(params.nextIds) || params.nextIds.length > 2
            || params.nextIds.some(id => typeof id !== 'string' || !/^\d{1,40}$/.test(id))
            || new Set([params.catalogId, ...params.nextIds]).size !== params.nextIds.length + 1) return null;
        return { catalogId: params.catalogId, nextIds: params.nextIds.slice() };
    }
    if (operation === 'playSong') {
        const { catalogId, startSec = 0, requestKey, adoptCurrent = false } = params;
        if (typeof catalogId !== 'string' || !/^\d{1,40}$/.test(catalogId)) return null;
        if (typeof startSec !== 'number' || !Number.isFinite(startSec) || startSec < 0 || startSec > 604800) return null;
        if (requestKey !== undefined && (typeof requestKey !== 'string' || !REQUEST_ID.test(requestKey))) return null;
        if (typeof adoptCurrent !== 'boolean') return null;
        return { catalogId, startSec,
            ...(requestKey !== undefined ? { requestKey } : {}), ...(adoptCurrent ? { adoptCurrent } : {}) };
    }
    if (operation === 'lyrics') {
        if (typeof params.songId !== 'string' || !RESOURCE_ID.test(params.songId)) return null;
        return { songId: params.songId };
    }
    const offset = typeof params.offset === 'number' && Number.isSafeInteger(params.offset) ? params.offset : 0;
    const limit = typeof params.limit === 'number' && Number.isSafeInteger(params.limit) ? params.limit : 25;
    if (offset < 0 || offset > 100000 || limit < 1 || limit > 100) return null;
    if (operation === 'search') {
        if (typeof params.query !== 'string' || !params.query.trim() || params.query.length > 200) return null;
        return { query: params.query.trim(), offset, limit };
    }
    if (['songOriginal', 'catalogSong', 'catalogAlbum', 'catalogAlbumTracks', 'catalogArtist', 'catalogArtistSongs', 'catalogArtistAlbums'].includes(operation)) {
        if (typeof params.catalogId !== 'string' || !/^\d{1,40}$/.test(params.catalogId)) return null;
        return { catalogId: params.catalogId, offset, limit };
    }
    if (operation === 'libraryAlbumTracks') {
        if (typeof params.albumId !== 'string' || !/^l\.[a-zA-Z0-9._-]{1,198}$/.test(params.albumId)) return null;
        return { albumId: params.albumId, offset, limit };
    }
    if (operation === 'playlistTracks' || operation === 'playlistTrackCount') {
        if (typeof params.playlistId !== 'string' || !RESOURCE_ID.test(params.playlistId)) return null;
        return { playlistId: params.playlistId, offset, limit };
    }
    return { offset, limit };
};

// ── 宿主生命周期 ──

// 只准备一次：把页面运行时交给原生侧，并等它把 music.apple.com 装好。登出会重载页面，
// 原生侧在每次 onPageFinished 重新注入同一份 script，这里的准备不必重来。
let prepared: Promise<void> | null = null;
const prepareHost = (): Promise<void> => {
    if (prepared) return prepared;
    const task = (async () => {
        // 页面运行时整个交给原生侧注入；函数源码自包含（pageScript.ts 的硬性约束），
        // 构建压缩改名不影响它的自包含性。
        await plugin.prepare({ script: appleMusicPageHandleRequest.toString() });
    })();
    prepared = task;
    // 准备失败（超时/宿主起不来）允许下一次请求再试一次。
    task.catch(() => { if (prepared === task) prepared = null; });
    return task;
};

const foldNativeResult = (answer: NativeRequestResult): AppleMusicBridgeResult => {
    if (answer?.ok === true) return { ok: true, data: answer.data };
    const error = typeof answer?.error === 'string' && answer.error ? answer.error.slice(0, 64) : 'request-failed';
    const httpStatus = Number.isSafeInteger(answer?.httpStatus) ? answer.httpStatus as number : null;
    const playbackStage = typeof answer?.playbackStage === 'string' ? answer.playbackStage.slice(0, 32) : undefined;
    return { ok: false, error, ...(httpStatus !== null ? { httpStatus } : {}), ...(playbackStage ? { playbackStage } : {}) };
};

// 桌面 companionClient 对 not-ready/busy 内部重试到 25 秒；这里同样：页面刚重载或
// storeffront 对齐触发导航时，一次请求会撞上 not-ready，等等再问就是了。
const RETRYABLE = new Set(['not-ready', 'busy']);
const RETRY_TOTAL_MS = 25000;
const RETRY_DELAY_MS = 500;

const sendToNative = async (operation: AppleMusicOperation, params: AppleMusicParams): Promise<AppleMusicBridgeResult> => {
    await prepareHost();
    const deadline = Date.now() + RETRY_TOTAL_MS;
    for (;;) {
        // 原生侧以 reject('not-ready'/'timeout'/'busy'/'invalid-response') 说明宿主层的问题；
        // 页面业务结果永远是 resolve 的 {ok,...}。
        let answer: NativeRequestResult;
        try {
            answer = await plugin.request({ operation, params });
        } catch (error) {
            const native = String((error as { message?: string })?.message ?? '');
            if (RETRYABLE.has(native) && Date.now() < deadline) {
                await new Promise(done => setTimeout(done, RETRY_DELAY_MS));
                continue;
            }
            return { ok: false, error: RETRYABLE.has(native) ? 'timeout' : native || 'request-failed' };
        }
        return foldNativeResult(answer);
    }
};

// 前台保持：Apple 的音频在宿主 WebView 里出声，App 退后台时靠一张前台通知把进程留住。
// 开始类命令点亮，pause 熄掉；熄掉只停通知，不停 WebView。
const HOLDS_FOREGROUND = new Set<AppleMusicOperation>(['playSong', 'playStation', 'resume']);
let foregroundHeld = false;
const holdForeground = async (active: boolean): Promise<void> => {
    if (foregroundHeld === active) return;
    foregroundHeld = active;
    try { await plugin.setForeground({ active }); } catch { /* 前台保持失败不出声地算了：播放仍在。 */ }
};

/**
 * omni 的 Apple Music 请求在鸿蒙上的入口。返回形状与桌面 requestAppleMusic 一致。
 * 离开鸿蒙（或插件不在）时抛 unavailable，与桌面没有桥时的行为对齐。
 */
export const requestAppleMusicOnHarmony = async (operation: AppleMusicOperation, params: AppleMusicParams = {}): Promise<AppleMusicBridgeResult> => {
    if (!hasNativeHost()) return { ok: false, error: 'runtime-unavailable' };
    if (!OPERATIONS.has(operation)) return { ok: false, error: 'invalid-request' };
    if (operation === 'logout') {
        await holdForeground(false);
        try { await plugin.logout(); return { ok: true, data: {} }; } catch { return { ok: false, error: 'request-failed' }; }
    }
    const checked = validated(operation, params);
    if (!checked) return { ok: false, error: 'invalid-request' };
    const result = await sendToNative(operation, checked);
    if (HOLDS_FOREGROUND.has(operation)) await holdForeground(result.ok);
    if (operation === 'pause' && result.ok) await holdForeground(false);
    return result;
};

/** 供 availability 与测试探听：鸿蒙宿主这条路在不在。 */
export const hasAppleMusicHarmonyHost = isCapacitorHarmony;

/** 丢弃宿主（切换平台或退出外部播放路线时用）：停前台保持并关掉原生 WebView。 */
export const disposeAppleMusicHarmonyHost = async (): Promise<void> => {
    if (!hasNativeHost()) return;
    await holdForeground(false);
    try { await plugin.dispose(); } catch { /* 已经没了就算了。 */ }
    prepared = null;
};
