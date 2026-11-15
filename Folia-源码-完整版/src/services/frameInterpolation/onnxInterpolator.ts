// src/services/frameInterpolation/onnxInterpolator.ts
//
// RIFE / IFRNet 共用的 ONNX Runtime Web 后端。两者输入语义一致，差异全部由 OnnxModelSpec
// 描述（dual / concat、是否带 timestep、归一化系数、padding 倍数），所以只维护一套推理代码。
//
// 这个包是**可选运行时**：项目默认不安装 onnxruntime-web，也不打包 20MB 权重。
// 想启用时：① 安装依赖 ② 在设置里填权重 URL（或放进 IndexedDB 缓存）③ 打开导出补帧开关。
// 任何一环缺失，capabilities.ts 都会自动降级到 blend / passthrough，导出链路不受影响。

import { padToMultiple } from './frameMath';
import type { FrameInterpolator, InterpolationRequest, OnnxModelSpec } from './types';

const DB_NAME = 'folia-frame-interpolation';
const STORE_NAME = 'models';

/** 用变量拼接绕过 Vite 的静态解析：包不存在时构建仍应通过。 */
const loadOrt = async (): Promise<OrtModule | null> => {
    const specifier = ['onnxruntime-web', 'webgpu'].join('/');
    try {
        return await import(/* @vite-ignore */ specifier) as unknown as OrtModule;
    } catch {
        return null;
    }
};

type OrtTensor = { data: Float32Array | number[]; dims: number[] };
type OrtSession = {
    run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
    release?(): Promise<void>;
};
type OrtModule = {
    InferenceSession: {
        create(source: ArrayBuffer | Uint8Array, options?: Record<string, unknown>): Promise<OrtSession>;
    };
    Tensor: new (type: string, data: Float32Array | number[], dims: number[]) => OrtTensor;
    env?: { wasm?: { numThreads?: number } };
};

const openModelDb = (): Promise<IDBDatabase | null> => new Promise(resolve => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                request.result.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
    } catch {
        resolve(null);
    }
});

const readCachedModel = async (key: string): Promise<ArrayBuffer | null> => {
    const db = await openModelDb();
    if (!db) return null;
    return new Promise(resolve => {
        try {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result instanceof ArrayBuffer ? req.result : null);
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        } finally {
            db.close();
        }
    });
};

