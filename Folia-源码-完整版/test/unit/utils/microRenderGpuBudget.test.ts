import { describe, expect, it } from 'vitest';
import {
    GPU_BUDGET_TUNING,
    createGpuBudgetState,
    evaluateGpuBudget,
    minimumFrameRateStep,
    resolveFrameRate,
    stepPixelRatioDown,
    stepPixelRatioUp,
    type GpuBudgetInput,
    type GpuBudgetState,
} from '../../../src/utils/microRender/gpuBudget';

// 微渲染引擎的决策内核是纯函数，正好可以把「调度器和用户设置打架」「阈值边缘来回跳档」
// 这两类最容易出的事钉死在这里，不用起浏览器环境。

const makeInput = (overrides: Partial<GpuBudgetInput> = {}): GpuBudgetInput => ({
    p90FrameMs: 16,
    slowFrameRatio: 0,
    targetIntervalMs: 16.7,
    userFrameRate: 'off',
    userPixelRatio: null,
    allowPixelRatioScaling: false,
    effectivePixelRatio: 2,
    nativePixelRatio: 2,
    activeLayerCount: 1,
    isPrimaryLayer: true,
    msSinceContextLoss: Number.POSITIVE_INFINITY,
    nowMs: 1000,
    ...overrides,
});

const BAD = { p90FrameMs: 40, slowFrameRatio: 0.6 };
const GOOD = { p90FrameMs: 16, slowFrameRatio: 0 };

const advance = (
    state: GpuBudgetState,
    windows: Array<{ patch?: Partial<GpuBudgetInput>; nowMs: number }>,
) => {
    let current = state;
    let last = evaluateGpuBudget(makeInput(), current);
    for (const window of windows) {
        last = evaluateGpuBudget(makeInput({ ...window.patch, nowMs: window.nowMs }), current);
        current = last.state;
    }
    return last;
};

describe('resolveFrameRate', () => {
    it('用户设定是天花板，降级只会往下不会越过', () => {
        expect(resolveFrameRate('off', 0)).toBe('off');
        expect(resolveFrameRate('off', 1)).toBe(60);
        expect(resolveFrameRate('off', 2)).toBe(30);
        expect(resolveFrameRate(120, 0)).toBe(120);
        expect(resolveFrameRate(120, 1)).toBe(90);
        expect(resolveFrameRate(120, 3)).toBe(30);
        expect(resolveFrameRate(60, 0)).toBe(60);
        expect(resolveFrameRate(60, 1)).toBe(30);
        expect(resolveFrameRate(30, 3)).toBe(30);
    });

    it('级数越界时夹在合法范围', () => {
        expect(resolveFrameRate(90, -5)).toBe(90);
        expect(resolveFrameRate(90, 99)).toBe(30);
    });
});

describe('像素比阶梯', () => {
    it('降档取比生效值小的最大档，到底返回 undefined', () => {
        expect(stepPixelRatioDown(null, 2)).toBe(1.5);
        expect(stepPixelRatioDown(1.5, 1.5)).toBe(1.25);
        expect(stepPixelRatioDown(0.75, 0.75)).toBe(0.5);
        expect(stepPixelRatioDown(0.5, 0.5)).toBeUndefined();
    });

    it('升档接近原生 dpr 时撤掉补丁（返回 null = 跟随屏幕）', () => {
        expect(stepPixelRatioUp(1, 1, null, 2)).toBe(1.25);
        expect(stepPixelRatioUp(1.5, 1.5, null, 2)).toBeNull();
        expect(stepPixelRatioUp(0.75, 0.75, 1, 2)).toBe(1);
    });
});

describe('跨层预算', () => {
    it('只有非主层在多层共存时先让一档', () => {
        expect(minimumFrameRateStep(true, 3)).toBe(0);
        expect(minimumFrameRateStep(false, 1)).toBe(0);
        expect(minimumFrameRateStep(false, 2)).toBe(1);
    });

    it('非主层遇到第二层立刻把帧预算降下来', () => {
        const state = createGpuBudgetState('off', null, 0);
        const decision = evaluateGpuBudget(makeInput({ activeLayerCount: 2, isPrimaryLayer: false }), state);
        expect(decision.reason).toBe('layer-budget');
        expect(decision.frameRate).toBe(60);
        expect(decision.state.frameRateStep).toBe(1);
    });
});

