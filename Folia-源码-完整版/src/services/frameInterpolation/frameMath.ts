// src/services/frameInterpolation/frameMath.ts
// 纯数值层：时间戳分配、对齐、场景差异、降级决策。不碰 DOM，便于单测钉死行为。

import type { InterpolationBackendId, InterpolationMultiplier } from './types';

export const MICROS_PER_MILLI = 1000;

export const clampMultiplier = (value: number): InterpolationMultiplier => (
    value >= 8 ? 8 : value >= 4 ? 4 : 2
);

/**
 * 每对相邻帧插入 multiplier-1 个中间帧，时间戳在 (prevT, nextT) 内等分。
 * VideoFrame.timestamp 单位是微秒。异常时间戳（倒退、NaN）返回空数组，调用方直接放行。
 */
export const intermediateTimestamps = (
    prevTimestampUs: number,
    nextTimestampUs: number,
    multiplier: number,
): number[] => {
    if (!Number.isFinite(prevTimestampUs) || !Number.isFinite(nextTimestampUs)) return [];
    if (nextTimestampUs <= prevTimestampUs) return [];
    const steps = clampMultiplier(multiplier);
    const span = nextTimestampUs - prevTimestampUs;
    const out: number[] = [];
    for (let k = 1; k < steps; k += 1) {
        out.push(Math.round(prevTimestampUs + (span * k) / steps));
    }
    return out;
};

/** 中间帧的 duration 提示：原帧间隔按倍率均分。 */
export const intermediateDuration = (
    prevTimestampUs: number,
    nextTimestampUs: number,
    multiplier: number,
): number | null => {
    if (!Number.isFinite(prevTimestampUs) || !Number.isFinite(nextTimestampUs)) return null;
    if (nextTimestampUs <= prevTimestampUs) return null;
    return Math.max(1, Math.round((nextTimestampUs - prevTimestampUs) / clampMultiplier(multiplier)));
};

/** RIFE/IFRNet 的多尺度卷积要求 H/W 对齐；返回补齐后的尺寸与尾部 padding。 */
export const padToMultiple = (value: number, multiple = 32): { padded: number; padAfter: number } => {
    const m = Math.max(1, Math.floor(multiple));
    const safe = Math.max(0, Math.floor(value));
    const padded = Math.ceil(safe / m) * m;
    return { padded, padAfter: padded - safe };
};

/** 8bit RGBA 采样数组的平均绝对差（0..255），跳过 alpha 通道。 */
export const meanAbsoluteDifference = (
    a: Uint8ClampedArray | Uint8Array,
    b: Uint8ClampedArray | Uint8Array,
): number => {
    const length = Math.min(a.length, b.length);
    if (length < 4) return 0;
    const pixels = Math.floor(length / 4);
    let sum = 0;
    for (let i = 0; i < pixels * 4; i += 4) {
        sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    }
    return sum / (pixels * 3);
};

/** 转场/强闪光会欺骗光流估计，宁可重复帧也不要「融化」的中间帧。 */
export const shouldSkipForSceneChange = (mad: number, threshold: number): boolean => (
    threshold > 0 && Number.isFinite(mad) && mad >= threshold
);

export type CapabilityProbe = {
    settingsEnabled: boolean;
    breakoutBox: boolean;
    ortAvailable: boolean;
    modelAvailable: boolean;
    webgpu: boolean;
    /** 预热实测的单帧耗时（微秒）；null 表示未测或预热失败。 */
    warmupUs: number | null;
    budgetUs: number;
    allowBlendFallback: boolean;
    consecutiveFailures: number;
};

export type BackendChoice = { backend: InterpolationBackendId; reason: string };

/**
 * 降级链：WebGPU/ORT-Web → WebGL EP → WASM → 帧混合 → 不补帧。
 * 前 3 档由 ORT 内部选择，这里只看「实测是否跑得进预算」：跑不进就逐级往下退，
 * 保证实时抓屏 + MediaRecorder 这条链路永远不因插帧背压而拖慢。
 */
export const chooseBackend = (probe: CapabilityProbe): BackendChoice => {
    if (!probe.settingsEnabled) return { backend: 'passthrough', reason: 'settings-off' };
    if (!probe.breakoutBox) return { backend: 'passthrough', reason: 'breakout-box-unavailable' };
    if (probe.consecutiveFailures >= 3) {
        return probe.allowBlendFallback
            ? { backend: 'blend', reason: 'onnx-failures' }
            : { backend: 'passthrough', reason: 'onnx-failures-no-fallback' };
    }
    const canUseOnnx = probe.ortAvailable
        && probe.modelAvailable
        && probe.warmupUs !== null
        && probe.warmupUs <= probe.budgetUs;
    if (canUseOnnx) {
        return {
            backend: 'onnx',
            reason: probe.webgpu ? 'ort-webgpu' : 'ort-wasm-or-webgl',
        };
    }
    if (probe.allowBlendFallback) {
        return { backend: 'blend', reason: probe.warmupUs === null ? 'onnx-unavailable' : 'onnx-over-budget' };
    }
    return { backend: 'passthrough', reason: 'no-fallback' };
};
