// src/services/audioCodec/dolbyDecodeBackend.ts
//
// 对象式杜比解码后端的**预留接口**（2026-11-12）。这不是一个可用的解码器，也不是一个开关。
//
// 现状（如实记录，别让后来的改动把这层当成"已经支持杜比"）：
//   · 平台下发的「杜比全景声 / 空间音频」曲目是平台**已双耳渲染**的普通音频文件
//     （FLAC / AAC / MP4 立体声或 5.1）。它们走现有 `<audio>` / ExoPlayer 解码路径，
//     `AudioQualityPreference` 的 `atmos` 档选中它们，完全不需要这个后端。
//   · 真正的对象式 Atmos 是 E-AC-3 JOC / AC-4 IMS 码流，带 JOC/OAMD 对象元数据。要在本应用
//     解码并渲染，需要同时具备：
//       1. Dolby 官方 dev kit 与产品认证（MS12 / DAX3 / AC-4 Consumer Decoder /
//          Dolby Atmos Core for Windows 之一），见
//          https://www.dolby.com/us/en/professional/licensing/support-consumer-licensing-dev-kits.html
//       2. 一个能解码该码流的二进制库。Chromium（Electron 43）对 `audio/eac3` / `audio/ac4`
//          的 `canPlayType` 与 MSE `isTypeSupported` 都是 false；主线 FFmpeg 8.1 也没有 AC-4
//          解码器。Windows 侧若不引入原生库，就得从源码重编译打了 codec patch 的 Electron。
//       3. 一个 Atmos 渲染器（对象 → 声道 / 双耳），Web Audio 最多 8 声道离散、没有对象音频能力。
//       4. 平台侧真的下发对象码流（而不是已渲染好的立体声），以及相应的内容授权。
//     缺任意一项都不能声称"支持杜比全景声解码"。目前四项全缺，所以下面的注册表是空的。
//
// 这个接口存在的意义：将来若真拿到 dev kit 与码流，改动应集中在此处注册一个实现，再由
// `video/audio` 管线按 `canDecode` 决定是否走它；界面层的「能力标注」从
// `getPlaybackCapabilities().dolbyObjectDecoding` 读取，不需要重写。不要把 HRTF 虚拟环绕
// （services/audioEffects/surroundBranch.ts / orbitBranch.ts）注册到这里 —— 那是立体声上混
// 效果，不是杜比解码，冒充会造成误导。

/** 一段待解码音频的描述。 */
export type DolbySourceDescriptor = {
    /** MIME，如 `audio/eac3`、`audio/ac4`。 */
    mimeType: string;
    /** 容器，如 `mp4`、`m4a`、`ec3`。 */
    container?: string;
    /** 是否带 JOC / OAMD 对象元数据（即"真 Atmos"而非 5.1 core）。 */
    hasObjectMetadata?: boolean;
};

/** 一个已授权、可实际解码并渲染对象式杜比码流的后端。 */
export interface DolbyDecodeBackend {
    readonly id: string;
    /** 该后端是否就绪（库已加载、授权有效、设备/OS 满足条件）。 */
    isReady(): boolean | Promise<boolean>;
    /** 能否处理这段码流。 */
    canDecode(source: DolbySourceDescriptor): boolean;
    /**
     * 解码 + 渲染到目标声道布局，返回可交给音频图的 PCM。
     * 具体实现由 dev kit 提供；此接口不假定任何 Web/Electron/Android 细节。
     */
    decodeAndRender(source: DolbySourceDescriptor): Promise<{
        pcm: Float32Array;
        sampleRate: number;
        channelLayout: 'stereo' | '5.1' | '7.1.4' | 'binaural';
    }>;
}

const backends: DolbyDecodeBackend[] = [];

/**
 * 注册一个已授权的对象式杜比后端。仅在真正具备 dev kit、二进制库、渲染器与码流时调用。
 * 返回取消注册函数，便于热插拔 / 测试。
 */
export const registerDolbyDecodeBackend = (backend: DolbyDecodeBackend): (() => void) => {
    const existing = backends.findIndex(item => item.id === backend.id);
    if (existing >= 0) backends.splice(existing, 1);
    backends.push(backend);
    return () => {
        const index = backends.findIndex(item => item.id === backend.id);
        if (index >= 0) backends.splice(index, 1);
    };
};

/** 当前是否注册了任何可用的对象式杜比后端。默认恒为 false。 */
export const hasDolbyObjectDecodeBackend = (): boolean => backends.length > 0;

/** 找出能处理这段码流的后端；没有就返回 null（调用方应降级或如实提示，而不是静音）。 */
export const findDolbyDecodeBackend = (source: DolbySourceDescriptor): DolbyDecodeBackend | null =>
    backends.find(backend => backend.canDecode(source)) ?? null;

/** 已注册后端 id，供诊断日志使用。 */
export const listDolbyDecodeBackends = (): readonly string[] => backends.map(backend => backend.id);
