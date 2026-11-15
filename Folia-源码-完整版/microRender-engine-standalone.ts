/**
 * microRender 渲染微引擎 · 独立版（零依赖）
 * ============================================================
 *
 * 来源：Folia (folia-major) 0.7.25 的 `src/utils/microRender/gpuBudget.ts`
 * 性质：纯算法内核抽取，不依赖任何 DOM / rAF / 项目内部类型。
 *
 * 这一层只回答一个问题：
 *   「给最近一秒的帧健康数据（p90 帧间隔 + 慢帧占比），档位该往哪边动一格？」
 *
 * 它不管采样、不管跨窗口协调、不管把决策落到具体的帧率/分辨率总闸上 ——
 * 那些是 microRenderScheduler（运行时）的事。这里只做纯函数状态机决策，
 * 因此可以被单测钉死、也可以直接嵌进任何渲染引擎。
 *
 * 设计要点（与原项目一致）：
 *  1. 用户设定永远是「天花板」：只会向下让预算，回升也只回到用户设的那一档。
 *  2. 降档顺序：先帧率、后分辨率（改帧率不触发 resize，改像素比会整页重排）。升档逆序。
 *  3. 滞回 + 冷却：连续多个坏窗口才降、连续更多好窗口才升，每次变更后留冷却期，
 *     避免在阈值边缘抖动（抖一次就是一次全页 resize）。
 *
 * 可调参数全部集中在 GPU_BUDGET_TUNING，按真机表现收紧或放宽即可。
 */

// ───────────────────────── 内联类型（原项目 src/types.ts 抽取） ─────────────────────────

/** 帧率档位。'off' 表示不限帧。 */
export type VisualizerFrameRate = 'off' | 120 | 90 | 60 | 30;

/** 渲染分辨率上限（像素比）。注意：null 表示「跟随屏幕」，是基准而非某一档。 */
export type RenderPixelRatio = 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2;

// ───────────────────────── 阶梯定义 ─────────────────────────

/**
 * 降档路径：用户设定决定起点，级数只是「相对用户基准往下让了几格」。
 * 索引 0 = 用户原档；索引越大越低；到顶后重复最低档（不会无限降）。
 */
const FRAME_RATE_STEPS: Record<VisualizerFrameRate, readonly VisualizerFrameRate[]> = {
    off: ['off', 60, 30, 30],
    120: [120, 90, 60, 30],
    90: [90, 60, 30, 30],
    60: [60, 30, 30, 30],
    30: [30, 30, 30, 30],
};

/** 最大降级级数；再往下降也没有更低的帧率档了。 */
export const MAX_FRAME_RATE_STEP = 3;
export const MAX_PIXEL_RATIO_STEP = 3;

/** 分辨率阶梯，降序。null 不在里面：null 表示「跟随屏幕」，是基准而非某一档。 */
export const PIXEL_RATIO_STEPS: readonly RenderPixelRatio[] = [2, 1.5, 1.25, 1, 0.75, 0.5] as const;

/** 可调参数集中在这里，方便按真机表现收紧或放宽。 */
export const GPU_BUDGET_TUNING = {
    /** p90 帧间隔超过期望间隔的几倍，算这个窗口「画不动」。 */
    slowP90Factor: 1.5,
    /** 或者慢帧占比超过这个比例。 */
    slowFrameRatio: 0.25,
    /** 回升要求 p90 贴着期望间隔走。 */
    healthyP90Factor: 1.1,
    healthySlowRatio: 0.08,
    /** 连续几个坏窗口才降一档 / 连续几个好窗口才升一档。 */
    badWindowsToDegrade: 2,
    goodWindowsToRestore: 6,
    /** 每次变更后的冷却，期间不再次变更（但坏窗口继续累计）。 */
    changeCooldownMs: 2500,
    /** 改分辨率会广播 resize 触发整页重排，冷却更长。 */
    pixelRatioChangeCooldownMs: 8000,
    /** 上下文丢失后这段时间内只允许降、不允许升。 */
    contextLossHoldMs: 8000,
    /** 采样窗口长度。 */
    sampleWindowMs: 1000,
    /** 超过这个间隔必然是切后台/挂起，不计入帧健康。 */
    maxFrameIntervalMs: 250,
} as const;

