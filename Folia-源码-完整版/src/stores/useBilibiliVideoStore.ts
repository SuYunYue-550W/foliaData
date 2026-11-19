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
    /** 七模块面板是否打开。 */
    panelOpen: boolean;
    /** 当前选中的模块。 */
    module: 'recommend' | 'popular' | 'anime' | 'film' | 'live' | 'favorites' | 'history';
    play: (bvid: string, videoUrl?: string | null) => void;
    stop: () => void;
    setMode: (preferIframe: boolean) => void;
    setPanelOpen: (open: boolean) => void;
    setModule: (module: BilibiliVideoState['module']) => void;
}

export const useBilibiliVideoStore = create<BilibiliVideoState>(set => ({
    bvid: null,
    videoUrl: null,
    preferIframe: false,
    panelOpen: false,
    module: 'recommend',
    play: (bvid, videoUrl = null) => set({
        bvid,
        videoUrl,
        panelOpen: false,
    }),
    stop: () => set({ bvid: null, videoUrl: null }),
    setMode: preferIframe => set({ preferIframe }),
    setPanelOpen: panelOpen => set({ panelOpen }),
    setModule: module => set({ module }),
}));

/** 当前有没有 B站视频在播：UI 据此把画面放进播放页。 */
export const selectBilibiliVideoActive = (state: BilibiliVideoState): boolean => Boolean(state.bvid);

/** 走哪条内核：用户强制 iframe，或没有 DASH 地址时，用官方播放器。 */
export const selectBilibiliPlaybackMode = (state: BilibiliVideoState): BilibiliPlaybackMode => (
    state.preferIframe || !state.videoUrl ? 'iframe' : 'dash'
);
