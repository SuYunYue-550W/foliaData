// src/services/frameInterpolation/stage.ts
//
// 帧流里的「延迟一帧」补帧 stage。要生成 t=0.5 的中间帧必须同时拿到 t=0 与 t=1，
// 所以始终缓存一帧再输出：
//   收到 f1 → 缓存
//   收到 f2 → 生成 mid12 → 输出 f1, mid12 → 缓存 f2
//   收到 f3 → 生成 mid23 → 输出 f2, mid23 → 缓存 f3
//   flush   → 输出最后一帧
// 最终序列 f1, mid12, f2, mid23, f3 ... 顺序与时间戳都严格递增。
//
// 三条硬保护：① 单对帧超时即跳过，绝不阻塞实时抓屏；② 连续失败自动降级到帧混合；
// ③ 转场/强闪光跳过补帧，避免光流「融化」。

import { BlendFrameInterpolator, sampleFrameDifference } from './blendInterpolator';
import type { InterpolationRuntime } from './capabilities';
import {
    beginFrameInterpolationExport,
    endFrameInterpolationExport,
} from './exportGuard';
import {
    intermediateDuration,
    intermediateTimestamps,
    shouldSkipForSceneChange,
} from './frameMath';
import type { FrameInterpolator } from './types';

type Controller = TransformStreamDefaultController<VideoFrame>;

const MAX_CONSECUTIVE_FAILURES = 3;

export type InterpolationStage = {
    push(frame: VideoFrame, controller: Controller): Promise<void>;
    flush(controller: Controller): void;
    dispose(): void;
};

export const createInterpolationStage = (runtime: InterpolationRuntime): InterpolationStage => {
    let pending: VideoFrame | null = null;
    let interpolator: FrameInterpolator | null = null;
    let failures = 0;
    let demoted = false;
    let guardHeld = false;
    let disposed = false;

    const settings = runtime.settings();

    const releaseGuard = () => {
        if (!guardHeld) return;
        guardHeld = false;
        endFrameInterpolationExport();
    };

    const holdGuard = () => {
        if (guardHeld || disposed) return;
        guardHeld = true;
        beginFrameInterpolationExport();
    };

    /** 连续失败后把 ONNX 换成零依赖的帧混合，避免 GPU 争用继续拖慢录制。 */
    const demote = () => {
        failures += 1;
        // 只降级一次：否则每对帧都会再建一个 blend，且下一帧又会从 runtime 取回被弃用的 ONNX。
        if (failures < MAX_CONSECUTIVE_FAILURES || demoted) return;
        demoted = true;
        const previous = interpolator;
        interpolator = null;
        if (settings.allowBlendFallback) {
            const blend = new BlendFrameInterpolator();
            void blend.prepare().then(ok => {
                if (!ok || disposed) {
                    blend.dispose();
                    return;
                }
                if (interpolator === null) interpolator = blend;
                else blend.dispose();
            });
        }
        previous?.dispose();
    };

    const generate = async (prev: VideoFrame, next: VideoFrame): Promise<VideoFrame[]> => {
        const active = interpolator;
        if (!active || disposed) return [];
        const timestampsUs = intermediateTimestamps(prev.timestamp, next.timestamp, settings.multiplier);
        if (timestampsUs.length === 0) return [];
        if (settings.sceneChangeThreshold > 0) {
            try {
                if (shouldSkipForSceneChange(sampleFrameDifference(prev, next), settings.sceneChangeThreshold)) {
                    return [];
                }
            } catch {
                // 采样失败不做保护，继续尝试补帧。
            }
        }
        const durationUs = intermediateDuration(prev.timestamp, next.timestamp, settings.multiplier);
        const width = prev.displayWidth || next.displayWidth;
        const height = prev.displayHeight || next.displayHeight;
        // 与工厂判定同一口径：frameBudgetUs 是整对帧的总预算，不随倍率放大。
        const budgetMs = settings.frameBudgetUs / 1000;
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            const work = active.interpolate({ prev, next, timestampsUs, width, height, durationUs });
            const result = await Promise.race([
                work,
                new Promise<null>(resolve => {
                    timer = setTimeout(() => resolve(null), Math.max(1, budgetMs));
                }),
            ]);
            if (result === null) {
                demote();
                return [];
            }
            failures = 0;
            return result;
        } catch {
            demote();
            return [];
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
    };

    return {
        async push(frame: VideoFrame, controller: Controller): Promise<void> {
            if (disposed) {
                controller.enqueue(frame);
                return;
            }
            // 首帧等初始化，最多 8 秒；之后这个 promise 已 resolved，零开销。
            await runtime.ready;
            const active = runtime.getInterpolator();
            if (!demoted && active && interpolator === null) {
                interpolator = active;
            }
            if (!interpolator) {
                // 后端不可用：退化为原链路行为，按到达顺序直接放行。
                if (pending) {
                    controller.enqueue(pending);
                    pending = null;
                }
                controller.enqueue(frame);
                return;
            }
            holdGuard();
            if (!pending) {
                pending = frame;
                return;
            }
            const prev = pending;
            const next = frame;
            // 插帧必须在 enqueue(prev) 之前完成：enqueue 之后帧的所有权就归流了。
            const generated = await generate(prev, next);
            controller.enqueue(prev);
            generated.forEach(interpolated => controller.enqueue(interpolated));
            pending = next;
        },

        flush(controller: Controller): void {
            if (pending) {
                controller.enqueue(pending);
                pending = null;
            }
        },

        dispose(): void {
            if (disposed) return;
            disposed = true;
            if (pending) {
                pending.close();
                pending = null;
            }
            releaseGuard();
            runtime.dispose();
        },
    };
};