// ───────────────────────── 折算工具 ─────────────────────────

/** 把用户基准 + 降级级数折算成实际帧率档。 */
export const resolveFrameRate = (user: VisualizerFrameRate, step: number): VisualizerFrameRate => {
    const ladder = FRAME_RATE_STEPS[user];
    const index = Math.min(Math.max(Math.trunc(step), 0), MAX_FRAME_RATE_STEP);
    return ladder[index];
};

/** 降一档分辨率：取阶梯里比当前生效值小的最大档；到底了返回 undefined。 */
export const stepPixelRatioDown = (
    current: RenderPixelRatio | null,
    effectivePixelRatio: number,
): RenderPixelRatio | undefined => {
    const base = current ?? effectivePixelRatio;
    return PIXEL_RATIO_STEPS.find(step => step < base - 0.01);
};

/**
 * 升一档分辨率。返回 `null` 表示「回到跟随屏幕」（用户没设上限时的基准）。
 * `native` 是真实 dpr：用户没设上限时，升到接近原生值就该把上限整个撤掉，
 * 而不是继续挂着一个没必要的上限。
 */
export const stepPixelRatioUp = (
    current: RenderPixelRatio | null,
    effectivePixelRatio: number,
    user: RenderPixelRatio | null,
    native: number,
): RenderPixelRatio | null => {
    if (current === null) return null;
    const ceiling = user ?? native;
    const ascending = [...PIXEL_RATIO_STEPS].sort((a, b) => a - b);
    const next = ascending.find(step => step > effectivePixelRatio + 0.01);
    if (next === undefined || next >= ceiling - 0.01) return user;
    return next;
};

// ───────────────────────── 状态与决策类型 ─────────────────────────

export type GpuBudgetState = {
    /** 记录的用户基准，用来发现「用户刚改了设置」并重建状态。 */
    userFrameRate: VisualizerFrameRate;
    userPixelRatio: RenderPixelRatio | null;
    frameRateStep: number;
    pixelRatioStep: number;
    /** 当前生效的分辨率上限；null = 跟随屏幕。 */
    pixelRatio: RenderPixelRatio | null;
    badWindows: number;
    goodWindows: number;
    lastChangeAtMs: number;
    lastPixelRatioChangeAtMs: number;
};

export type GpuBudgetInput = {
    /** 采样窗口的 p90 帧间隔（ms）。 */
    p90FrameMs: number;
    /** 采样窗口内慢帧占比 0..1。 */
    slowFrameRatio: number;
    /** 当前档位的期望帧间隔（ms）。 */
    targetIntervalMs: number;
    userFrameRate: VisualizerFrameRate;
    userPixelRatio: RenderPixelRatio | null;
    allowPixelRatioScaling: boolean;
    /** 当前实际生效的像素比（已夹过）。 */
    effectivePixelRatio: number;
    nativePixelRatio: number;
    /** 含自身在内的活跃渲染层数。 */
    activeLayerCount: number;
    /** 本层是否为主渲染层；多层共存时非主层先让一档预算。 */
    isPrimaryLayer: boolean;
    /** 距上次 webglcontextlost 的毫秒数；Infinity 表示没丢过。 */
    msSinceContextLoss: number;
    nowMs: number;
};

export type GpuBudgetReason =
    | 'none'
    | 'cooldown'
    | 'layer-budget'
    | 'degrade-frame-rate'
    | 'degrade-pixel-ratio'
    | 'restore-frame-rate'
    | 'restore-pixel-ratio';

export type GpuBudgetDecision = {
    frameRate: VisualizerFrameRate;
    pixelRatio: RenderPixelRatio | null;
    state: GpuBudgetState;
    reason: GpuBudgetReason;
};

