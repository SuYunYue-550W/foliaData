import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    chooseBackend,
    clampMultiplier,
    intermediateDuration,
    intermediateTimestamps,
    meanAbsoluteDifference,
    padToMultiple,
    shouldSkipForSceneChange,
    type CapabilityProbe,
} from '../../../src/services/frameInterpolation/frameMath';
import {
    DEFAULT_INTERPOLATION_SETTINGS,
    type FrameInterpolator,
    type InterpolationRequest,
    type InterpolationSettings,
} from '../../../src/services/frameInterpolation/types';
import {
    endFrameInterpolationExport,
    isFrameInterpolationExportActive,
} from '../../../src/services/frameInterpolation/exportGuard';
import {
    createInterpolationStage,
} from '../../../src/services/frameInterpolation/stage';
import type { InterpolationRuntime } from '../../../src/services/frameInterpolation/capabilities';

// 补帧层只把「数值决策」和「帧顺序」做成纯逻辑；GPU 推理本身不在这里测。

const probe = (over: Partial<CapabilityProbe> = {}): CapabilityProbe => ({
    settingsEnabled: true,
    breakoutBox: true,
    ortAvailable: true,
    modelAvailable: true,
    webgpu: true,
    warmupUs: 8_000,
    budgetUs: 16_000,
    allowBlendFallback: true,
    consecutiveFailures: 0,
    ...over,
});

describe('frameMath · 时间戳与对齐', () => {
    it('倍率决定中间帧数量，时间戳严格递增且落在区间内', () => {
        expect(intermediateTimestamps(0, 16_667, 2)).toEqual([8_334]);
        const four = intermediateTimestamps(0, 16_667, 4);
        expect(four).toHaveLength(3);
        expect(four[0]).toBeGreaterThan(0);
        expect(four[2]).toBeLessThan(16_667);
        expect(four).toEqual([...four].sort((a, b) => a - b));
        expect(intermediateTimestamps(1_000, 1_016_667, 8)).toHaveLength(7);
    });

    it('异常时间戳（倒退 / NaN）不产生中间帧', () => {
        expect(intermediateTimestamps(16_667, 0, 2)).toEqual([]);
        expect(intermediateTimestamps(0, 0, 2)).toEqual([]);
        expect(intermediateTimestamps(Number.NaN, 100, 2)).toEqual([]);
    });

    it('duration 按倍率均分，且至少 1 微秒', () => {
        expect(intermediateDuration(0, 16_667, 2)).toBe(8_334);
        expect(intermediateDuration(0, 16_667, 4)).toBe(4_167);
        expect(intermediateDuration(0, 1, 4)).toBe(1);
        expect(intermediateDuration(10, 5, 2)).toBeNull();
    });

    it('倍率夹在 2/4/8，padding 按 32 对齐', () => {
        expect(clampMultiplier(1)).toBe(2);
        expect(clampMultiplier(3)).toBe(2);
        expect(clampMultiplier(5)).toBe(4);
        expect(clampMultiplier(99)).toBe(8);
        expect(padToMultiple(1080, 32)).toEqual({ padded: 1088, padAfter: 8 });
        expect(padToMultiple(1280, 32)).toEqual({ padded: 1280, padAfter: 0 });
    });

    it('场景差异用 RGB 平均绝对差，阈值关闭时不跳过', () => {
        const black = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
        const white = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]);
        expect(meanAbsoluteDifference(black, white)).toBe(255);
        expect(meanAbsoluteDifference(black, black)).toBe(0);
        expect(shouldSkipForSceneChange(255, 52)).toBe(true);
        expect(shouldSkipForSceneChange(10, 52)).toBe(false);
        expect(shouldSkipForSceneChange(255, 0)).toBe(false);
    });
});

describe('chooseBackend · 降级链', () => {
    it('开关关闭或 breakout-box 不可用 → 完全不补帧', () => {
        expect(chooseBackend(probe({ settingsEnabled: false })).backend).toBe('passthrough');
        expect(chooseBackend(probe({ breakoutBox: false })).backend).toBe('passthrough');
    });

    it('ORT + 权重 + 预热跑得进预算 → onnx，并标明 WebGPU', () => {
        expect(chooseBackend(probe())).toEqual({ backend: 'onnx', reason: 'ort-webgpu' });
        expect(chooseBackend(probe({ webgpu: false })).reason).toBe('ort-wasm-or-webgl');
    });

    it('预热超预算 / 权重缺失 / 未测 → 退到帧混合', () => {
        expect(chooseBackend(probe({ warmupUs: 40_000 })).backend).toBe('blend');
        expect(chooseBackend(probe({ modelAvailable: false })).backend).toBe('blend');
        expect(chooseBackend(probe({ warmupUs: null })).reason).toBe('onnx-unavailable');
    });

    it('不允许帧混合时，任何不可用都落到 passthrough', () => {
        expect(chooseBackend(probe({ ortAvailable: false, allowBlendFallback: false })).backend).toBe('passthrough');
    });

    it('连续失败 3 次后永久降级，不再尝试 ONNX', () => {
        expect(chooseBackend(probe({ consecutiveFailures: 3 })).reason).toBe('onnx-failures');
        expect(chooseBackend(probe({ consecutiveFailures: 2 })).backend).toBe('onnx');
    });
});

// ---- stage：用假的 VideoFrame / controller / interpolator 验证帧顺序与互斥 ----

type FakeFrame = VideoFrame & { close: ReturnType<typeof vi.fn> };