describe('evaluateGpuBudget 滞回与冷却', () => {
    it('单个坏窗口不降，连续两个才降一档', () => {
        let state = createGpuBudgetState('off', null, 0);
        const first = evaluateGpuBudget(makeInput({ ...BAD, nowMs: 1000 }), state);
        expect(first.reason).toBe('none');
        expect(first.frameRate).toBe('off');
        state = first.state;
        const second = evaluateGpuBudget(makeInput({ ...BAD, nowMs: 2000 }), state);
        expect(second.reason).toBe('degrade-frame-rate');
        expect(second.frameRate).toBe(60);
    });

    it('中性窗口不清零已累计的证据', () => {
        let state = createGpuBudgetState('off', null, 0);
        state = evaluateGpuBudget(makeInput({ ...BAD, nowMs: 1000 }), state).state;
        // 既不坏也不好：p90 落在 1.1x ~ 1.5x 之间
        state = evaluateGpuBudget(makeInput({ p90FrameMs: 22, slowFrameRatio: 0.1, nowMs: 1500 }), state).state;
        expect(state.badWindows).toBe(1);
        const next = evaluateGpuBudget(makeInput({ ...BAD, nowMs: 2000 }), state);
        expect(next.reason).toBe('degrade-frame-rate');
    });

    it('变更后的冷却期内不连降，冷却过了才继续', () => {
        let state = createGpuBudgetState('off', null, 0);
        state = evaluateGpuBudget(makeInput({ ...BAD, nowMs: 1000 }), state).state;
        state = evaluateGpuBudget(makeInput({ ...BAD, nowMs: 2000 }), state).state;
        expect(state.frameRateStep).toBe(1);
        const cooled = evaluateGpuBudget(makeInput({ ...BAD, nowMs: 2100 }), state);
        expect(cooled.reason).toBe('cooldown');
        expect(cooled.state.frameRateStep).toBe(1);
        // 冷却期内坏窗口继续累计，冷却一结束立刻降下一档
        const after = evaluateGpuBudget(makeInput({ ...BAD, nowMs: 2000 + GPU_BUDGET_TUNING.changeCooldownMs }), cooled.state);
        expect(after.reason).toBe('degrade-frame-rate');
        expect(after.state.frameRateStep).toBe(2);
    });

    it('连续好窗口才回升，且回到用户基准就停', () => {
        let state = createGpuBudgetState('off', null, 0);
        state = evaluateGpuBudget(makeInput({ ...BAD, nowMs: 1000 }), state).state;
        state = evaluateGpuBudget(makeInput({ ...BAD, nowMs: 2000 }), state).state;
        const windows = Array.from({ length: 5 }, (_, index) => ({ patch: GOOD, nowMs: 6000 + index * 1000 }));
        const almost = advance(state, windows);
        expect(almost.reason).toBe('none');
        expect(almost.frameRate).toBe(60);
        const restored = evaluateGpuBudget(makeInput({ ...GOOD, nowMs: 11000 }), almost.state);
        expect(restored.reason).toBe('restore-frame-rate');
        expect(restored.frameRate).toBe('off');
        expect(restored.state.frameRateStep).toBe(0);
    });

    it('上下文丢失保持期内锁住回升', () => {
        let state = createGpuBudgetState('off', null, 0);
        state = evaluateGpuBudget(makeInput({ ...BAD, nowMs: 1000 }), state).state;
        state = evaluateGpuBudget(makeInput({ ...BAD, nowMs: 2000 }), state).state;
        const windows = Array.from({ length: 6 }, (_, index) => ({
            patch: { ...GOOD, msSinceContextLoss: 1000 },
            nowMs: 6000 + index * 1000,
        }));
        const held = advance(state, windows);
        expect(held.reason).toBe('none');
        expect(held.frameRate).toBe(60);
    });
});