// ───────────────────────── 状态机构建与推进 ─────────────────────────

export const createGpuBudgetState = (
    userFrameRate: VisualizerFrameRate,
    userPixelRatio: RenderPixelRatio | null,
    nowMs = 0,
): GpuBudgetState => ({
    userFrameRate,
    userPixelRatio,
    frameRateStep: 0,
    pixelRatioStep: 0,
    pixelRatio: userPixelRatio,
    badWindows: 0,
    goodWindows: 0,
    lastChangeAtMs: nowMs - GPU_BUDGET_TUNING.changeCooldownMs,
    lastPixelRatioChangeAtMs: nowMs - GPU_BUDGET_TUNING.pixelRatioChangeCooldownMs,
});

/**
 * 非主层在多个渲染 document 同时活跃时，至少让出一档帧预算。
 * 主窗口与壁纸/歌词叠层都是独立 document、各自一套 rAF，互不感知就会同时满帧抢同一块 GPU。
 */
export const minimumFrameRateStep = (isPrimaryLayer: boolean, activeLayerCount: number): number => (
    !isPrimaryLayer && activeLayerCount > 1 ? 1 : 0
);

/**
 * 状态机主体：一个采样窗口推进一次。
 *
 * 推进逻辑（与原项目逐行一致）：
 *  1. 用户刚改设置 → 旧状态失效，按新基准重建并落回用户档位。
 *  2. 非主层且多层共存 → 至少让一档帧预算（layer-budget）。
 *  3. 计算坏/好窗口，中性窗口不清零已累计证据。
 *  4. 冷却期内只累计不决策（cooldown）。
 *  5. 坏窗口达标 → 先降帧率，帧率见底才降分辨率。
 *  6. 好窗口达标（且非上下文丢失保持期）→ 先升分辨率，再升帧率（逆序）。
 */
