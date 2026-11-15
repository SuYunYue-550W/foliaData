// src/services/frameInterpolation/capabilities.ts
//
// 工厂：把「能力探测 → 预热实测 → 选后端」串成一次**异步、有超时、绝不阻塞导出**的初始化。
// 关键约束：这条管线是实时抓屏 + 实时 MediaRecorder 编码，不是录完再离线处理，
// 所以任何一步超时都必须立刻降级，不能让 TransformStream 背压拖慢整个录制。

import { BlendFrameInterpolator } from './blendInterpolator';
import { chooseBackend, type BackendChoice } from './frameMath';
import { OnnxFrameInterpolator } from './onnxInterpolator';
import {
    DEFAULT_IFRNET_SPEC,
    DEFAULT_RIFE_SPEC,
    type FrameInterpolator,
    type InterpolationBackendId,
    type InterpolationSettings,
    type OnnxModelSpec,
} from './types';

/** 预热用固定小图，按面积线性折算到预设尺寸，再乘安全系数。 */
const WARMUP_WIDTH = 128;
const WARMUP_HEIGHT = 72;
const AREA_SAFETY_FACTOR = 1.5;
const INIT_TIMEOUT_MS = 8_000;

const nowUs = (): number => (
    typeof performance !== 'undefined' ? performance.now() * 1000 : Date.now() * 1000
);

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            promise,
            new Promise<null>(resolve => {
                timer = setTimeout(() => resolve(null), timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
};

const makeWarmupFrames = (): { first: VideoFrame; second: VideoFrame } | null => {
    if (typeof OffscreenCanvas === 'undefined' || typeof VideoFrame === 'undefined') return null;
    try {
        const canvas = new OffscreenCanvas(WARMUP_WIDTH, WARMUP_HEIGHT);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) return null;
        context.fillStyle = '#101018';
        context.fillRect(0, 0, WARMUP_WIDTH, WARMUP_HEIGHT);
        context.fillStyle = '#e0a060';
        context.fillRect(10, 10, 24, 24);
        const first = new VideoFrame(canvas, { timestamp: 0, duration: 16_667 });
        context.fillRect(30, 10, 24, 24);
        const second = new VideoFrame(canvas, { timestamp: 16_667, duration: 16_667 });
        return { first, second };
    } catch {
        return null;
    }
};

const resolveSpec = (settings: InterpolationSettings): OnnxModelSpec | null => {
    if (settings.modelSpec) return settings.modelSpec;
    if (settings.model === 'ifrnet') return DEFAULT_IFRNET_SPEC;
    // auto 与 rife 都优先 RIFE：迭代最活跃、部署生态最全。
    return DEFAULT_RIFE_SPEC;
};

export type InterpolationRuntime = {
    /** 首帧 transform 会 await 它；最多等 INIT_TIMEOUT_MS。 */
    readonly ready: Promise<void>;
    backend(): InterpolationBackendId;
    choice(): BackendChoice;
    getInterpolator(): FrameInterpolator | null;
    settings(): InterpolationSettings;
    dispose(): void;
};

export type RuntimeProbe = {
    breakoutBox: boolean;
    /** 预设尺寸，用于把预热耗时折算到真实分辨率。 */
    width: number;
    height: number;
};

/**
 * 同步返回、异步初始化。调用方在 transform 里 await ready 即可，
 * 初始化失败/超时会落到 blend 或 passthrough，绝不抛到导出链路上。
 */
export const createExportInterpolationRuntime = (
    rawSettings: InterpolationSettings,
    probe: RuntimeProbe,
): InterpolationRuntime => {
    const settings: InterpolationSettings = {
        ...rawSettings,
        frameBudgetUs: Math.max(1_000, Math.floor(rawSettings.frameBudgetUs)),
    };
    let choice: BackendChoice = chooseBackend({
        settingsEnabled: settings.enabled,
        breakoutBox: probe.breakoutBox,
        // 静态阶段还不知道 ORT/权重是否就绪，先按「不可用」占位，预热后再定。
        ortAvailable: false,
        modelAvailable: false,
        webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
        warmupUs: null,
        budgetUs: settings.frameBudgetUs,
        allowBlendFallback: settings.allowBlendFallback,
        consecutiveFailures: 0,
    });
    let interpolator: FrameInterpolator | null = null;

    const init = async (): Promise<void> => {
        if (!settings.enabled || !probe.breakoutBox) {
            choice = chooseBackend({
                settingsEnabled: settings.enabled,
                breakoutBox: probe.breakoutBox,
                ortAvailable: false,
                modelAvailable: false,
                webgpu: false,
                warmupUs: null,
                budgetUs: settings.frameBudgetUs,
                allowBlendFallback: settings.allowBlendFallback,
                consecutiveFailures: 0,
            });
            return;
        }

        const hasOnnx = Boolean(settings.modelUrl);
        if (hasOnnx) {
            const candidate = new OnnxFrameInterpolator({
                spec: resolveSpec(settings) ?? DEFAULT_RIFE_SPEC,
                modelUrl: settings.modelUrl as string,
            });
            const prepared = await withTimeout(candidate.prepare(), INIT_TIMEOUT_MS);
            if (prepared) {
                const warmup = makeWarmupFrames();
                if (warmup) {
                    const startedAtUs = nowUs();
                    const produced = await withTimeout(
                        candidate.interpolate({
                            prev: warmup.first,
                            next: warmup.second,
                            timestampsUs: [8_333],
                            width: WARMUP_WIDTH,
                            height: WARMUP_HEIGHT,
                            durationUs: 8_333,
                        }),
                        INIT_TIMEOUT_MS,
                    );
                    warmup.first.close();
                    warmup.second.close();
                    produced?.forEach(frame => frame.close());
                    if (produced && produced.length > 0) {
                        const measuredUs = nowUs() - startedAtUs;
                        const warmupPixels = WARMUP_WIDTH * WARMUP_HEIGHT;
                        const presetPixels = Math.max(1, probe.width * probe.height);
                        // 面积折算后乘安全系数，宁可低估能力也不要让实时流背压。
                        const estimatedUs = measuredUs * (presetPixels / warmupPixels) * AREA_SAFETY_FACTOR;
                        choice = chooseBackend({
                            settingsEnabled: true,
                            breakoutBox: true,
                            ortAvailable: true,
                            modelAvailable: true,
                            webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
                            warmupUs: estimatedUs,
                            // frameBudgetUs 是「整对帧」的总预算（≈ 一个帧间隔）。倍率越高，
                            // 单帧可分到的越少，判定越保守 —— 4× 时要求单帧跑进 1/3 预算。
                            budgetUs: settings.frameBudgetUs / Math.max(1, settings.multiplier - 1),
                            allowBlendFallback: settings.allowBlendFallback,
                            consecutiveFailures: 0,
                        });
                        if (choice.backend === 'onnx') {
                            interpolator = candidate;
                            return;
                        }
                    }
                }
            }
            candidate.dispose();
        }

        if (settings.allowBlendFallback) {
            const blend = new BlendFrameInterpolator();
            if (await blend.prepare()) {
                interpolator = blend;
                choice = { backend: 'blend', reason: hasOnnx ? 'onnx-fallback' : 'blend-only' };
                return;
            }
            blend.dispose();
        }
        interpolator = null;
        choice = { backend: 'passthrough', reason: 'no-usable-backend' };
    };

    const ready = init().catch(() => {
        // 兜底：任何未预期异常都退回不补帧，绝不把异常抛给录制流。
        interpolator?.dispose();
        interpolator = null;
        choice = { backend: 'passthrough', reason: 'init-error' };
    });

    return {
        ready,
        backend: () => (interpolator ? choice.backend : 'passthrough'),
        choice: () => choice,
        getInterpolator: () => interpolator,
        settings: () => settings,
        dispose: () => {
            interpolator?.dispose();
            interpolator = null;
            choice = { backend: 'passthrough', reason: 'disposed' };
        },
    };
};
