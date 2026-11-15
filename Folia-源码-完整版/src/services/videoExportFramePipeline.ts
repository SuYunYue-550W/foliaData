import type { VideoExportPreset } from '../types/videoExport';
import {
    createExportInterpolationRuntime,
    createInterpolationStage,
    type InterpolationSettings,
} from './frameInterpolation';

// src/services/videoExportFramePipeline.ts
// Pins a captured video track to the exact export preset size, frame by frame, without a
// Canvas copy on the hot path. Measured in Electron 43 on a 4K export, a Canvas 2D re-draw fed
// into canvas.captureStream() delivered single-digit fps (and stalled at 1080p), while
// cropping each VideoFrame through `visibleRect` kept pace with the capture.

// Chromium's breakout-box API; not in TypeScript's DOM lib.
type TrackProcessor = { readable: ReadableStream<VideoFrame> };
type TrackGenerator = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type BreakoutBoxGlobals = {
    MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => TrackProcessor;
    MediaStreamTrackGenerator?: new (init: { kind: 'video' }) => TrackGenerator;
};

export const isVideoExportFramePipelineSupported = () => {
    const globals = globalThis as unknown as BreakoutBoxGlobals;
    return typeof globals.MediaStreamTrackProcessor === 'function'
        && typeof globals.MediaStreamTrackGenerator === 'function'
        && typeof VideoFrame === 'function';
};

// Subsampled formats (I420/NV12) need crop offsets on even coordinates.
const toEvenFloor = (value: number) => Math.max(0, Math.floor(value / 2) * 2);

export type PresetFramePlan =
    | { mode: 'pass' }
    // Zero-copy crop of a frame at least as large as the preset; `rect` is preset-sized.
    | { mode: 'crop'; rect: { x: number; y: number; width: number; height: number } }
    // Smaller frame: `rect` is the centered source region that covers the preset aspect ratio.
    | { mode: 'cover'; rect: { x: number; y: number; width: number; height: number } };

/** Decides how one captured frame of `frameWidth`x`frameHeight` becomes a preset-sized frame. */
export const planPresetFrame = (
    frameWidth: number,
    frameHeight: number,
    preset: Pick<VideoExportPreset, 'width' | 'height'>,
): PresetFramePlan => {
    if (frameWidth === preset.width && frameHeight === preset.height) {
        return { mode: 'pass' };
    }
    if (frameWidth >= preset.width && frameHeight >= preset.height) {
        return {
            mode: 'crop',
            rect: {
                x: toEvenFloor((frameWidth - preset.width) / 2),
                y: toEvenFloor((frameHeight - preset.height) / 2),
                width: preset.width,
                height: preset.height,
            },
        };
    }
    const scale = Math.max(preset.width / frameWidth, preset.height / frameHeight);
    const width = Math.min(frameWidth, preset.width / scale);
    const height = Math.min(frameHeight, preset.height / scale);
    return {
        mode: 'cover',
        rect: { x: (frameWidth - width) / 2, y: (frameHeight - height) / 2, width, height },
    };
};

export type VideoExportFramePipelineOptions = {
    /**
     * 可选的导出补帧设置。省略或 enabled=false 时整条链路与原实现逐字节等价。
     * 补帧只作用于「录屏导出」这一条离线式帧流，不参与实时渲染画面。
     */
    interpolation?: InterpolationSettings | null;
};

/**
 * Returns a stream whose video track is exactly preset-sized. Frames at least as large as the
 * preset (the normal case: window content is sized to the preset, give or take a pixel) are
 * center-cropped with zero-copy `visibleRect`. Smaller frames — the first few of a capture,
 * still at the pre-resize window size — are scaled to "cover" on an OffscreenCanvas so the
 * recording never contains black bars or a size change. Audio tracks pass through.
 */
