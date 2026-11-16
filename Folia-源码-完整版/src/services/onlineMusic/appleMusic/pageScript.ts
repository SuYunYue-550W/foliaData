/* eslint-disable @typescript-eslint/no-explicit-any */
// src/services/onlineMusic/appleMusic/pageScript.ts
// Apple Music 页面运行时：跑在 music.apple.com 页面里的那一段「大脑」。桌面版（Windows/macOS）
// 把同样的逻辑放在 electron/appleMusic/*.cjs 里、由主进程逐条序列化注入（companionRequests.cjs
// 的 requestExpression）；安卓没有主进程，改为整段函数注入一次。两边的函数体保持逐行对齐，
// 改这里时必须同步改 electron/appleMusic/companionRequests.cjs 及其伴生模块。
//
// 硬性约束：这个函数体【必须自包含】—— 只允许引用页面里本来就有的全局（window、JSON、URL、
// crypto、TextEncoder、Promise、setTimeout、console、Map），不允许 import、不允许闭包到模块作用域。
// 安卓侧靠 handleRequest.toString() 把它带进页面（构建产物会做压缩改名，但自包含性不受影响）。
// 类型上全部按 any 处理：页面里的 MusicKit 是 Apple 自己的未公开产物，这里只读它稳定的形状。

export type AppleMusicPageRequest = {
    operation: string;
    params: Record<string, string | number | boolean | string[] | undefined>;
};

export type AppleMusicPageResult =
    | { ok: true; data: unknown }
    | { ok: false; error: string; httpStatus?: number | null; playbackStage?: string };

