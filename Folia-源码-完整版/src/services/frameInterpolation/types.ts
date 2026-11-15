// src/services/frameInterpolation/types.ts
//
// 与模型无关的补帧契约。RIFE 与 IFRNet 的输入语义一致（两张 RGB 帧 → 一张中间帧），
// 差别只在 ONNX 导出时输入张量的名字/排布和是否带 timestep。把差异收进 OnnxModelSpec，
// 上层只认 FrameInterpolator —— 这样「都兼容」是接口层兼容，而不是运行时同时跑两个模型。

/** 实际启用的后端。passthrough = 不补帧，行为与原导出链路完全一致。 */
export type InterpolationBackendId = 'passthrough' | 'blend' | 'onnx';

export type InterpolationModelId = 'rife' | 'ifrnet';

/** 每对相邻帧之间插入 multiplier-1 个中间帧。 */
export type InterpolationMultiplier = 2 | 4 | 8;

export type InterpolationRequest = {
    prev: VideoFrame;
    next: VideoFrame;
    /** 要生成的中间帧显示时间戳（微秒），严格落在 (prev, next) 内。 */
    timestampsUs: number[];
    width: number;
    height: number;
    /** 中间帧的 duration 提示（微秒）；null 表示交给编码器按 timestamp 推断。 */
    durationUs: number | null;
};

export type FrameInterpolator = {
    readonly id: InterpolationBackendId;
    readonly model: InterpolationModelId | null;
    /** 预热：确认后端可用并实测单次耗时；false 表示工厂应降级。 */
    prepare(): Promise<boolean>;
    interpolate(request: InterpolationRequest): Promise<VideoFrame[]>;
    dispose(): void;
};

/** ONNX 权重的输入张量布局。RIFE 多为 dual + timestep，IFRNet 多为 dual，部分导出是 concat6。 */
export type OnnxModelSpec = {
    model: InterpolationModelId;
    layout: 'dual' | 'concat';
    /** dual: [first, second]；concat: [input]。 */
    inputNames: [string, string] | [string];
    outputName: string;
    /** 可选 timestep 输入名（RIFE 支持任意 t，IFRNet 固定 0.5 可不填）。 */
    timestepName?: string;
    /** 输入归一化系数：RIFE/IFRNet 多为 1（0..1），个别导出为 255 原值域。 */
    inputScale: number;
    /** 卷积下采样要求 H/W 对齐到该倍数。 */
    paddingMultiple: number;
};

export type InterpolationSettings = {
    enabled: boolean;
    multiplier: InterpolationMultiplier;
    model: InterpolationModelId | 'auto';
    /** ONNX 不可用时是否退到帧混合；false 则彻底不补帧。 */
    allowBlendFallback: boolean;
    /** 相邻帧平均绝对差 ≥ 该值视为转场/闪光，跳过补帧；0 关闭检测。 */
    sceneChangeThreshold: number;
    /** 生成一整对相邻帧的所有中间帧的总预算（微秒，≈ 一个帧间隔）。超时跳过该对帧。 */
    frameBudgetUs: number;
    /** ONNX 权重 URL；为空表示不启用神经后端。 */
    modelUrl: string | null;
    modelSpec: OnnxModelSpec | null;
};

export const DEFAULT_RIFE_SPEC: OnnxModelSpec = {
    model: 'rife',
    layout: 'dual',
    inputNames: ['img0', 'img1'],
    outputName: 'output',
    timestepName: 'timestep',
    inputScale: 1,
    paddingMultiple: 32,
};

export const DEFAULT_IFRNET_SPEC: OnnxModelSpec = {
    model: 'ifrnet',
    layout: 'dual',
    inputNames: ['img0', 'img1'],
    outputName: 'output',
    inputScale: 1,
    paddingMultiple: 32,
};

export const DEFAULT_INTERPOLATION_SETTINGS: InterpolationSettings = {
    enabled: false,
    multiplier: 2,
    model: 'auto',
    allowBlendFallback: true,
    sceneChangeThreshold: 52,
    frameBudgetUs: 16_000,
    modelUrl: null,
    modelSpec: null,
};