const fakeFrame = (timestampUs: number): FakeFrame => ({
    timestamp: timestampUs,
    duration: 16_667,
    displayWidth: 64,
    displayHeight: 36,
    close: vi.fn(),
} as unknown as FakeFrame);

const fakeController = () => {
    const enqueued: FakeFrame[] = [];
    return {
        enqueued,
        controller: { enqueue: (frame: FakeFrame) => enqueued.push(frame) } as unknown as TransformStreamDefaultController<VideoFrame>,
    };
};

const fakeInterpolator = (impl?: (req: InterpolationRequest) => Promise<VideoFrame[]>) => ({
    id: 'blend' as const,
    model: null,
    prepare: vi.fn(async () => true),
    interpolate: vi.fn(impl ?? (async (req: InterpolationRequest) => req.timestampsUs.map(ts => fakeFrame(ts)))),
    dispose: vi.fn(),
});

const settingsWith = (over: Partial<InterpolationSettings> = {}): InterpolationSettings => ({
    ...DEFAULT_INTERPOLATION_SETTINGS,
    enabled: true,
    sceneChangeThreshold: 0,
    ...over,
});

const fakeRuntime = (settings: InterpolationSettings, interpolator: FrameInterpolator | null): InterpolationRuntime => ({
    ready: Promise.resolve(),
    backend: () => (interpolator ? 'blend' : 'passthrough'),
    choice: () => ({ backend: 'blend', reason: 'test' }),
    getInterpolator: () => interpolator,
    settings: () => settings,
    dispose: vi.fn(),
});

describe('stage · 延迟一帧的帧顺序与保护', () => {
    afterEach(() => {
        // guard 是模块级计数，逐例排空，避免串味。
        let safety = 8;
        while (isFrameInterpolationExportActive() && safety > 0) {
            endFrameInterpolationExport();
            safety -= 1;
        }
        expect(isFrameInterpolationExportActive()).toBe(false);
        vi.restoreAllMocks();
    });

    it('输出 f1, mid12, f2, mid23, f3，时间戳严格递增', async () => {
        const interpolator = fakeInterpolator();
        const stage = createInterpolationStage(fakeRuntime(settingsWith(), interpolator));
        const { controller, enqueued } = fakeController();
        await stage.push(fakeFrame(0), controller);
        expect(enqueued).toHaveLength(0); // 首帧被缓存
        await stage.push(fakeFrame(16_667), controller);
        await stage.push(fakeFrame(33_334), controller);
        stage.flush(controller);
        expect(enqueued.map(f => f.timestamp)).toEqual([0, 8_334, 16_667, 25_001, 33_334]);
        expect(enqueued.every((f, i) => i === 0 || f.timestamp > enqueued[i - 1].timestamp)).toBe(true);
        expect(interpolator.interpolate).toHaveBeenCalledTimes(2);
        stage.dispose();
    });

    it('interpolate 抛错时跳过中间帧，但原始帧一帧不丢', async () => {
        const interpolator = fakeInterpolator(async () => { throw new Error('gpu lost'); });
        const stage = createInterpolationStage(fakeRuntime(settingsWith(), interpolator));
        const { controller, enqueued } = fakeController();
        await stage.push(fakeFrame(0), controller);
        await stage.push(fakeFrame(16_667), controller);
        stage.flush(controller);
        expect(enqueued.map(f => f.timestamp)).toEqual([0, 16_667]);
        stage.dispose();
    });

    it('后端不可用时退化为原链路：按到达顺序直接放行', async () => {
        const stage = createInterpolationStage(fakeRuntime(settingsWith(), null));
        const { controller, enqueued } = fakeController();
        await stage.push(fakeFrame(0), controller);
        await stage.push(fakeFrame(16_667), controller);
        stage.flush(controller);
        expect(enqueued.map(f => f.timestamp)).toEqual([0, 16_667]);
        expect(isFrameInterpolationExportActive()).toBe(false);
        stage.dispose();
    });

    it('补帧跑起来时持有调度互斥，dispose 后释放', async () => {
        const interpolator = fakeInterpolator();
        const stage = createInterpolationStage(fakeRuntime(settingsWith(), interpolator));
        const { controller } = fakeController();
        await stage.push(fakeFrame(0), controller);
        // 从首帧就冻结调度器：导出准备/倒计时阶段也不该发生自适应降档。
        expect(isFrameInterpolationExportActive()).toBe(true);
        await stage.push(fakeFrame(16_667), controller);
        expect(isFrameInterpolationExportActive()).toBe(true);
        stage.dispose();
        expect(isFrameInterpolationExportActive()).toBe(false);
    });

    it('连续失败 3 次后永久降级，不再取回已弃用的后端', async () => {
        const failing = fakeInterpolator(async () => { throw new Error('gpu lost'); });
        const stage = createInterpolationStage(fakeRuntime(settingsWith(), failing));
        const { controller } = fakeController();
        for (let i = 0; i < 6; i += 1) {
            await stage.push(fakeFrame(i * 16_667), controller);
        }
        stage.flush(controller);
        expect(failing.interpolate.mock.calls.length).toBeLessThanOrEqual(3);
        expect(failing.dispose).toHaveBeenCalled();
        stage.dispose();
    });

    it('dispose 关闭未输出的缓存帧并释放 runtime', async () => {
        const runtime = fakeRuntime(settingsWith(), fakeInterpolator());
        const stage = createInterpolationStage(runtime);
        const { controller } = fakeController();
        const held = fakeFrame(0);
        await stage.push(held, controller);
        stage.dispose();
        expect(held.close).toHaveBeenCalledTimes(1);
        expect(runtime.dispose).toHaveBeenCalledTimes(1);
    });
});
