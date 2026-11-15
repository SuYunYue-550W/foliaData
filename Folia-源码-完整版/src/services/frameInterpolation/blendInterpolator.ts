// src/services/frameInterpolation/blendInterpolator.ts
// 零依赖的降级后端：两帧各 50% 叠画。有鬼影，但绝不阻塞、绝不失败，且与原链路行为可预期。

import { meanAbsoluteDifference } from './frameMath';
import type { FrameInterpolator, InterpolationRequest } from './types';

const asImageSource = (frame: VideoFrame): CanvasImageSource => frame as unknown as CanvasImageSource;

/**
 * 低分辨率采样两帧算差异，用于转场/闪光保护。放在这里而不是各后端内，
 * 因为 ONNX 与 blend 都需要同一份判定，且导出是离线的，这点开销可以忽略。
 */
export const sampleFrameDifference = (prev: VideoFrame, next: VideoFrame): number => {
    const width = 32;
    const height = 18;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return 0;
    try {
        context.drawImage(asImageSource(prev), 0, 0, width, height);
        const a = context.getImageData(0, 0, width, height).data;
        context.clearRect(0, 0, width, height);
        context.drawImage(asImageSource(next), 0, 0, width, height);
        const b = context.getImageData(0, 0, width, height).data;
        return meanAbsoluteDifference(a, b);
    } catch {
        // 某些像素格式不能直接 drawImage；拿不到差异就不做保护，别让导出挂掉。
        return 0;
    }
};

export class BlendFrameInterpolator implements FrameInterpolator {
    readonly id = 'blend' as const;
    readonly model = null;

    private canvas: OffscreenCanvas | null = null;
    private context: OffscreenCanvasRenderingContext2D | null = null;

    async prepare(): Promise<boolean> {
        return typeof OffscreenCanvas !== 'undefined'
            && typeof VideoFrame !== 'undefined';
    }

    async interpolate(request: InterpolationRequest): Promise<VideoFrame[]> {
        const { width, height } = request;
        if (!this.canvas || !this.context || this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas = new OffscreenCanvas(width, height);
            this.context = this.canvas.getContext('2d', { alpha: false });
            if (!this.context) throw new Error('[FrameInterpolation] 2D context unavailable');
        }
        const context = this.context;
        const frames: VideoFrame[] = [];
        for (const timestampUs of request.timestampsUs) {
            context.globalAlpha = 1;
            context.drawImage(asImageSource(request.prev), 0, 0, width, height);
            context.globalAlpha = 0.5;
            context.drawImage(asImageSource(request.next), 0, 0, width, height);
            context.globalAlpha = 1;
            frames.push(new VideoFrame(this.canvas, {
                timestamp: timestampUs,
                duration: request.durationUs ?? undefined,
            }));
        }
        return frames;
    }

    dispose(): void {
        this.canvas = null;
        this.context = null;
    }
}