describe('用户设置优先', () => {
    it('用户手选 60fps 时不会降到 90/120，也不会升过 60', () => {
        let state = createGpuBudgetState(60, null, 0);
        const input = (patch: Partial<GpuBudgetInput>, nowMs: number) => makeInput({ ...patch, userFrameRate: 60, nowMs });
        state = evaluateGpuBudget(input(BAD, 1000), state).state;
        const degraded = evaluateGpuBudget(input(BAD, 2000), state);
        expect(degraded.frameRate).toBe(30);
        state = degraded.state;
        // 帧率已见底，且没开自动分辨率，只能维持
        const stuck = evaluateGpuBudget(input(BAD, 2000 + GPU_BUDGET_TUNING.changeCooldownMs), state);
        expect(stuck.frameRate).toBe(30);
        expect(stuck.pixelRatio).toBeNull();
        // 回升终点是用户设的 60
        const windows = Array.from({ length: 6 }, (_, index) => ({ nowMs: 10000 + index * 1000 }));
        const restored = advance(stuck.state, windows.map(w => ({ ...w, patch: { ...GOOD, userFrameRate: 60 as const } })));
        expect(restored.frameRate).toBe(60);
    });

    it('用户中途改档位会重建状态并落回用户档', () => {
        let state = createGpuBudgetState('off', null, 0);
        state = evaluateGpuBudget(makeInput({ ...BAD, nowMs: 1000 }), state).state;
        state = evaluateGpuBudget(makeInput({ ...BAD, nowMs: 2000 }), state).state;
        expect(state.frameRateStep).toBe(1);
        const changed = evaluateGpuBudget(makeInput({ ...GOOD, userFrameRate: 60, nowMs: 3000 }), state);
        expect(changed.frameRate).toBe(60);
        expect(changed.state.frameRateStep).toBe(0);
        expect(changed.state.userFrameRate).toBe(60);
    });

    it('没开自动分辨率时任何情况都不动像素比', () => {
        const state = createGpuBudgetState(30, 1, 0);
        const decision = evaluateGpuBudget(makeInput({
            ...BAD,
            userFrameRate: 30,
            userPixelRatio: 1,
            effectivePixelRatio: 1,
            nowMs: 1000,
        }), state);
        expect(decision.pixelRatio).toBe(1);
    });
});

describe('自动分辨率缩放', () => {
    it('帧率见底后才动分辨率，且降档顺序先帧率', () => {
        let state = createGpuBudgetState(30, null, 0);
        const input = (patch: Partial<GpuBudgetInput>, nowMs: number) => makeInput({
            ...patch,
            userFrameRate: 30,
            allowPixelRatioScaling: true,
            effectivePixelRatio: 2,
            nativePixelRatio: 2,
            nowMs,
        });
        state = evaluateGpuBudget(input(BAD, 1000), state).state;
        const decision = evaluateGpuBudget(input(BAD, 2000), state);
        expect(decision.reason).toBe('degrade-pixel-ratio');
        expect(decision.pixelRatio).toBe(1.5);
        expect(decision.frameRate).toBe(30);
    });

    it('分辨率变更有更长的冷却', () => {
        const state = createGpuBudgetState(30, null, 2000);
        const withRecentRatioChange: GpuBudgetState = {
            ...state,
            badWindows: GPU_BUDGET_TUNING.badWindowsToDegrade,
            lastPixelRatioChangeAtMs: 1500,
            lastChangeAtMs: 0,
        };
        const decision = evaluateGpuBudget(makeInput({
            ...BAD,
            userFrameRate: 30,
            allowPixelRatioScaling: true,
            effectivePixelRatio: 2,
            nativePixelRatio: 2,
            nowMs: 3000,
        }), withRecentRatioChange);
        expect(decision.reason).toBe('none');
        expect(decision.pixelRatio).toBeNull();
    });
});