const cacheModel = async (key: string, buffer: ArrayBuffer): Promise<void> => {
    const db = await openModelDb();
    if (!db) return;
    try {
        await new Promise<void>(resolve => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(buffer, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch {
        // 缓存失败不影响本次推理。
    } finally {
        db.close();
    }
};

const fetchModel = async (url: string): Promise<ArrayBuffer | null> => {
    const cached = await readCachedModel(url);
    if (cached) return cached;
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const buffer = await response.arrayBuffer();
        void cacheModel(url, buffer);
        return buffer;
    } catch {
        return null;
    }
};

const asImageSource = (frame: VideoFrame): CanvasImageSource => frame as unknown as CanvasImageSource;

/** VideoFrame → NCHW fp32（0..inputScale），同时按模型要求把 H/W 补齐到 paddingMultiple。 */
const frameToNchw = (
    frame: VideoFrame,
    paddedWidth: number,
    paddedHeight: number,
    scale: number,
): { data: Float32Array; dims: number[] } => {
    const canvas = new OffscreenCanvas(paddedWidth, paddedHeight);
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!context) throw new Error('[FrameInterpolation] 2D context unavailable');
    context.drawImage(asImageSource(frame), 0, 0, paddedWidth, paddedHeight);
    const rgba = context.getImageData(0, 0, paddedWidth, paddedHeight).data;
    const plane = paddedWidth * paddedHeight;
    const data = new Float32Array(plane * 3);
    const factor = scale / 255;
    for (let i = 0; i < plane; i += 1) {
        data[i] = rgba[i * 4] * factor;
        data[plane + i] = rgba[i * 4 + 1] * factor;
        data[plane * 2 + i] = rgba[i * 4 + 2] * factor;
    }
    return { data, dims: [1, 3, paddedHeight, paddedWidth] };
};

const outputToVideoFrame = (
    output: OrtTensor,
    paddedWidth: number,
    paddedHeight: number,
    width: number,
    height: number,
    timestampUs: number,
    durationUs: number | null,
): VideoFrame => {
    const data = output.data;
    const plane = paddedWidth * paddedHeight;
    const canvas = new OffscreenCanvas(paddedWidth, paddedHeight);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('[FrameInterpolation] 2D context unavailable');
    const image = context.createImageData(paddedWidth, paddedHeight);
    // 输出可能是 0..1 或 0..255，按最大值粗判一次，兼容不同导出脚本。
    let peak = 0;
    for (let i = 0; i < Math.min(data.length, plane * 3); i += 97) peak = Math.max(peak, Math.abs(data[i]));
    const factor = peak > 2 ? 1 : 255;
    for (let i = 0; i < plane; i += 1) {
        image.data[i * 4] = Math.max(0, Math.min(255, data[i] * factor));
        image.data[i * 4 + 1] = Math.max(0, Math.min(255, data[plane + i] * factor));
        image.data[i * 4 + 2] = Math.max(0, Math.min(255, data[plane * 2 + i] * factor));
        image.data[i * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    // 推理在补齐尺寸上做，输出裁回预设尺寸，避免导出画面被拉伸。
    const source: CanvasImageSource = (paddedWidth === width && paddedHeight === height)
        ? canvas
        : canvas.transferToImageBitmap();
    const target = new OffscreenCanvas(width, height);
    const targetContext = target.getContext('2d', { alpha: false });
    if (!targetContext) throw new Error('[FrameInterpolation] 2D context unavailable');
    if (source === canvas) {
        targetContext.drawImage(canvas, 0, 0);
    } else {
        targetContext.drawImage(source, 0, 0, width, height, 0, 0, width, height);
        (source as ImageBitmap).close();
    }
    return new VideoFrame(target, {
        timestamp: timestampUs,
        duration: durationUs ?? undefined,
    });
};

export type OnnxInterpolatorOptions = {
    spec: OnnxModelSpec;
    modelUrl: string;
    /** 显式 EP 偏好；留空让 ORT 自己挑（WebGPU → WebGL → WASM）。 */
    executionProviders?: string[];
};

export class OnnxFrameInterpolator implements FrameInterpolator {
    readonly id = 'onnx' as const;
    readonly model: OnnxModelSpec['model'];

    private ort: OrtModule | null = null;
    private session: OrtSession | null = null;
    private disposed = false;

    constructor(private readonly options: OnnxInterpolatorOptions) {
        this.model = options.spec.model;
    }

    async prepare(): Promise<boolean> {
        if (this.disposed) return false;
        const ort = await loadOrt();
        if (!ort?.InferenceSession || !ort.Tensor) return false;
        const buffer = await fetchModel(this.options.modelUrl);
        if (!buffer) return false;
        try {
            const providers = this.options.executionProviders
                ?? (typeof navigator !== 'undefined' && 'gpu' in navigator ? ['webgpu'] : ['wasm']);
            const session = await ort.InferenceSession.create(buffer, { executionProviders: providers });
            if (this.disposed) {
                await session.release?.();
                return false;
            }
            this.ort = ort;
            this.session = session;
            return true;
        } catch {
            return false;
        }
    }

    async interpolate(request: InterpolationRequest): Promise<VideoFrame[]> {
        const { ort, session } = this;
        if (!ort || !session) throw new Error('[FrameInterpolation] ONNX session not ready');
        const spec = this.options.spec;
        const { padded: paddedWidth } = padToMultiple(request.width, spec.paddingMultiple);
        const { padded: paddedHeight } = padToMultiple(request.height, spec.paddingMultiple);
        const first = frameToNchw(request.prev, paddedWidth, paddedHeight, spec.inputScale);
        const second = frameToNchw(request.next, paddedWidth, paddedHeight, spec.inputScale);
        const frames: VideoFrame[] = [];

        for (let index = 0; index < request.timestampsUs.length; index += 1) {
            const feeds: Record<string, OrtTensor> = {};
            if (spec.layout === 'concat') {
                const merged = new Float32Array(first.data.length * 2);
                merged.set(first.data, 0);
                merged.set(second.data, first.data.length);
                feeds[spec.inputNames[0]] = new ort.Tensor('float32', merged, [1, 6, paddedHeight, paddedWidth]);
            } else {
                feeds[spec.inputNames[0]] = new ort.Tensor('float32', first.data, first.dims);
                feeds[spec.inputNames[1] as string] = new ort.Tensor('float32', second.data, second.dims);
            }
            if (spec.timestepName) {
                const t = (index + 1) / (request.timestampsUs.length + 1);
                feeds[spec.timestepName] = new ort.Tensor('float32', new Float32Array([t]), [1]);
            }
            const result = await session.run(feeds);
            const output = result[spec.outputName];
            if (!output) throw new Error(`[FrameInterpolation] missing output ${spec.outputName}`);
            frames.push(outputToVideoFrame(
                output,
                paddedWidth,
                paddedHeight,
                request.width,
                request.height,
                request.timestampsUs[index],
                request.durationUs,
            ));
        }
        return frames;
    }

    dispose(): void {
        this.disposed = true;
        void this.session?.release?.();
        this.session = null;
        this.ort = null;
    }
}