export const evaluateGpuBudget = (input: GpuBudgetInput, state: GpuBudgetState): GpuBudgetDecision => {
    const tuning = GPU_BUDGET_TUNING;
    const commit = (
        next: Partial<GpuBudgetState>,
        reason: GpuBudgetReason,
    ): GpuBudgetDecision => {
        const nextState: GpuBudgetState = {
            ...state,
            ...next,
            badWindows: 0,
            goodWindows: 0,
            lastChangeAtMs: input.nowMs,
        };
        return {
            frameRate: resolveFrameRate(nextState.userFrameRate, nextState.frameRateStep),
            pixelRatio: nextState.pixelRatio,
            state: nextState,
            reason,
        };
    };

    // 用户刚改过设置：基准变了，旧状态没有意义，直接按新基准重建并落回用户档位。
    if (state.userFrameRate !== input.userFrameRate || state.userPixelRatio !== input.userPixelRatio) {
        const fresh = createGpuBudgetState(input.userFrameRate, input.userPixelRatio, input.nowMs);
        return {
            frameRate: input.userFrameRate,
            pixelRatio: input.userPixelRatio,
            state: fresh,
            reason: 'none',
        };
    }

    const minStep = minimumFrameRateStep(input.isPrimaryLayer, input.activeLayerCount);
    if (state.frameRateStep < minStep && resolveFrameRate(input.userFrameRate, minStep) !== resolveFrameRate(input.userFrameRate, state.frameRateStep)) {
        return commit({ frameRateStep: minStep }, 'layer-budget');
    }

    const bad = input.p90FrameMs > input.targetIntervalMs * tuning.slowP90Factor
        || input.slowFrameRatio > tuning.slowFrameRatio;
    const good = !bad
        && input.p90FrameMs < input.targetIntervalMs * tuning.healthyP90Factor
        && input.slowFrameRatio < tuning.healthySlowRatio;

    // 中性窗口保持计数，不清零也不累加：偶发的一帧抖动不该把攒了半天的证据抹掉。
    const badWindows = bad ? state.badWindows + 1 : (good ? 0 : state.badWindows);
    const goodWindows = good ? state.goodWindows + 1 : (bad ? 0 : state.goodWindows);
    const counted: GpuBudgetState = { ...state, badWindows, goodWindows };

    const cooled = input.nowMs - state.lastChangeAtMs >= tuning.changeCooldownMs;
    const pixelRatioCooled = input.nowMs - state.lastPixelRatioChangeAtMs >= tuning.pixelRatioChangeCooldownMs;
    const contextHold = input.msSinceContextLoss < tuning.contextLossHoldMs;

    const unchanged = (reason: GpuBudgetReason): GpuBudgetDecision => ({
        frameRate: resolveFrameRate(state.userFrameRate, state.frameRateStep),
        pixelRatio: state.pixelRatio,
        state: counted,
        reason,
    });

    if (!cooled) return unchanged('cooldown');

    // 降档：先帧率，帧率见底了才动分辨率。
    if (badWindows >= tuning.badWindowsToDegrade) {
        const nextStep = state.frameRateStep + 1;
        if (nextStep <= MAX_FRAME_RATE_STEP
            && resolveFrameRate(input.userFrameRate, nextStep) !== resolveFrameRate(input.userFrameRate, state.frameRateStep)) {
            return commit({ frameRateStep: nextStep }, 'degrade-frame-rate');
        }
        if (input.allowPixelRatioScaling && pixelRatioCooled && state.pixelRatioStep < MAX_PIXEL_RATIO_STEP) {
            const nextRatio = stepPixelRatioDown(state.pixelRatio, input.effectivePixelRatio);
            if (nextRatio !== undefined) {
                return commit({
                    pixelRatio: nextRatio,
                    pixelRatioStep: state.pixelRatioStep + 1,
                    lastPixelRatioChangeAtMs: input.nowMs,
                }, 'degrade-pixel-ratio');
            }
        }
    }

    // 升档：逆序，先恢复分辨率再恢复帧率；上下文丢失保持期内不升。
    if (goodWindows >= tuning.goodWindowsToRestore && !contextHold) {
        if (input.allowPixelRatioScaling && pixelRatioCooled && state.pixelRatioStep > 0) {
            const nextStep = state.pixelRatioStep - 1;
            const nextRatio = nextStep === 0
                ? input.userPixelRatio
                : stepPixelRatioUp(state.pixelRatio, input.effectivePixelRatio, input.userPixelRatio, input.nativePixelRatio);
            return commit({
                pixelRatio: nextRatio,
                pixelRatioStep: nextStep,
                lastPixelRatioChangeAtMs: input.nowMs,
            }, 'restore-pixel-ratio');
        }
        const nextStep = state.frameRateStep - 1;
        if (nextStep >= minStep
            && resolveFrameRate(input.userFrameRate, nextStep) !== resolveFrameRate(input.userFrameRate, state.frameRateStep)) {
            return commit({ frameRateStep: nextStep }, 'restore-frame-rate');
        }
    }

    return unchanged('none');
};

// ───────────────────────── 自助验证（仅当以 node 直接执行时运行） ─────────────────────────

/**
 * 一段纯逻辑自检，证明内核行为正确，且本文件零依赖、可直接运行：
 *   node --experimental-strip-types microRender-engine-standalone.ts   （Node 22+）
 * 或在任意 TS 工程里 import 后调用 runSelfTest()。
 */