export const createPresetSizedVideoStream = (
    sourceStream: MediaStream,
    preset: VideoExportPreset,
    options?: VideoExportFramePipelineOptions,
): { stream: MediaStream; cleanup: () => void } => {
    const globals = globalThis as unknown as BreakoutBoxGlobals;
    const sourceTrack = sourceStream.getVideoTracks()[0];
    if (!sourceTrack) {
        throw new Error('[VideoExport] No video track in source stream');
    }
    if (!globals.MediaStreamTrackProcessor || !globals.MediaStreamTrackGenerator) {
        throw new Error('[VideoExport] Frame pipeline is not supported in this runtime');
    }

    const processor = new globals.MediaStreamTrackProcessor({ track: sourceTrack });
    const generator = new globals.MediaStreamTrackGenerator({ kind: 'video' });
    const abortController = new AbortController();

    let fallbackCanvas: OffscreenCanvas | null = null;
    let fallbackContext: OffscreenCanvasRenderingContext2D | null = null;
    let lastModeKey = '';

    // Logs once per distinct (size, mode) so a size change mid-capture stays visible.
    const logMode = (frame: VideoFrame, mode: string) => {
        const key = `${frame.displayWidth}x${frame.displayHeight}:${mode}`;
        if (key === lastModeKey) return;
        lastModeKey = key;
        console.log(`[VideoExport] frame ${frame.displayWidth}x${frame.displayHeight} (${frame.format}) -> ${preset.width}x${preset.height} mode=${mode}`);
    };

    const coverFrame = (frame: VideoFrame) => {
        if (!fallbackCanvas || !fallbackContext) {
            fallbackCanvas = new OffscreenCanvas(preset.width, preset.height);
            fallbackContext = fallbackCanvas.getContext('2d', { alpha: false });
            if (!fallbackContext) {
                throw new Error('[VideoExport] Failed to create 2D context for frame scaling');
            }
            fallbackContext.imageSmoothingQuality = 'high';
        }
        const plan = planPresetFrame(frame.displayWidth, frame.displayHeight, preset);
        // A crop plan lands here only when visibleRect was rejected; its rect still applies.
        const rect = plan.mode === 'pass'
            ? { x: 0, y: 0, width: frame.displayWidth, height: frame.displayHeight }
            : plan.rect;
        fallbackContext.drawImage(frame, rect.x, rect.y, rect.width, rect.height, 0, 0, preset.width, preset.height);
        return new VideoFrame(fallbackCanvas, {
            timestamp: frame.timestamp,
            duration: frame.duration ?? undefined,
        });
    };

    // 归一化抽出来，让补帧 stage 只跟「已对齐预设尺寸的 VideoFrame」打交道。
    // pass 分支直接复用原帧（零拷贝），其余分支产出新帧并交回原帧由调用方 close。
    const normalizeFrame = (frame: VideoFrame): { out: VideoFrame; closeOriginal: boolean } => {
        const plan = planPresetFrame(frame.displayWidth, frame.displayHeight, preset);
        if (plan.mode === 'pass') {
            logMode(frame, 'pass');
            return { out: frame, closeOriginal: false };
        }
        if (plan.mode === 'crop') {
            try {
                const cropped = new VideoFrame(frame, { visibleRect: plan.rect });
                logMode(frame, 'crop');
                return { out: cropped, closeOriginal: true };
            } catch (error) {
                // A format whose alignment rules reject the rect falls back to scaling.
                console.warn('[VideoExport] visibleRect crop failed, scaling instead', error);
            }
        }
        logMode(frame, 'cover');
        return { out: coverFrame(frame), closeOriginal: true };
    };

    const interpolationSettings = options?.interpolation;
    const interpolationRuntime = interpolationSettings?.enabled
        ? createExportInterpolationRuntime(interpolationSettings, {
            breakoutBox: true,
            width: preset.width,
            height: preset.height,
        })
        : null;
    const interpolationStage = interpolationRuntime
        ? createInterpolationStage(interpolationRuntime)
        : null;

    const transform = new TransformStream<VideoFrame, VideoFrame>({
        async transform(frame, controller) {
            try {
                const { out, closeOriginal } = normalizeFrame(frame);
                if (closeOriginal && out !== frame) frame.close();
                if (interpolationStage) {
                    await interpolationStage.push(out, controller);
                } else {
                    controller.enqueue(out);
                }
            } catch (error) {
                // VideoFrame.close() 重复调用是安全的，这里只保证异常不带着一个活帧往上抛。
                try { frame.close(); } catch { /* already closed or transferred */ }
                throw error;
            }
        },
        flush(controller) {
            interpolationStage?.flush(controller);
        },
    });

    void processor.readable
        .pipeThrough(transform, { signal: abortController.signal })
        .pipeTo(generator.writable, { signal: abortController.signal })
        .catch(error => {
            if (!abortController.signal.aborted) {
                console.error('[VideoExport] Frame pipeline stopped', error);
            }
        });

    const stream = new MediaStream([generator]);
    sourceStream.getAudioTracks().forEach(track => {
        stream.addTrack(track);
    });

    const cleanup = () => {
        abortController.abort();
        // 补帧 stage 持有「延迟一帧」的缓存帧、GPU session 与调度互斥计数，必须在中止流时释放。
        interpolationStage?.dispose();
        // Stop the capture tracks too: they live on sourceStream, out of reach of a
        // stopMediaStream() on the returned stream.
        sourceStream.getTracks().forEach(track => track.stop());
        generator.stop();
        fallbackCanvas = null;
        fallbackContext = null;
    };

    return { stream, cleanup };
};
