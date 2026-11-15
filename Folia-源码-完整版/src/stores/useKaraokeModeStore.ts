import { create } from 'zustand';

// src/stores/useKaraokeModeStore.ts
// 伴唱模式的三档开关：关 / 伴奏（人声消除）/ 人声独唱。
//
// 这是一个**播放器级**的偏好，不是逐歌的分析结果 —— 所以它跨歌延续、写进
// localStorage，切歌不回到「关」。与 automix 的 htdemucs 分轨无关：那条管线
// 只分离每首的头/尾 30 秒窗口（services/automix/stems.ts 的 STEM_WINDOW_SEC），
// 是给过渡手势用的，撑不起整首歌的伴唱听感；这里的实现走 Web Audio 的
// 中/侧信号实时路由（services/audioEffects/karaokeBranch.ts），不需要任何
// 分析数据，也因此安卓（原生 ExoPlayer 出声，没有 Web Audio 图）上不可用 ——
// 界面按 isKaraokeAvailable 灰置并说明原因。

export type KaraokeMode = 'off' | 'instrumental' | 'vocal';

const STORAGE_KEY = 'local_karaoke_mode';

export type KaraokeAvailability = {
    /** 这条播放链路上能不能实时路由（有 Web Audio 图）：安卓原生播放为 false。 */
    available: boolean;
    /** 不可用时的原因（i18n key），界面拿它灰置并提示。 */
    reasonKey?: string;
};

/** 伴唱不可用的原因键（安卓）。界面据此灰置并提示「原生播放不支持」。 */
export const KARAOKE_UNAVAILABLE_NATIVE = 'karaoke.unavailableNative';

const readStoredMode = (): KaraokeMode => {
    if (typeof window === 'undefined') return 'off';
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === 'instrumental' || saved === 'vocal' ? saved : 'off';
};

type KaraokeState = {
    mode: KaraokeMode;
    setMode: (mode: KaraokeMode) => void;
};

export const useKaraokeModeStore = create<KaraokeState>((set) => ({
    mode: readStoredMode(),
    setMode: (mode) => {
        if (typeof window !== 'undefined') {
            try {
                window.localStorage.setItem(STORAGE_KEY, mode);
            } catch {
                // 私密模式等 localStorage 不可用时只影响本次会话的记忆。
            }
        }
        set({ mode });
    },
}));

/** 供非 React 调用方（audio bridge 订阅、命令面板）读当前档位。 */
export const getKaraokeMode = (): KaraokeMode => useKaraokeModeStore.getState().mode;

/** 供测试复位。 */
export const resetKaraokeModeForTests = (): void => {
    useKaraokeModeStore.setState({ mode: 'off' });
};