export function runSelfTest(): { pass: boolean; cases: { name: string; ok: boolean; detail: string }[] } {
    const cases: { name: string; ok: boolean; detail: string }[] = [];
    const assert = (name: string, cond: boolean, detail = '') => cases.push({ name, ok: cond, detail });

    // 1. 单坏窗口不降档（滞回）
    const s0 = createGpuBudgetState(60, null, 0);
    let st = s0;
    let d = evaluateGpuBudget({
        p90FrameMs: 100, slowFrameRatio: 0.9, targetIntervalMs: 16.7,
        userFrameRate: 60, userPixelRatio: null, allowPixelRatioScaling: false,
        effectivePixelRatio: 1, nativePixelRatio: 2, activeLayerCount: 1,
        isPrimaryLayer: true, msSinceContextLoss: Infinity, nowMs: 5000,
    }, st);
    st = d.state;
    assert('单坏窗口不降档', d.reason === 'cooldown' || d.frameRate === 60, `frameRate=${d.frameRate}`);

    // 2. 连续两个坏窗口才降一档（60 → 30）
    d = evaluateGpuBudget({
        p90FrameMs: 100, slowFrameRatio: 0.9, targetIntervalMs: 16.7,
        userFrameRate: 60, userPixelRatio: null, allowPixelRatioScaling: false,
        effectivePixelRatio: 1, nativePixelRatio: 2, activeLayerCount: 1,
        isPrimaryLayer: true, msSinceContextLoss: Infinity, nowMs: 8000,
    }, st);
    st = d.state;
    assert('连续两坏窗降一档', d.frameRate === 30, `frameRate=${d.frameRate} reason=${d.reason}`);

    // 3. 用户设定是天花板：用户设 30 时不会升到 60
    const sLow = createGpuBudgetState(30, null, 0);
    let stLow = sLow;
    for (let i = 0; i < 8; i++) {
        stLow = evaluateGpuBudget({
            p90FrameMs: 15, slowFrameRatio: 0.0, targetIntervalMs: 33.3,
            userFrameRate: 30, userPixelRatio: null, allowPixelRatioScaling: false,
            effectivePixelRatio: 1, nativePixelRatio: 2, activeLayerCount: 1,
            isPrimaryLayer: true, msSinceContextLoss: Infinity, nowMs: (i + 1) * 10000,
        }, stLow).state;
    }
    assert('用户30档不升破天花板', stLow.frameRateStep === 0, `frameRateStep=${stLow.frameRateStep}`);

    // 4. 非主层且多层共存 → 至少让一档
    const s1 = createGpuBudgetState(120, null, 0);
    const d1 = evaluateGpuBudget({
        p90FrameMs: 16, slowFrameRatio: 0.0, targetIntervalMs: 8.3,
        userFrameRate: 120, userPixelRatio: null, allowPixelRatioScaling: false,
        effectivePixelRatio: 1, nativePixelRatio: 2, activeLayerCount: 2,
        isPrimaryLayer: false, msSinceContextLoss: Infinity, nowMs: 5000,
    }, s1);
    assert('非主层多层让一档(120→90)', d1.frameRate === 90, `frameRate=${d1.frameRate}`);

    // 5. 用户改设置 → 状态重建落回用户档
    const s2 = { ...createGpuBudgetState(60, null, 0), frameRateStep: 3 };
    const d2 = evaluateGpuBudget({
        p90FrameMs: 16, slowFrameRatio: 0.0, targetIntervalMs: 16.7,
        userFrameRate: 90, userPixelRatio: null, allowPixelRatioScaling: false,
        effectivePixelRatio: 1, nativePixelRatio: 2, activeLayerCount: 1,
        isPrimaryLayer: true, msSinceContextLoss: Infinity, nowMs: 5000,
    }, s2);
    assert('用户改档重建状态', d2.frameRate === 90 && d2.state.frameRateStep === 0, `frameRate=${d2.frameRate} step=${d2.state.frameRateStep}`);

    const pass = cases.every(c => c.ok);
    return { pass, cases };
}

// 仅在被直接执行时跑自检（支持 ESM + CJS 两种入口判断）。
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].includes('microRender-engine-standalone')) {
    const r = runSelfTest();
    for (const c of r.cases) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`);
    console.log(r.pass ? '\n✅ 全部通过' : '\n❌ 存在失败');
    if (!r.pass) process.exit(1);
}
