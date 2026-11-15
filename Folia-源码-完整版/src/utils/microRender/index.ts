// src/utils/microRender/index.ts
// 微渲染引擎 GPU 调度的对外入口。装配层只该从这里 import。

export {
    GPU_BUDGET_TUNING,
    MAX_FRAME_RATE_STEP,
    MAX_PIXEL_RATIO_STEP,
    PIXEL_RATIO_STEPS,
    createGpuBudgetState,
    evaluateGpuBudget,
    minimumFrameRateStep,
    resolveFrameRate,
    stepPixelRatioDown,
    stepPixelRatioUp,
    type GpuBudgetDecision,
    type GpuBudgetInput,
    type GpuBudgetReason,
    type GpuBudgetState,
} from './gpuBudget';

export {
    RENDER_PRIORITY_RANK,
    countActiveGpuClients,
    getActiveRenderClients,
    getTopRenderPriority,
    registerRenderClient,
    subscribeRenderClients,
    type RenderClient,
    type RenderClientKind,
    type RenderLayerPriority,
} from './renderClientRegistry';

export {
    installMicroRenderScheduler,
    setMicroRenderSchedulerEnabled,
    readMicroRenderSchedulerSnapshot,
    type MicroRenderPort,
    type MicroRenderSchedulerOptions,
    type MicroRenderSnapshot,
} from './microRenderScheduler';
