import { hasElectronBridge, isAndroidAppShell } from './runtime';
import { isMacPlatform } from '../utils/platform';

// src/platform/playbackCapabilities.ts
//
// 播放器能力的单一事实来源。
//
// 为什么需要它：出声链路在两端不是同一条 —— 桌面/Web 是 `<audio>` + Web Audio 图，
// 安卓 App 壳里是原生 ExoPlayer（`services/playbackEngine/nativePlaybackEngine.ts`）。
// 于是「同一个设置项」在两端可能由完全不同的代码执行，也可能只有一端执行。
// 以前这些判断散落在各个组件里各写一遍（`!isAndroidAppShell()`、`!nativeActive`、
// `window.electron?.…`），设置页便出现过「开关能开、但没有任何提示说明它此刻做什么」。
//
// 纪律（与 `KaraokeRow` 一致）：判定只认「是不是安卓 App 壳」，**不认 Capacitor 桥是否就绪**，
// 启动头几秒那个判断会答错（见 runtime.ts 的说明）。每次渲染重新问，不缓存：
// 能力在运行时不会变，但缓存下来的快照比多问一次更容易和现实脱节。

export type CrossfadeImplementation = 'web-decks' | 'native-exoplayer' | 'none';

/**
 * How a "Dolby Atmos / spatial audio" track is actually handled (2026-11-12).
 *
 * This exists so the settings UI can state the truth rather than imply a capability the app does
 * not have. Dolby Atmos Music reaches a streaming client in three fundamentally different forms:
 *
 *  - `platform-rendered`: the platform binaural-renders the object mix upstream and delivers an
 *    ordinary FLAC / AAC / MP4 stereo (or 5.1) file. No Dolby decoder, SDK or licence is needed
 *    in the client — it is just an audio file. This is what QQ Music, NetEase and Qishui deliver
 *    on Android / desktop, and it is what the `atmos` quality tier selects.
 *  - `object-based`: an E-AC-3 JOC (DD+ Atmos) or AC-4 IMS bitstream carrying object metadata
 *    (JOC / OAMD) plus beds. Playing it needs a Dolby-licensed decoder AND renderer (DAX3 / MS12 /
 *    AC-4 Consumer Decoder / Atmos Core for Windows) and, for speaker output, an eARC/HDMI
 *    passthrough. Neither Chromium (Electron 43) nor plain Web Audio can decode or render it:
 *    `canPlayType('audio/eac3')` is empty and MSE `isTypeSupported` is false. FFmpeg 8.1 has no
 *    AC-4 decoder in mainline either. NOT implemented here, and it cannot be added without a
 *    Dolby development kit and a product certification.
 *  - `os-takeover`: Windows 11 + Dolby Access "Atmos for Headphones" (or Android DAX3) virtualises
 *    the app's ordinary stereo output at the OS audio stack. The app needs no change and cannot
 *    reliably detect or control it. Whatever the app renders is upmixed by the OS, not by Folia.
 */
export type DolbyPlaybackMode =
    | 'platform-rendered'
    | 'object-based-unavailable'
    | 'os-takeover';

export type PlaybackCapabilities = {
    /** Web Audio 图是否在信号路径上。决定实时音效、伴唱中/侧路由、频谱能否生效。 */
    webAudioGraph: boolean;
    /** 按节拍网格对齐、可用分轨分析的自动混音。需要双 deck 的 Web Audio 图。 */
    automixAnalysis: boolean;
    /** 两首歌重叠的交叉淡化。两端都有，但实现不同。 */
    crossfade: boolean;
    crossfadeImplementation: CrossfadeImplementation;
    /** 伴唱（人声消除 / 人声独唱），同样是 Web Audio 图上的实时路由。 */
    karaoke: boolean;
    /** 系统级媒体会话（通知栏、锁屏、媒体按键）由原生前台服务提供。 */
    nativeMediaSession: boolean;
    /** 主进程注册的标准媒体键（MediaPlayPause / MediaNextTrack / …），Windows / Linux 有效；
     *  macOS 的媒体键由系统媒体会话接管，Electron 的 globalShortcut 抢不到。 */
    desktopMediaKeys: boolean;
    /**
     * 平台下发的「杜比全景声 / 空间音频」曲目能否在本应用播放。两端都为 true：那些曲目是平台
     * 已渲染好的普通音频文件（FLAC / AAC / MP4），`<audio>` 与 ExoPlayer 都能直接解，不需要
     * 任何杜比解码器。具体档位由 provider 的 `audioQualityLevels` 是否列出 `atmos` 决定。
     */
    platformAtmosTracks: boolean;
    /**
     * 本机是否内置了对象式杜比解码（E-AC-3 JOC / AC-4 IMS + 渲染器）。恒为 false：需要 Dolby
     * 官方 dev kit 与产品认证，且 Chromium / Web Audio / 主线 FFmpeg 都不提供该能力。这里显式
     * 声明为「不可用」，是为了不把 HRTF 虚拟环绕（surroundBranch.ts）冒充成杜比全景声。
     */
    dolbyObjectDecoding: false;
    /** 杜比能力的呈现方式，供设置页如实标注。 */
    dolbyMode: DolbyPlaybackMode;
    /**
     * Hi-Res 音源是否可能以原采样率 bit-perfect 输出。恒为 false，且不是「待补的配置项」：
     *  · Web / 桌面：音频图跟随系统默认采样率；即便创建时指定 sampleRate，
     *    `createMediaElementSource(element)` 对同一元素只能调一次，无法按曲目重建上下文，
     *    输出也仍要经过系统混音器，最终采样率由系统决定。
     *  · 安卓：原生 EQ 挂在 AudioProcessor 链上，打开 float 输出会让 media3 跳过整条链，
     *    因此 AudioSink 主动选择 16 bit PCM；bit-perfect 到 DAC 需要独占直通，本项目没有。
     * 这里如实标注，避免「能播 Hi-Res 就等于原样输出」的误解。实际输出采样率由设置页
     * 只读探测展示（见 SpatialAudioCapabilityRows）。
     */
    hiResBitPerfectOutput: false;
};

/**
 * 当前运行时的播放能力。
 *
 * 注意 `crossfade` 在安卓是 **true**：`useAppFoundation.ts` 启动时会把
 * `crossfadeEnabled / crossfadeMs / crossfadeCurve` 推给原生，由 `FoliaNativePlayer.crossfadeTo`
 * 执行。所以「过渡」开关在安卓不是失效，只是不包含 automix 的节拍对齐与分轨。
 */
export const getPlaybackCapabilities = (): PlaybackCapabilities => {
    const native = isAndroidAppShell();
    const electron = hasElectronBridge();
    return {
        webAudioGraph: !native,
        automixAnalysis: !native,
        crossfade: true,
        crossfadeImplementation: native ? 'native-exoplayer' : 'web-decks',
        karaoke: !native,
        nativeMediaSession: native,
        desktopMediaKeys: electron && !native && !isMacPlatform,
        // A platform-rendered spatial track is an ordinary audio file on both ends, so it plays
        // through the existing decode path. Object-based Dolby decoding is deliberately declared
        // unavailable rather than faked with the HRTF virtual-surround effect chain.
        platformAtmosTracks: true,
        dolbyObjectDecoding: false,
        // `atmos` selects a platform-rendered track; the OS may additionally virtualise the output
        // (Dolby Access / DAX3), which is outside the app's control. Report the former as the truth
        // about what the app itself does.
        dolbyMode: 'platform-rendered',
        hiResBitPerfectOutput: false,
    };
};
