import { create } from 'zustand';
import { VISUALIZER_FRAME_RATE_STORAGE_KEY, parseVisualizerFrameRate } from '../utils/frameRateLimiter';
import { readStoredRenderPixelRatio } from '../utils/renderPixelRatio';
import type { MicroRenderPort } from '../utils/microRender';

// src/stores/useMicroRenderStore.ts
//
// 「微渲染引擎 GPU 调度」的两个开关，以及把设置喂给 utils 层的端口。
//
// 为什么另起一个小 store、不塞进 useVisualizerSettingsStore：调度器是 utils 层的常驻模块，
// 不该反向依赖 store；而用户手选的帧率/分辨率已经在各自的 action 里即时应用并写进
// localStorage，端口每秒读一次存储就能跟上，不需要订阅那个 600 多行的大 store。
// 这样壁纸层等独立 document 也能复用同一份端口，不牵扯主窗口的 React 树。

export const MICRO_RENDER_ENABLED_STORAGE_KEY = 'folia.microRender.enabled';
export const MICRO_RENDER_PIXEL_SCALING_STORAGE_KEY = 'folia.microRender.allowPixelRatioScaling';

const readStoredBoolean = (key: string, fallback: boolean): boolean => {
    if (typeof window === 'undefined') return fallback;
    try {
        const saved = localStorage.getItem(key);
        return saved === null ? fallback : saved === 'true';
    } catch {
        return fallback;
    }
};

const writeStoredBoolean = (key: string, value: boolean) => {
    try {
        localStorage.setItem(key, String(value));
    } catch {
        // 存储写不进去也不能让开关用不了：本轮会话照常生效。
    }
};

type MicroRenderState = {
    /** 自适应调度总开关。默认开：只让预算、不越过用户手选档位。 */
    enabled: boolean;
    /** 是否允许自动降渲染分辨率。默认关：它会广播 resize 触发整页重排。 */
    allowPixelRatioScaling: boolean;
    setEnabled: (enabled: boolean) => void;
    setAllowPixelRatioScaling: (allowed: boolean) => void;
};

export const useMicroRenderStore = create<MicroRenderState>((set) => ({
    enabled: readStoredBoolean(MICRO_RENDER_ENABLED_STORAGE_KEY, true),
    allowPixelRatioScaling: readStoredBoolean(MICRO_RENDER_PIXEL_SCALING_STORAGE_KEY, false),
    setEnabled: (enabled) => {
        writeStoredBoolean(MICRO_RENDER_ENABLED_STORAGE_KEY, enabled);
        set({ enabled });
    },
    setAllowPixelRatioScaling: (allowed) => {
        writeStoredBoolean(MICRO_RENDER_PIXEL_SCALING_STORAGE_KEY, allowed);
        set({ allowPixelRatioScaling: allowed });
    },
}));

/** 每个 HTML 入口各自造一份；只在本 document 内被读取。 */
export const createMicroRenderPort = (): MicroRenderPort => ({
    isEnabled: () => useMicroRenderStore.getState().enabled,
    subscribeEnabled: (listener) => useMicroRenderStore.subscribe((state) => listener(state.enabled)),
    getUserFrameRate: () => {
        try {
            return parseVisualizerFrameRate(localStorage.getItem(VISUALIZER_FRAME_RATE_STORAGE_KEY));
        } catch {
            return 'off';
        }
    },
    getUserPixelRatio: () => {
        try {
            return readStoredRenderPixelRatio();
        } catch {
            return null;
        }
    },
    allowPixelRatioScaling: () => useMicroRenderStore.getState().allowPixelRatioScaling,
});
