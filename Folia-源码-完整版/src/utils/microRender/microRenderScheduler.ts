// src/utils/microRender/microRenderScheduler.ts
//
// 微渲染引擎的装配与运行时。
//
// 项目原本的图形设置是三条互不相干的线：
//   - frameRateLimiter.ts     用户手选的固定帧率上限（30/60/90/120）
//   - renderPixelRatio.ts     用户手选的固定分辨率上限
//   - backgroundRenderGate.ts 退后台一帧不画
// 另外 frameTimingDiagnostics.ts 会实测帧耗时，但那是**开发者选项里的诊断报告**，
// 默认不启动，写出来的 p90 / renderHealth 不驱动任何东西。
//
// 这个调度器把「实测」接成「闭环」：用一条极轻的原生 rAF 采样帧间隔，每秒把 p90 /
// 慢帧占比喂给 gpuBudget.ts 的纯状态机，再由状态机决定要不要把帧率或分辨率往下让一格，
// 负载回来后再逐级还给画面。用户手选的档位始终是天花板，且调度器不写 localStorage、
// 不改 store —— 关掉开关就完整还原成用户原来的设置。
//
// 采样为什么自己写、不复用 frameTimingDiagnostics：那份是 4096 帧环形缓冲 + CPU 探针 +
// 长任务观察者的完整诊断，设计上就该默认关闭；而自动调度要默认开着，只能带一个每秒
// 清空的小数组。两者也不冲突：诊断用原生 rAF，我们同样用原生 rAF（requestUncapped），
// 否则会把「用户自己设的 60fps 上限」误读成掉帧。
//
// 跨 document：主窗口 / 壁纸层 / 桌面歌词 / OBS 源是各自独立的 HTML 入口，各自一套 rAF，
// 谁也不知道别人在画。这里用 BroadcastChannel 做**尽力而为**的层数与优先级交换：
// 支持就互相让一档预算，不支持（部分 WebView / file:// 环境）就自动退化成本 document
// 自调度，功能不缺失。不引入 Electron IPC，避免桌面端和安卓端行为分叉。

import type { RenderPixelRatio, VisualizerFrameRate } from '../../types';
import {
    cancelUncappedAnimationFrame,
    requestUncappedAnimationFrame,
    setGlobalVisualizerFrameRate,
} from '../frameRateLimiter';
import {
    getEffectiveRenderPixelRatio,
    getNativeDevicePixelRatio,
    setGlobalRenderPixelRatio,
} from '../renderPixelRatio';
import { isBackgroundRenderSuspended, subscribeBackgroundRenderSuspended } from '../backgroundRenderGate';
import { isFrameInterpolationExportActive } from '../../services/frameInterpolation/exportGuard';
import {
    GPU_BUDGET_TUNING,
    MAX_FRAME_RATE_STEP,
    createGpuBudgetState,
    evaluateGpuBudget,
    resolveFrameRate,
    type GpuBudgetReason,
    type GpuBudgetState,
} from './gpuBudget';
import {
    RENDER_PRIORITY_RANK,
    countActiveGpuClients,
    type RenderLayerPriority,
} from './renderClientRegistry';

/** 装配层（入口）把 store 的读值与订阅以端口传进来：utils 不反向 import stores。 */
export type MicroRenderPort = {
    isEnabled: () => boolean;
    subscribeEnabled: (listener: (enabled: boolean) => void) => () => void;
    getUserFrameRate: () => VisualizerFrameRate;
    getUserPixelRatio: () => RenderPixelRatio | null;
    allowPixelRatioScaling: () => boolean;
};

export type MicroRenderSchedulerOptions = {
    port: MicroRenderPort;
    /** 本 document 的渲染层身份，决定多层共存时谁先让预算。 */
    layerPriority: RenderLayerPriority;
    /** 壁纸/叠层这类「应用退后台也要照常画」的入口置 true，跳过可见性暂停。 */
    ignoreVisibility?: boolean;
    label?: string;
};

export type MicroRenderSnapshot = {
    installed: boolean;
    running: boolean;
    enabled: boolean;
    frameRate: VisualizerFrameRate;
    pixelRatio: RenderPixelRatio | null;
    frameRateStep: number;
    pixelRatioStep: number;
    activeLayerCount: number;
    gpuClients: number;
    p90FrameMs: number | null;
    displayIntervalMs: number;
    targetIntervalMs: number;
    lastReason: GpuBudgetReason;
    contextLossCount: number;
    crossLayerCoordination: boolean;
};

const CHANNEL_NAME = 'folia.microRender.v1';
const HEARTBEAT_MS = 2000;
const PEER_TIMEOUT_MS = 6000;
const MIN_SAMPLES_PER_WINDOW = 8;