export function appleMusicPageHandleRequest(request: AppleMusicPageRequest): Promise<AppleMusicPageResult> {
    // window 在页面里是全局；这里按 any 访问它的 __folia* 状态与 MusicKit（TS 不认识它们）。
    const page = window as any;
    // ── 序列化进页面的辅助函数（与 electron/appleMusic/ 下同名 .cjs 逐行对齐）──

    // companionQueue.cjs：不动正在响的那一首，只准备有界的尾巴。
    const controlQueue = async (mk: any, operation: string, params: any): Promise<any> => {
        const idOf = (item: any) => item?.attributes?.playParams?.catalogId || item?.id || '';
        const currentId = idOf(mk.nowPlayingItem);
        const items = Array.isArray(mk.queue?.items) ? mk.queue.items : [];
        const position = Number.isInteger(mk.queue?.position) ? mk.queue.position : items.findIndex((item: any) => idOf(item) === currentId);
        if (operation === 'prepareNext') {
            if (currentId !== params.catalogId) return { ok: false, error: currentId ? 'stale-request' : 'not-ready' };
            if (typeof mk.queue?.clearAfterCurrent !== 'function' || typeof mk.playLater !== 'function') return { ok: false, error: 'unsupported' };
            const tail = items.slice(position + 1).map((item: any) => idOf(item));
            if (JSON.stringify(tail) !== JSON.stringify(params.nextIds)) {
                const extendsTail = tail.length <= params.nextIds.length && tail.every((id: string, index: number) => id === params.nextIds[index]);
                const appendIds = extendsTail ? params.nextIds.slice(tail.length) : params.nextIds;
                if (!extendsTail) await mk.queue.clearAfterCurrent();
                if (appendIds.length) await mk.playLater({ songs: appendIds });
            }
            if (idOf(mk.nowPlayingItem) !== params.catalogId) return { ok: false, error: 'stale-request' };
            page.__foliaPreparedQueue = [params.catalogId, ...params.nextIds];
            return { ok: true, data: {} };
        }
        const plan = page.__foliaPreparedQueue;
        const repeated = params.requestKey && page.__foliaLastPlay?.requestKey === params.requestKey
            && page.__foliaLastPlay.catalogId === params.catalogId;
        if (currentId === params.catalogId && params.startSec === 0 && (repeated || params.adoptCurrent === true)) {
            page.__foliaLastPlay = { requestKey: params.requestKey, catalogId: params.catalogId };
            return { ok: true, data: { reusedQueue: true, isPlaying: mk.isPlaying === true } };
        }
        // 只有「队列里的下一首」可以复用播放；把当前这首再点一次仍然是重放。
        if (params.startSec === 0 && Array.isArray(plan) && plan[0] !== params.catalogId && plan.includes(params.catalogId)) {
            const index = items.findIndex((item: any, at: number) => at >= position && idOf(item) === params.catalogId);
            if (index < 0) return null;
            if (currentId !== params.catalogId) {
                if (typeof mk.changeToMediaAtIndex !== 'function') return null;
                try {
                    await mk.changeToMediaAtIndex(index);
                } catch {
                    // 被拒的优化切换不许挡住普通的 setQueue/play 路线。
                    if (idOf(mk.nowPlayingItem) !== params.catalogId || mk.isPlaying !== true) {
                        page.__foliaPreparedQueue = [params.catalogId];
                        console.warn('[AppleMusic] Prepared switch rejected; loading the song normally');
                        return null;
                    }
                    // 有的运行时先切过去才抛错；已经在响的音频不许重启。
                }
            }
            // changeToMediaAtIndex 自己就会开始播放；再 play() 一次会重开它的装载管线。
            // 已经是当前这首的可能被用的人暂停了，收养它要保住暂停。
            page.__foliaPreparedQueue = plan.slice(plan.indexOf(params.catalogId));
            page.__foliaLastPlay = { requestKey: params.requestKey, catalogId: params.catalogId };
            return { ok: true, data: { reusedQueue: true, isPlaying: mk.isPlaying === true } };
        }
        page.__foliaPreparedQueue = [params.catalogId];
        return null;
    };

    // companionFavorites.cjs：只发收藏请求，绝不发删除库内歌曲的请求。
    const updateFavorite = async (call: any, params: any): Promise<any> => {
        try {
            const result = await call('v1/me/favorites', { 'ids[songs]': params.catalogId }, {
                fetchOptions: { method: params.liked ? 'POST' : 'DELETE' },
            });
            const status = Number(result?.status);
            if (!Number.isInteger(status) || status < 200 || status >= 300 || result?.data?.errors?.length || result?.errors?.length) {
                return { ok: false, error: status === 401 ? 'auth-required' : 'upstream-error', httpStatus: Number.isInteger(status) ? status : null };
            }
            return { ok: true, data: {} };
        } catch {
            return { ok: false, error: 'request-failed' };
        }
    };

    // companionPlaylist.cjs：先复查编辑权，再把目录歌曲一次性追加进去。
    const addPlaylistTracks = async (call: any, params: any): Promise<any> => {
        const failure = (result: any) => {
            const status = Number(result?.status);
            return { ok: false, error: status === 401 ? 'auth-required' : 'upstream-error', httpStatus: Number.isInteger(status) ? status : null };
        };
        const succeeded = (result: any) => Number.isInteger(result?.status) && result.status >= 200 && result.status < 300
            && !result?.data?.errors?.length && !result?.errors?.length;
        try {
            const path = 'v1/me/library/playlists/' + encodeURIComponent(params.playlistId);
            const detail = await call(path, { extend: 'tags' });
            if (!succeeded(detail)) return failure(detail);
            const playlist = detail?.data?.data?.find((item: any) => item.id === params.playlistId && item.type === 'library-playlists');
            if (!playlist) return { ok: false, error: 'invalid-response' };
            if (playlist.attributes?.canEdit !== true || playlist.attributes?.tags?.includes('favorited')) {
                return { ok: false, error: 'unsupported' };
            }
            const result = await call(path + '/tracks', { representation: 'resources' }, {
                fetchOptions: { method: 'POST', body: JSON.stringify({ data: params.catalogIds.map((id: string) => ({ id, type: 'songs' })) }) },
            });
            if (!succeeded(result)) return failure(result);
            return { ok: true, data: {} };
        } catch {
            // 追加绝不自动重试：服务器可能已经收下了。
            return { ok: false, error: 'request-failed' };
        }
    };

    // companionRadio.cjs：问私人电台要一小批，不动播放。
    const readPersonalStation = async (call: any, store: string): Promise<any> => {
        const stations = await call('v1/catalog/' + encodeURIComponent(store) + '/stations', { 'filter[identity]': 'personal', limit: 1 });
        if (Number(stations?.status) >= 400 || stations?.data?.errors?.length) return stations;
        const rows = stations?.data?.data;
        if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.type !== 'stations'
            || typeof rows[0]?.id !== 'string' || !/^ra\.[a-zA-Z0-9._-]{1,196}$/.test(rows[0].id)) {
            return { status: 502, data: { errors: [{}] } };
        }
        // 同一个固定 POST 端点就是 Apple MusicKit 的 loadStationNextTracks 用的那个。
        return call('v1/me/stations/next-tracks/' + encodeURIComponent(rows[0].id), { limit: 2 }, { fetchOptions: { method: 'POST' } });
    };

    // companionStorefront.cjs 的 alignStorefront：大陆地址上 Apple 把 /cn 之外的页面都重定向回 /cn，
    // 页面不一定挪得动。就地把 MusicKit 指到账号的 storefront，并在有订阅时解除网页为另一个区域
    // 选的「仅试听」模式。
    const alignStorefront = async (mk: any): Promise<void> => {
        const read = page.__foliaStorefront?.data?.data?.[0]?.id;
        const account = typeof read === 'string' ? read : mk?.storefrontCountryCode;
        if (mk?.isAuthorized !== true || typeof account !== 'string' || !/^[a-z]{2}$/.test(account)) return;
        if (mk.storefrontId !== account) {
            mk.storefrontId = account;
            page.__foliaStorefrontAligned = true;
        }
        if (page.__foliaStorefrontAligned !== true) return;
        const modes = page.MusicKit?.PlaybackMode;
        if (!modes || mk.playbackMode !== modes.PREVIEW_ONLY || typeof mk.hasMusicSubscription !== 'function') return;
        if (typeof page.__foliaSubscribed !== 'boolean') {
            page.__foliaSubscription ||= Promise.resolve().then(() => mk.hasMusicSubscription()).then((answer: unknown) => {
                if (typeof answer === 'boolean') page.__foliaSubscribed = answer;
            }, () => {}).finally(() => { page.__foliaSubscription = null; });
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([page.__foliaSubscription, new Promise<void>(done => { timer = setTimeout(done, 3000); })]);
            clearTimeout(timer);
        }
        if (page.__foliaSubscribed === true) mk.playbackMode = modes.MIXED_CONTENT;
    };

    // ── readFromPage 本体（companionRequests.cjs，逐行对齐）──

    return (async (): Promise<any> => {
        try {
            const mk = page.MusicKit?.getInstance();
            const modern = mk?.api?.v3;
            const legacy = mk?.api;
            // 网页壳要扁平的 RequestInit，SDK v3 要 { fetchOptions }。这里统一掉，
            // 免得写操作静默变成 GET。
            const call = typeof modern?.music === 'function' ? modern.music.bind(modern)
                : typeof legacy?.music === 'function' ? (path: string, query: any, options: any) => options
                    ? legacy.music(path, query, options.fetchOptions) : legacy.music(path, query)
                    : null;
            if (!call) return { ok: false, error: 'not-ready' };
            // 开始与准备的队列都在账号的区域里放，不管页面自己在哪个区域。
            if (['playSong', 'playStation', 'prepareNext'].includes(request.operation)) {
                try { await alignStorefront(mk); } catch { /* 开始照旧在页面自己的区域里放。 */ }
            }
            if (request.operation === 'addPlaylistTracks') return await addPlaylistTracks(call, request.params);
            if (request.operation === 'likeSong') return await updateFavorite(call, request.params);
            if (request.operation === 'prepareNext') return await controlQueue(mk, request.operation, request.params);
            if (request.operation === 'playbackStatus') {
                const pendingStart = page.__foliaStart;
                // 播放器的 play/seek 的 promise 还没落定，声音可能已经在响。
                if (pendingStart?.pending && mk.isPlaying === true) pendingStart.pending = false;
                // 挂死的媒体 promise 不许永远占着去重那一条路。
                if (pendingStart?.pending && !pendingStart.cancelled && Date.now() - pendingStart.startedAt >= 60000) {
                    pendingStart.pending = false;
                    pendingStart.cancelled = true;
                    pendingStart.failed = true;
                }
                if (page.__foliaStart?.failed) return { ok: false, error: 'playback-failed', playbackStage: 'play' };
                const item = mk.nowPlayingItem;
                const params = item?.attributes?.playParams || {};
                const liveStation = typeof page.__foliaLiveStation === 'string' ? page.__foliaLiveStation : '';
                const position = liveStation ? 0 : Number(mk.currentPlaybackTime);
                const duration = Number(item?.attributes?.durationInMillis);
                const state = Number(mk.playbackState);
                // 设了队列但还没开始的没有 now-playing；用长度区分这两种。
                const queue = mk.queue;
                const queueLength = Number.isInteger(queue?.length)
                    ? queue.length
                    : Array.isArray(queue?.items) ? queue.items.length : null;
                return { ok: true, data: {
                    itemId: liveStation || (typeof item?.id === 'string' ? item.id : ''),
                    ...(liveStation ? { live: true } : {}),
                    catalogId: liveStation || (typeof params.catalogId === 'string' ? params.catalogId : ''),
                    isPlaying: mk.isPlaying === true,
                    ...(page.__foliaStart?.pending && !page.__foliaStart.cancelled ? { starting: true } : {}),
                    state: Number.isInteger(state) ? state : null,
                    repeatMode: Number.isInteger(mk.repeatMode) ? mk.repeatMode : null,
                    queueLength,
                    queueKeys: queue ? Object.keys(queue).slice(0, 12) : null,
                    positionMs: Number.isFinite(position) && position >= 0 ? Math.round(position * 1000) : 0,
                    durationMs: !liveStation && Number.isFinite(duration) && duration >= 0 ? duration : 0,
                } };
            }
            if (request.operation === 'playStation') {
                page.__foliaStart = null;
                if (typeof mk.setQueue !== 'function' || typeof mk.play !== 'function') return { ok: false, error: 'unsupported' };
                try {
                    // 节目元数据的变化不换队列；页面上显式选队列才会换。
                    if (mk.setQueue !== page.__foliaStationQueueHook) {
                        const originalSetQueue = mk.setQueue;
                        const clearStationOnQueueChange = function (this: any, ...args: unknown[]) {
                            page.__foliaLiveStation = '';
                            return originalSetQueue.apply(this, args as []);
                        };
                        mk.setQueue = clearStationOnQueueChange;
                        page.__foliaStationQueueHook = clearStationOnQueueChange;
                    }
                    // 直播电台永远不单曲循环，不管上一首是什么。
                    if (typeof mk.setRepeatMode === 'function') mk.setRepeatMode(0);
                    await mk.setQueue({ station: request.params.stationId, startPlaying: false });
                    page.__foliaLiveStation = request.params.stationId;
                    page.__foliaPreparedQueue = [];
                    await mk.play();
                    return { ok: true, data: {} };
                } catch { return { ok: false, error: 'playback-failed' }; }
            }
            if (request.operation === 'setVolume') {
                // Apple 的音频在这里出声，不在 Folia 的增益里：页面的播放器自己管音量。
                if (typeof mk.volume !== 'number') return { ok: false, error: 'unsupported' };
                mk.volume = request.params.volume;
                return { ok: true, data: {} };
            }
            if (request.operation === 'setRepeatOne') {
                // MusicKit 的 PlayerRepeatMode：none 0、one 1（all 2 永远不设：Folia 的队列说了算）。
                // 一次开始（playSong）会再关掉它；renderer 在每次开始之后把它发回来。
                const mode = request.params.enabled ? 1 : 0;
                try {
                    if (typeof mk.setRepeatMode === 'function') mk.setRepeatMode(mode);
                    else if ('repeatMode' in mk) mk.repeatMode = mode;
                    else return { ok: false, error: 'unsupported' };
                } catch { return { ok: false, error: 'playback-failed' }; }
                // 设完之后播放器拿着的是什么，读回来：调用方只记一个数，不要字。
                return { ok: true, data: { repeatMode: Number.isInteger(mk.repeatMode) ? mk.repeatMode : null } };
            }
            const methods: Record<string, string> = { pause: 'pause', resume: 'play', seek: 'seekToTime' };
            if (request.operation === 'playSong') {
                if (typeof mk.setQueue !== 'function' || typeof mk.play !== 'function') return { ok: false, error: 'unsupported' };
                page.__foliaStart = null;
                let playbackStage = 'prepared-queue';
                try {
                    const reused = await controlQueue(mk, request.operation, request.params);
                    if (reused) return reused;
                    // Folia 另行提供准备好的尾巴，顺序仍归 Folia 管。
                    playbackStage = 'configure';
                    if (typeof mk.setShuffleMode === 'function') mk.setShuffleMode(0);
                    if (typeof mk.setRepeatMode === 'function') mk.setRepeatMode(0);
                    // 先设队列不自动开始，让队列解析和 DRM 播放分开成两段。
                    playbackStage = 'queue';
                    console.info('[AppleMusic] Playback stage: queue');
                    page.__foliaLiveStation = '';
                    await mk.setQueue({ song: request.params.catalogId, startPlaying: false, startTime: request.params.startSec });
                    playbackStage = 'play';
                    console.info('[AppleMusic] Playback stage: play');
                    const attempt = { failed: false, cancelled: false, sought: false, pending: true, startedAt: Date.now() };
                    page.__foliaStart = attempt;
                    // 缓冲可能超出 IPC 的预算。开始完成在旁边看着，不占控制队列。
                    Promise.resolve(mk.play()).then(async () => {
                        if (page.__foliaStart !== attempt) return;
                        if (attempt.cancelled) { await mk.pause(); return; }
                        if (!attempt.sought && (request.params.startSec as number) > 0 && typeof mk.seekToTime === 'function'
                            && !(Number(mk.currentPlaybackTime) >= (request.params.startSec as number) - 1)) await mk.seekToTime(request.params.startSec as number);
                    }).catch(() => {
                        if (page.__foliaStart === attempt && !attempt.cancelled) attempt.failed = true;
                    }).finally(() => { attempt.pending = false; });
                } catch {
                    console.warn('[AppleMusic] Playback command rejected', { operation: request.operation });
                    return { ok: false, error: 'playback-failed', playbackStage };
                }
                page.__foliaLastPlay = { requestKey: request.params.requestKey, catalogId: request.params.catalogId };
                // 开始之后播放器立刻怎么说；调用方只记一次（只有 id，没有字）。
                return { ok: true, data: {
                    state: Number.isInteger(mk.playbackState) ? mk.playbackState : null,
                    isPlaying: mk.isPlaying === true,
                    itemId: typeof mk.nowPlayingItem?.id === 'string' ? mk.nowPlayingItem.id : '',
                    queueKeys: mk.queue ? Object.keys(mk.queue).slice(0, 12) : null,
                    // 只会响试听的一次开始在这里说明，带着它放的区域；页面在别的区域时
                    // Apple 对订阅说过什么也一并带上（null：还没说过）。
                    previewOnly: mk.previewOnly === true,
                    storefront: typeof mk.storefrontId === 'string' ? mk.storefrontId.slice(0, 8) : '',
                    subscribed: typeof page.__foliaSubscribed === 'boolean' ? page.__foliaSubscribed : null,
                } };
            }
            if (Object.prototype.hasOwnProperty.call(methods, request.operation)) {
                const method = (mk as any)[methods[request.operation]];
                if (typeof method !== 'function') return { ok: false, error: 'unsupported' };
                if (request.operation === 'seek' && page.__foliaStart) page.__foliaStart.sought = true;
                if (request.operation === 'pause' && page.__foliaStart) page.__foliaStart.cancelled = true;
                if (request.operation === 'resume') {
                    // 缓冲是异步的；重复的 resume 不许重启它，也不许占住命令队列。
                    const previous = page.__foliaStart;
                    if (previous?.pending && !previous.cancelled && Date.now() - previous.startedAt < 60000) return { ok: true, data: {} };
                    if (previous) previous.cancelled = true;
                    const attempt = { failed: false, cancelled: false, pending: true, startedAt: Date.now() };
                    page.__foliaStart = attempt;
                    try {
                        Promise.resolve(method.call(mk)).then(async () => {
                            if (page.__foliaStart === attempt && attempt.cancelled) await mk.pause();
                        }).catch(() => {
                            if (page.__foliaStart === attempt && !attempt.cancelled) attempt.failed = true;
                        }).finally(() => { attempt.pending = false; });
                    } catch {
                        attempt.pending = false;
                        attempt.failed = true;
                        return { ok: false, error: 'playback-failed' };
                    }
                    return { ok: true, data: {} };
                }
                try {
                    await method.call(mk, ...(request.operation === 'seek' ? [request.params.seconds as number] : []));
                } catch {
                    console.warn('[AppleMusic] Playback command rejected', { operation: request.operation });
                    return { ok: false, error: 'playback-failed' };
                }
                return { ok: true, data: {} };
            }
            let account = page.__foliaStorefront;
            if (!account || request.operation === 'accountStatus') {
                account = await call('v1/me/storefront');
                const id = account?.data?.data?.[0]?.id;
                page.__foliaStorefront = typeof id === 'string' && /^[a-z]{2}$/.test(id) ? account : null;
            }
            const store = account?.data?.data?.[0]?.id;
            if (typeof store !== 'string' || !/^[a-z]{2}$/.test(store)) {
                const status = Number(account?.status);
                // 401 或 403 是会话不再被接受；其它一律按 storefront 拿不到说。
                return { ok: false, error: status === 401 || status === 403 ? 'auth-required' : 'storefront-unavailable' };
            }
            if (request.operation === 'accountStatus') {
                // `me/account` 把每个人都叫「我」；绝不能拿一个账号的快照给另一个用。
                const profile = await call('v1/me/social-profile');
                const item = profile?.data?.data?.[0];
                let identity = typeof item?.id === 'string' && item.id && item.id.length <= 512 ? item.id : '';
                const nickname = typeof item?.attributes?.name === 'string' ? item.attributes.name.slice(0, 256) : '';
                if (!identity) {
                    // 有的账号没有社交档案。music user token 一样能认出它：token 留在页面里，
                    // 只有它的 SHA-256 和 profile id 一样会出去。
                    const token = typeof mk.musicUserToken === 'string' ? mk.musicUserToken : '';
                    if (token) identity = 'music-user-token:' + token;
                }
                if (!identity) return { ok: false, error: 'identity-unavailable' };
                const bytes = new TextEncoder().encode('folia-apple-music:' + identity);
                const digest = await crypto.subtle.digest('SHA-256', bytes);
                const id = Array.from(new Uint8Array(digest), (byte: number) => byte.toString(16).padStart(2, '0')).join('');
                // 只转发 HTTPS 的封面地址；档案数据和凭据都留在页面里。
                const artwork = item?.attributes?.artwork?.url;
                let avatarUrl = '';
                if (typeof artwork === 'string' && artwork.length <= 2048) {
                    try { const url = new URL(artwork); if (url.protocol === 'https:' && !url.username && !url.password) avatarUrl = artwork; } catch { /* 没有封面很正常。 */ }
                }
                return { ok: true, data: { id, nickname, storefront: store, avatarUrl } };
            }
            const p = request.params;
            // 跨 storefront 的元数据是 cn 专属的可选查询；永远不动播放的 storefront。
            if (request.operation === 'songOriginal') {
                if (store !== 'cn') return { ok: true, data: null };
                // 页面级的缓存跟着登出/导航走；瞬时的网络错误不缓存。
                const cache = page.__foliaOriginalCache ||= new Map<string, unknown>();
                if (cache.has(p.catalogId)) return { ok: true, data: await cache.get(p.catalogId) };
                const pending = (async () => {
                    const original = await call('v1/catalog/jp/songs/' + encodeURIComponent(p.catalogId as string), { l: 'ja' });
                    const status = Number(original?.status) || 0;
                    if (status === 404) return null;
                    if (status >= 400 || original?.data?.errors?.length) throw new Error('catalog unavailable');
                    const a = original?.data?.data?.[0]?.attributes;
                    if (!a || typeof a.name !== 'string' || typeof a.artistName !== 'string') return null;
                    return { name: a.name.slice(0, 1024), artistName: a.artistName.slice(0, 1024), albumName: typeof a.albumName === 'string' ? a.albumName.slice(0, 1024) : '' };
                })();
                cache.set(p.catalogId, pending);
                try { return { ok: true, data: await pending }; }
                catch { if (cache.get(p.catalogId) === pending) cache.delete(p.catalogId); return { ok: false, error: 'request-failed' }; }
            }
            const base = 'v1/catalog/' + encodeURIComponent(store);
            let path: string;
            let options: Record<string, unknown> = {};
            if (request.operation === 'stations') {
                path = base + '/stations';
                options = { 'filter[featured]': 'apple-music-live-radio', limit: p.limit };
            } else if (request.operation === 'station') {
                path = base + '/stations/' + encodeURIComponent(p.stationId as string);
                options = {};
            } else if (request.operation === 'search') {
                path = base + '/search';
                options = { term: p.query, types: 'songs', limit: p.limit, offset: p.offset };
            } else if (['catalogSong', 'catalogAlbum', 'catalogAlbumTracks', 'catalogArtist', 'catalogArtistSongs', 'catalogArtistAlbums'].includes(request.operation)) {
                const paths: Record<string, string> = { catalogSong: '/songs/', catalogAlbum: '/albums/', catalogAlbumTracks: '/albums/',
                    catalogArtist: '/artists/', catalogArtistSongs: '/artists/', catalogArtistAlbums: '/artists/' };
                const suffixes: Record<string, string> = { catalogAlbumTracks: '/tracks', catalogArtistSongs: '/view/top-songs', catalogArtistAlbums: '/albums' };
                path = base + paths[request.operation] + encodeURIComponent(p.catalogId as string) + (suffixes[request.operation] || '');
                options = ['catalogSong', 'catalogAlbum', 'catalogArtist'].includes(request.operation)
                    ? {} : { limit: p.limit, offset: p.offset };
            } else if (request.operation === 'libraryAlbums') {
                path = 'v1/me/library/albums';
                options = { limit: p.limit, offset: p.offset };
            } else if (request.operation === 'librarySongs') {
                path = 'v1/me/library/songs';
                options = { limit: p.limit, offset: p.offset, include: 'catalog' };
            } else if (request.operation === 'libraryAlbumTracks') {
                path = 'v1/me/library/albums/' + encodeURIComponent(p.albumId as string) + '/tracks';
                options = { limit: p.limit, offset: p.offset, include: 'catalog' };
            } else if (request.operation === 'playlists') {
                path = 'v1/me/library/playlists';
                options = { limit: p.limit, offset: p.offset, extend: 'tags' };
            } else if (request.operation === 'playlistTracks' || request.operation === 'playlistTrackCount') {
                path = 'v1/me/library/playlists/' + encodeURIComponent(p.playlistId as string) + '/tracks';
                options = request.operation === 'playlistTrackCount' ? { limit: 1 } : { limit: p.limit, offset: p.offset };
            } else {
                path = base + '/songs/' + encodeURIComponent(p.songId as string) + '/syllable-lyrics';
            }
            const result = request.operation === 'personalFm' ? await readPersonalStation(call, store) : await call(path, options);
            const status = Number(result?.status) || 0;
            if (status >= 400 || result?.data?.errors?.length) {
                if (request.operation === 'lyrics' && status === 404) return { ok: false, error: 'lyrics-unavailable', httpStatus: 404 };
                // 403 是那一次请求被拒（区域、权利、这首歌），不是会话没了：只有 401 才要重新登录。
                return { ok: false, error: status === 401 ? 'auth-required' : 'upstream-error', httpStatus: status || null };
            }
            if (request.operation === 'playlistTrackCount') {
                const total = result?.data?.meta?.total;
                return { ok: true, data: { total: Number.isSafeInteger(total) && total >= 0 ? total : null } };
            }
            if (request.operation === 'lyrics') {
                const ttml = result?.data?.data?.[0]?.attributes?.ttml;
                if (typeof ttml !== 'string') return { ok: false, error: 'lyrics-unavailable' };
                if (ttml.length > 2 * 1024 * 1024) return { ok: false, error: 'invalid-response' };
                return { ok: true, data: { ttml } };
            }
            const results = result?.data?.results;
            // 什么都没搜到的合法回应可以不带 songs 组。
            const listPage = request.operation === 'search'
                ? (results && typeof results === 'object' && !Array.isArray(results) && results.songs === undefined ? { data: [] } : results?.songs)
                : result?.data;
            if (!Array.isArray(listPage?.data) || listPage.data.length > (request.params.limit as number)) return { ok: false, error: 'invalid-response' };
            // 不外带私人 token、随意的 API 字段或完整的上游回应。
            const string = (value: unknown) => typeof value === 'string' ? value.slice(0, 4096) : '';
            const items = listPage.data.map((item: any) => {
                const a = item?.attributes || {};
                const pp = a.playParams || {};
                return {
                    id: string(item?.id), type: string(item?.type),
                    attributes: {
                        playbackAvailable: typeof a.playParams?.id === 'string' && a.playParams.id.length > 0,
                        ...(typeof a.canEdit === 'boolean' ? { canEdit: a.canEdit } : {}),
                        isLive: a.isLive === true,
                        isFavoritePlaylist: Array.isArray(a.tags) && a.tags.includes('favorited'),
                        name: string(a.name), artistName: string(a.artistName), albumName: string(a.albumName),
                        durationInMillis: Number.isFinite(a.durationInMillis) ? a.durationInMillis : 0,
                        trackCount: Number.isSafeInteger(a.trackCount) && a.trackCount >= 0 ? a.trackCount : null,
                        artwork: { url: string(a.artwork?.url) }, isrc: string(a.isrc),
                        catalogAlbums: (Array.isArray(item?.relationships?.albums?.data) ? item.relationships.albums.data : []).slice(0, 10).map((x: any) => ({ id: string(x?.id), name: string(x?.attributes?.name) })),
                        catalogArtists: (Array.isArray(item?.relationships?.artists?.data) ? item.relationships.artists.data : []).slice(0, 10).map((x: any) => ({ id: string(x?.id), name: string(x?.attributes?.name) })),
                        playParams: { id: string(pp.id), kind: string(pp.kind), catalogId: string(pp.catalogId || item?.relationships?.catalog?.data?.[0]?.id), isLibrary: pp.isLibrary === true },
                    },
                };
            });
            const hasMore = typeof listPage.next === 'string' && listPage.next.length > 0;
            if (hasMore && items.length === 0) return { ok: false, error: 'invalid-response' };
            let nextOffset = (request.params.offset as number) + items.length;
            if (hasMore) {
                const next = new URL(listPage.next, 'https://api.music.apple.com');
                const offsetText = next.searchParams.get('offset');
                const suppliedOffset = offsetText && /^\d+$/.test(offsetText) ? Number(offsetText) : NaN;
                if (!Number.isSafeInteger(suppliedOffset) || suppliedOffset < (request.params.offset as number) + items.length
                    || suppliedOffset <= (request.params.offset as number) || suppliedOffset > 100000) {
                    return { ok: false, error: 'invalid-response' };
                }
                nextOffset = suppliedOffset;
            }
            return { ok: true, data: { items, hasMore, nextOffset } };
        } catch {
            return { ok: false, error: 'request-failed' };
        }
    })();
}
