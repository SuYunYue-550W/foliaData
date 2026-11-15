import { create } from 'zustand';
import {
    DEFAULT_INTERPOLATION_SETTINGS,
    DEFAULT_IFRNET_SPEC,
    DEFAULT_RIFE_SPEC,
    clampMultiplier,
    type InterpolationModelId,
    type InterpolationMultiplier,
    type InterpolationSettings,
    type OnnxModelSpec,
} from '../services/frameInterpolation';

// src/stores/useFrameInterpolationStore.ts
//
// 导出补帧的设置。开关放在主设置页而不是远程导出面板：导出实际在主窗口执行，
// 两个窗口的 localStorage 不共享，放在主窗口自己的设置里可以完全避开跨窗口同步。
//
// 高级项（权重 URL、单帧预算、场景差异阈值）不进 UI，走 localStorage 手动配置，
// 见《导出补帧层改动说明》。默认没有权重 URL，工厂会自动退到帧混合后端。

export const FRAME_INTERPOLATION_KEYS = {
    enabled: 'folia.exportInterpolation.enabled',
    multiplier: 'folia.exportInterpolation.multiplier',
    model: 'folia.exportInterpolation.model',
    allowBlendFallback: 'folia.exportInterpolation.allowBlendFallback',
    modelUrl: 'folia.exportInterpolation.modelUrl',
    frameBudgetUs: 'folia.exportInterpolation.frameBudgetUs',
    sceneChangeThreshold: 'folia.exportInterpolation.sceneChangeThreshold',
} as const;

const readString = (key: string, fallback: string): string => {
    if (typeof window === 'undefined') return fallback;
    try {
        return localStorage.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
};

const readBoolean = (key: string, fallback: boolean): boolean => {
    if (typeof window === 'undefined') return fallback;
    try {
        const saved = localStorage.getItem(key);
        return saved === null ? fallback : saved === 'true';
    } catch {
        return fallback;
    }
};

const write = (key: string, value: string | boolean | number): void => {
    try {
        localStorage.setItem(key, String(value));
    } catch {
        // 写不进去也要让本轮会话的开关生效。
    }
};

const readNumber = (key: string, fallback: number): number => {
    const parsed = Number(readString(key, String(fallback)));
    return Number.isFinite(parsed) ? parsed : fallback;
};

export const readFrameInterpolationModel = (): InterpolationModelId | 'auto' => {
    const value = readString(FRAME_INTERPOLATION_KEYS.model, 'auto');
    return value === 'rife' || value === 'ifrnet' ? value : 'auto';
};

/** 给导出控制器用：一次读全，不依赖 React 树，也不订阅 store。 */
export const readFrameInterpolationSettings = (): InterpolationSettings => {
    const model = readFrameInterpolationModel();
    const modelUrl = readString(FRAME_INTERPOLATION_KEYS.modelUrl, '').trim();
    const spec: OnnxModelSpec | null = modelUrl
        ? (model === 'ifrnet' ? DEFAULT_IFRNET_SPEC : DEFAULT_RIFE_SPEC)
        : null;
    return {
        ...DEFAULT_INTERPOLATION_SETTINGS,
        enabled: readBoolean(FRAME_INTERPOLATION_KEYS.enabled, DEFAULT_INTERPOLATION_SETTINGS.enabled),
        multiplier: clampMultiplier(readNumber(FRAME_INTERPOLATION_KEYS.multiplier, 2)),
        model,
        allowBlendFallback: readBoolean(
            FRAME_INTERPOLATION_KEYS.allowBlendFallback,
            DEFAULT_INTERPOLATION_SETTINGS.allowBlendFallback,
        ),
        frameBudgetUs: Math.max(1_000, readNumber(
            FRAME_INTERPOLATION_KEYS.frameBudgetUs,
            DEFAULT_INTERPOLATION_SETTINGS.frameBudgetUs,
        )),
        sceneChangeThreshold: Math.max(0, readNumber(
            FRAME_INTERPOLATION_KEYS.sceneChangeThreshold,
            DEFAULT_INTERPOLATION_SETTINGS.sceneChangeThreshold,
        )),
        modelUrl: modelUrl || null,
        modelSpec: spec,
    };
};

type FrameInterpolationState = {
    enabled: boolean;
    multiplier: InterpolationMultiplier;
    model: InterpolationModelId | 'auto';
    allowBlendFallback: boolean;
    setEnabled: (enabled: boolean) => void;
    setMultiplier: (multiplier: InterpolationMultiplier) => void;
    setModel: (model: InterpolationModelId | 'auto') => void;
    setAllowBlendFallback: (allowed: boolean) => void;
};

export const useFrameInterpolationStore = create<FrameInterpolationState>((set) => ({
    enabled: readBoolean(FRAME_INTERPOLATION_KEYS.enabled, false),
    multiplier: clampMultiplier(readNumber(FRAME_INTERPOLATION_KEYS.multiplier, 2)),
    model: readFrameInterpolationModel(),
    allowBlendFallback: readBoolean(FRAME_INTERPOLATION_KEYS.allowBlendFallback, true),
    setEnabled: (enabled) => {
        write(FRAME_INTERPOLATION_KEYS.enabled, enabled);
        set({ enabled });
    },
    setMultiplier: (multiplier) => {
        const safe = clampMultiplier(multiplier);
        write(FRAME_INTERPOLATION_KEYS.multiplier, safe);
        set({ multiplier: safe });
    },
    setModel: (model) => {
        write(FRAME_INTERPOLATION_KEYS.model, model);
        set({ model });
    },
    setAllowBlendFallback: (allowed) => {
        write(FRAME_INTERPOLATION_KEYS.allowBlendFallback, allowed);
        set({ allowBlendFallback: allowed });
    },
}));
