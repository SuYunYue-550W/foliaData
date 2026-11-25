import { create } from 'zustand';

// src/stores/useBilibiliVideoStore.ts
// B站视频播放的界面状态：当前 bvid、播放内核（A 自研流 / B 官方 iframe）、七个模块的面板开关。
// 只存 UI 状态；平台数据一律经 omni（见 online-song-omni-routing skill）。

export type BilibiliPlaybackMode = 'dash' | 'iframe';

export interface BilibiliVideoState {
    /** 当前要播的 bvid（不含 room: 前缀）；null 表示没在播 B站视频。 */
    bvid: string | null;
    /** DASH 的视频流地址（路线 A）；为空时自动用 iframe（路线 B）。 */
    videoUrl: string | null;
    /** 用户是否强制走 iframe（A 失败时自动切）。 */
    preferIframe: boolean;
    /** 首页里的 B站页面是否打开（一级页签对应的整屏页面）。 */
    homeOpen: boolean;
    /** 当前选中的模块。 */
    module: 'recommend' | 'popular' | 'anime' | 'film' | 'live' | 'favorites' | 'history';
    /** 收藏模块里正在看的那个收藏夹 id；空表示还在收藏夹目录那一层。 */
    mediaId: string | null;
    play: (bvid: string, videoUrl?: string | null) => void;
    stop: () => void;
    setMode: (preferIframe: boolean) => void;
    setHomeOpen: (open: boolean) => void;
    setModule: (module: BilibiliVideoState['module']) => void;
    setMediaId: (mediaId: string | null) => void;
}

export const useBilibiliVideoStore = create<BilibiliVideoState>(set => ({
    bvid: null,
    videoUrl: null,
    preferIframe: false,
    homeOpen: false,
    module: 'recommend',
    mediaId: null,
    // 模态选择是「本次播放」状态，不是全局配置：某一个视频的 DASH 失败后
    // handleDashError 会 setMode(true)，若这里不重置，之后每个视频（哪怕取流正常）
    // 都永久走 iframe，还会连带触发 iframe 自带音频与主引擎双份出声。
    play: (bvid, videoUrl = null) => set({ bvid, videoUrl, preferIframe: false }),
    // 关画面只收掉画面与声音（音频也来自 B站的那条流）；首页页面是否开着是另一回事，不动。
    stop: () => set({ bvid: null, videoUrl: null, preferIframe: false }),
    setMode: preferIframe => set({ preferIframe }),
    setHomeOpen: homeOpen => set({ homeOpen }),
    setModule: module => set({ module, mediaId: null }),
    setMediaId: mediaId => set({ mediaId }),
}));

/**
 * 当前有没有 B站视频在播：UI 据此把画面放进播放页。
 *
 * 要有**真正能画的东西**才算：只有 bvid 而没有 videoUrl 时（取流还没回来、或
 * 取流失败了），挂上去的是一层空白 <video>，还会把内置的视频层错误地抑制掉。
 * iframe 路线不需要 videoUrl —— 它自己按 bvid 拉流。
 */
export const selectBilibiliVideoActive = (state: BilibiliVideoState): boolean => (
    Boolean(state.bvid) && (state.preferIframe || Boolean(state.videoUrl))
);

/**
 * 走哪条内核：用户强制 iframe 时用官方播放器，否则用自研 DASH。
 *
 * 注意：**不由「当前有没有 videoUrl」决定**。取流是异步的：面板点一条时先起画面，
 * videoUrl 要等取流回来才有。若按有没有地址来定内核，那一刻还没有地址，
 * 就永远停在 iframe 了。改为：先按 dash 起步，等 videoUrl 到了就自然有画面；
 * DASH 真失败时组件自己切 preferIframe（见 BilibiliVideoSurface 的 handleDashError）。
 */
export const selectBilibiliPlaybackMode = (state: BilibiliVideoState): BilibiliPlaybackMode => (
    state.preferIframe ? 'iframe' : 'dash'
);
