// src/services/frameInterpolation/index.ts
// 导出补帧层公共出口。渲染引擎不 import 这里 —— 只有视频导出帧流会用。

export { BlendFrameInterpolator, sampleFrameDifference } from './blendInterpolator';
export { createExportInterpolationRuntime, type InterpolationRuntime, type RuntimeProbe } from './capabilities';
export {
    beginFrameInterpolationExport,
    endFrameInterpolationExport,
    isFrameInterpolationExportActive,
} from './exportGuard';
export {
    chooseBackend,
    clampMultiplier,
    intermediateDuration,
    intermediateTimestamps,
    meanAbsoluteDifference,
    padToMultiple,
    shouldSkipForSceneChange,
    type BackendChoice,
    type CapabilityProbe,
} from './frameMath';
export { OnnxFrameInterpolator, type OnnxInterpolatorOptions } from './onnxInterpolator';
export { createInterpolationStage, type InterpolationStage } from './stage';
export {
    DEFAULT_IFRNET_SPEC,
    DEFAULT_INTERPOLATION_SETTINGS,
    DEFAULT_RIFE_SPEC,
    type FrameInterpolator,
    type InterpolationBackendId,
    type InterpolationModelId,
    type InterpolationMultiplier,
    type InterpolationRequest,
    type InterpolationSettings,
    type OnnxModelSpec,
} from './types';