type PeerMessage = {
    type: 'hello' | 'heartbeat' | 'bye';
    id: string;
    priority: RenderLayerPriority;
    ts: number;
};

type Peer = { priority: RenderLayerPriority; seenAtMs: number };

const nowMs = (): number => (
    typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()
);

const layerId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

let installed = false;
let running = false;
let options: MicroRenderSchedulerOptions | null = null;
let state: GpuBudgetState = createGpuBudgetState('off', null);
let appliedFrameRate: VisualizerFrameRate = 'off';
let appliedPixelRatio: RenderPixelRatio | null = null;

let unsubscribeEnabled: (() => void) | null = null;
let unsubscribeBackground: (() => void) | null = null;
let rafHandle: number | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let channel: BroadcastChannel | null = null;
const peers = new Map<string, Peer>();

let intervals: number[] = [];
let windowStartedAtMs = 0;
let lastFrameAtMs: number | null = null;
let displayIntervalMs = 1000 / 60;
let lastP90FrameMs: number | null = null;
let lastTargetIntervalMs = 1000 / 60;
let lastReason: GpuBudgetReason = 'none';
let contextLostAtMs = -Infinity;
let contextLossCount = 0;

const isDevBuild = (): boolean => {
    try {
        return (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
    } catch {
        return false;
    }
};

const log = (...args: unknown[]) => {
    if (isDevBuild()) console.debug(`[MicroRender${options?.label ? `:${options.label}` : ''}]`, ...args);
};

const isPaused = (): boolean => {
    if (isBackgroundRenderSuspended()) return true;
    if (options?.ignoreVisibility) return false;
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
};

const applyFrameRate = (frameRate: VisualizerFrameRate) => {
    if (frameRate === appliedFrameRate) return;
    setGlobalVisualizerFrameRate(frameRate);
    appliedFrameRate = frameRate;
    log('frameRate →', frameRate);
};

const applyPixelRatio = (limit: RenderPixelRatio | null) => {
    if (limit === appliedPixelRatio) return;
    setGlobalRenderPixelRatio(limit);
    appliedPixelRatio = limit;
    log('pixelRatio →', limit);
};

const prunePeers = () => {
    const cutoff = Date.now() - PEER_TIMEOUT_MS;
    for (const [id, peer] of peers) {
        if (peer.seenAtMs < cutoff) peers.delete(id);
    }
};

const activeLayerCount = (): number => {
    prunePeers();
    return 1 + peers.size;
};

const isPrimaryLayer = (): boolean => {
    prunePeers();
    const myRank = RENDER_PRIORITY_RANK[options?.layerPriority ?? 'ambient'];
    return !Array.from(peers.values()).some(peer => RENDER_PRIORITY_RANK[peer.priority] < myRank);
};

const broadcast = (type: PeerMessage['type']) => {
    if (!channel || !options) return;
    const message: PeerMessage = {
        type,
        id: layerId,
        priority: options.layerPriority,
        ts: Date.now(),
    };
    try {
        channel.postMessage(message);
    } catch {
        // 通道在关闭过程中会抛；下一次心跳再来，不影响本层调度。
    }
};

const closeChannel = () => {
    if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (channel) {
        broadcast('bye');
        try {
            channel.close();
        } catch {
            // 已关闭。
        }
        channel = null;
    }
    peers.clear();
};

const openChannel = () => {
    if (typeof BroadcastChannel === 'undefined' || !options) return;
    try {
        channel = new BroadcastChannel(CHANNEL_NAME);
        channel.onmessage = (event: MessageEvent<PeerMessage>) => {
            const message = event.data;
            if (!message || typeof message.id !== 'string' || message.id === layerId) return;
            if (message.type === 'bye') {
                peers.delete(message.id);
                return;
            }
            if (message.type !== 'hello' && message.type !== 'heartbeat') return;
            peers.set(message.id, { priority: message.priority, seenAtMs: Date.now() });
            // 新层加入时立刻回一声，让它不用等一个心跳周期就知道有别人在画。
            if (message.type === 'hello') broadcast('heartbeat');
        };
        broadcast('hello');
        heartbeatTimer = setInterval(() => broadcast('heartbeat'), HEARTBEAT_MS);
    } catch {
        // BroadcastChannel 在部分 WebView / file:// 下不可用：退化为单 document 自调度。
        channel = null;
    }
};

type IntervalStats = {
    p90Ms: number;
    displayIntervalMs: number;
};

const summarizeIntervals = (samples: number[]): IntervalStats | null => {
    if (samples.length < MIN_SAMPLES_PER_WINDOW) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
    const p10 = at(0.1);
    // p10 近似显示刷新间隔：掉帧只会把间隔拉长，最快的那一批帧仍贴着刷新率。
    // 夹在 8..34ms（约 120Hz..30Hz）之间，避免异常值把阈值带跑。
    const observed = Math.min(34, Math.max(8, p10));
    return { p90Ms: at(0.9), displayIntervalMs: observed };
};

const decide = (timestampMs: number) => {
    if (!options) return;
    // 导出补帧与自适应降帧方向相反：前者花算力把帧补密，后者主动丢帧省 GPU。
    // 补帧真正跑起来时冻结决策、保持当前档位；导出结束（guard 归零）后自然恢复采样。
    // 直接引 exportGuard 子模块，不经过 services/frameInterpolation/index，避免任何循环依赖。
    if (isFrameInterpolationExportActive()) return;
    const port = options.port;
    const userFrameRate = port.getUserFrameRate();
    const userPixelRatio = port.getUserPixelRatio();

    const currentRate = resolveFrameRate(state.userFrameRate, state.frameRateStep);
    const targetIntervalMs = currentRate === 'off'
        ? displayIntervalMs
        : Math.max(1000 / currentRate, displayIntervalMs);
    lastTargetIntervalMs = targetIntervalMs;

    const stats = summarizeIntervals(intervals);
    if (stats) {
        // 平滑刷新率估计，避免单窗口抖动改变阈值。
        displayIntervalMs = displayIntervalMs * 0.8 + stats.displayIntervalMs * 0.2;
        lastP90FrameMs = stats.p90Ms;
        const slowFrameRatio = intervals.filter(
            interval => interval > targetIntervalMs * GPU_BUDGET_TUNING.slowP90Factor,
        ).length / intervals.length;

        const decision = evaluateGpuBudget({
            p90FrameMs: stats.p90Ms,
            slowFrameRatio,
            targetIntervalMs,
            userFrameRate,
            userPixelRatio,
            allowPixelRatioScaling: port.allowPixelRatioScaling(),
            effectivePixelRatio: getEffectiveRenderPixelRatio(),
            nativePixelRatio: getNativeDevicePixelRatio(),
            activeLayerCount: activeLayerCount(),
            isPrimaryLayer: isPrimaryLayer(),
            msSinceContextLoss: timestampMs - contextLostAtMs,
            nowMs: timestampMs,
        }, state);

        state = decision.state;
        lastReason = decision.reason;
        applyFrameRate(decision.frameRate);
        applyPixelRatio(decision.pixelRatio);
    }
};

const onFrame = (timestampMs: number) => {
    rafHandle = null;
    if (!running) return;

    if (lastFrameAtMs !== null) {
        const delta = timestampMs - lastFrameAtMs;
        if (delta > GPU_BUDGET_TUNING.maxFrameIntervalMs) {
            // 切后台 / 主线程长挂起：这一段的间隔不是渲染开销，整个窗口作废重开。
            intervals = [];
            windowStartedAtMs = timestampMs;
        } else if (delta > 0) {
            intervals.push(delta);
        }
    }
    lastFrameAtMs = timestampMs;
    if (windowStartedAtMs === 0) windowStartedAtMs = timestampMs;

    if (timestampMs - windowStartedAtMs >= GPU_BUDGET_TUNING.sampleWindowMs) {
        decide(timestampMs);
        intervals = [];
        windowStartedAtMs = timestampMs;
    }

    scheduleNext();
};

const scheduleNext = () => {
    if (!running || rafHandle !== null || isPaused()) return;
    rafHandle = requestUncappedAnimationFrame(onFrame);
};

const pauseLoop = () => {
    if (rafHandle !== null) {
        cancelUncappedAnimationFrame(rafHandle);
        rafHandle = null;
    }
    intervals = [];
    lastFrameAtMs = null;
    windowStartedAtMs = 0;
};

const resumeLoop = () => {
    if (!running || isPaused()) return;
    lastFrameAtMs = null;
    windowStartedAtMs = 0;
    scheduleNext();
};

/** 上下文丢失：立刻让出一档帧预算，并在保持期内锁住回升。 */
const onContextLost = () => {
    if (!running) return;
    contextLossCount += 1;
    contextLostAtMs = nowMs();
    const nextStep = Math.min(state.frameRateStep + 1, MAX_FRAME_RATE_STEP);
    const nextRate = resolveFrameRate(state.userFrameRate, nextStep);
    if (nextRate !== resolveFrameRate(state.userFrameRate, state.frameRateStep)) {
        state = {
            ...state,
            frameRateStep: nextStep,
            badWindows: 0,
            goodWindows: 0,
            lastChangeAtMs: contextLostAtMs,
        };
        lastReason = 'degrade-frame-rate';
        applyFrameRate(nextRate);
    }
    // 不调 preventDefault()：能不能恢复是 canvas 所有者（各引擎）的决定，越权会破坏
    // 它们自己的上下文重建流程。这里只负责把 GPU 预算降下来、给恢复留出余量。
    log('webglcontextlost, budget →', nextRate);
};

const onVisibilityChange = () => {
    if (isPaused()) pauseLoop();
    else resumeLoop();
};

const enable = () => {
    if (running || !options) return;
    running = true;
    const port = options.port;
    state = createGpuBudgetState(port.getUserFrameRate(), port.getUserPixelRatio(), nowMs());
    // 装配层已经按用户设置装好 limiter / 像素比补丁，这里只接管基线，不重复应用一次。
    appliedFrameRate = port.getUserFrameRate();
    appliedPixelRatio = port.getUserPixelRatio();
    lastReason = 'none';
    contextLostAtMs = -Infinity;
    intervals = [];
    lastFrameAtMs = null;
    windowStartedAtMs = 0;
    lastP90FrameMs = null;

    if (typeof window !== 'undefined') {
        window.addEventListener('webglcontextlost', onContextLost as EventListener, true);
        window.addEventListener('visibilitychange', onVisibilityChange);
    }
    openChannel();
    resumeLoop();
    log('enabled, layer =', options.layerPriority);
};

const disable = () => {
    if (!running || !options) return;
    running = false;
    pauseLoop();
    closeChannel();
    if (typeof window !== 'undefined') {
        window.removeEventListener('webglcontextlost', onContextLost as EventListener, true);
        window.removeEventListener('visibilitychange', onVisibilityChange);
    }
    // 把调度期间改过的档位完整还给用户设置，不留残留状态。
    const port = options.port;
    applyFrameRate(port.getUserFrameRate());
    applyPixelRatio(port.getUserPixelRatio());
    state = createGpuBudgetState(port.getUserFrameRate(), port.getUserPixelRatio(), nowMs());
    lastReason = 'none';
    log('disabled, user budget restored');
};

/**
 * 每个 HTML 入口调一次。幂等：重复调用不会装第二条采样循环。
 *
 * 必须装在 installGlobalVisualizerFrameRateLimiter / installRenderPixelRatioLimit **之后**：
 * 调度器用 requestUncappedAnimationFrame 取原生 rAF，那个句柄是限帧器安装时收好的。
 */
export const installMicroRenderScheduler = (nextOptions: MicroRenderSchedulerOptions): void => {
    if (typeof window === 'undefined' || installed) return;
    installed = true;
    options = nextOptions;
    state = createGpuBudgetState(
        nextOptions.port.getUserFrameRate(),
        nextOptions.port.getUserPixelRatio(),
        nowMs(),
    );
    appliedFrameRate = nextOptions.port.getUserFrameRate();
    appliedPixelRatio = nextOptions.port.getUserPixelRatio();

    unsubscribeBackground = subscribeBackgroundRenderSuspended(() => onVisibilityChange());
    unsubscribeEnabled = nextOptions.port.subscribeEnabled(enabled => {
        if (enabled) enable();
        else disable();
    });

    if (nextOptions.port.isEnabled()) enable();
};

/** 运行时手动覆盖（调试用；不写 store，下次订阅回调来时以 store 为准）。 */
export const setMicroRenderSchedulerEnabled = (enabled: boolean): void => {
    if (!installed) return;
    if (enabled) enable();
    else disable();
};

/** 供调试面板 / 文档核对当前状态；不参与决策。 */
export const readMicroRenderSchedulerSnapshot = (): MicroRenderSnapshot => ({
    installed,
    running,
    enabled: options?.port.isEnabled() ?? false,
    frameRate: appliedFrameRate,
    pixelRatio: appliedPixelRatio,
    frameRateStep: state.frameRateStep,
    pixelRatioStep: state.pixelRatioStep,
    activeLayerCount: activeLayerCount(),
    gpuClients: countActiveGpuClients(),
    p90FrameMs: lastP90FrameMs,
    displayIntervalMs,
    targetIntervalMs: lastTargetIntervalMs,
    lastReason,
    contextLossCount,
    crossLayerCoordination: channel !== null,
});

/** 测试与热重载用：彻底拆掉监听，之后可以重新 install。 */
export const teardownMicroRenderScheduler = (): void => {
    disable();
    unsubscribeEnabled?.();
    unsubscribeEnabled = null;
    unsubscribeBackground?.();
    unsubscribeBackground = null;
    installed = false;
    options = null;
};
