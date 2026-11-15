import { Capacitor, registerPlugin } from '@capacitor/core';

// src/services/playbackEngine/nativePlayerPlugin.ts
//
// 原生播放内核的 JS 侧声明（P1）。与 android/.../player/FoliaNativePlayerPlugin.java 一一对应：
// 方法名、事件名（`foliaNativePlayer`）、字段名改一处两边都要改。

export type NativePlaybackEventType =
    | 'ready'
    | 'playing'
    | 'paused'
    | 'ended'
    | 'position'
    /** 位置跳变（seek / 单曲循环回到开头）：允许时钟往回走。 */
    | 'seeked'
    | 'buffering'
    | 'error'
    | 'idle';

export type NativePlaybackEvent = {
    type: NativePlaybackEventType;
    positionMs?: number;
    durationMs?: number;
    message?: string;
    songKey?: string;
    /** 原生实际出声/缓冲状态，seeked 不再凭位置跳变推断已恢复播放。 */
    playing?: boolean;
    buffering?: boolean;
};

export type NativePlaybackSnapshot = {
    positionMs: number;
    durationMs: number;
    playing: boolean;
    buffering?: boolean;
    speed?: number;
    /**
     * 引擎此刻**装的那一首**（装源时写进 MediaItem 的 mediaId），没装东西时为空串。
     *
     * 判「点歌有没有真的换过去」只能看这个：服务里的 `cachedSongKey` 会随 Web 推的
     * metadata 变，拿它当判据等于自己给自己盖章。
     */
    songKey?: string;
};

/**
 * 原生调音台的设置载荷。
 *
 * 与 Web 的 `AudioEqualizerSettings` + `AudioConsoleSettings` 合起来对齐原生真正会执行的
 * 那几项。饱和 / 比特降质 / 抖晃 / 黑胶噪声 / 宽度在原生链上没有对应的站，**不再发**：
 * 发了原生也只是忽略，而界面若还留着滑杆，用户会以为拖了有用。饱和在「染色」页，
 * 宽度在「混响 · 声场」，两者各有自己的字段（`saturation` / `stereo`）。
 * 同理 punch 与 space 这两个 v1 遗留字段也不再发 —— 压缩与混响各有一整页，
 * 预设若偷偷带上它们，等于在用户看不见的地方开第二台压缩器、或让「混响关着」也响。
 *
 * `gains` 必须正好 10 项；原生会再夹一次 ±12 dB，不依赖这边传得干净。
 * 协议 `version` 2 起才有 `eq` / `reverb` / `compressor` / `postEq` 四块；
 * 原生对缺席的块按中性处理，所以少传不会让播放失败。
 */
export type NativeEqualizerSettings = {
    version: number;
    enabled: boolean;
    gains: number[];
    /** 前置 EQ 的形状：GEQ 定 Q，PEQ 用下面的 q。 */
    eq: {
        mode: 'geq' | 'peq';
        q: number;
        globalGainDb: number;
    };
    /** 只剩两颗滤波器：高频截止与低频截止。 */
    effects: {
        highpass: number;
        lowpass: number;
    };
    reverb: {
        enabled: boolean;
        /** 0 出厂 / 1 音乐厅 / 2 空灵大教堂 / 3 板式。只决定房间大小。 */
        preset: number;
        rt60: number;
        roomLevelDb: number;
        /** 高频阻尼 0.02 ~ 0.9。 */
        damping: number;
        /** 预延迟 0 ~ 120 ms。 */
        preDelayMs: number;
        /** 干湿比 0 ~ 1（等功率）。 */
        mix: number;
        tailOnPause: boolean;
    };
    compressor: {
        enabled: boolean;
        bandCount: number;
        /** 0 温和 / 1 平直。 */
        profile: number;
        /** 三级分频点（Hz），升序：Low|Mid、Mid|High、High|Air。2 段模式只用第一级。 */
        crossovers: number[];
        bands: Array<{
            enabled: boolean;
            thresholdDb: number;
            ratio: number;
            attackMs: number;
            releaseMs: number;
            makeupDb: number;
            /** 软拐点 2 ~ 18 dB。 */
            kneeDb: number;
            /** 平行压缩混合比 0 ~ 1。 */
            mix: number;
        }>;
    };
    postEq: {
        enabled: boolean;
        gains: number[];
        mode: 'geq' | 'peq';
        q: number;
        globalGainDb: number;
    };
    /** 声场宽度：M/S 加权，挂在混响之前。 */
    stereo: {
        enabled: boolean;
        /** 0 单声道 ~ 2 加倍；1 是原样。 */
        width: number;
        /** 低频单声道：该频率以下的侧向归零；0 表示关。 */
        bassMonoHz: number;
    };
    /** 饱和 / 染色：给信号加谐波，挂在后置 EQ 之后、立体声之前。 */
    saturation: {
        enabled: boolean;
        /** tape / tube / diode。 */
        mode: 'tape' | 'tube' | 'diode';
        /** 进曲线的增益 0 ~ 24 dB。 */
        driveDb: number;
        /** 干湿比 0 ~ 1（等功率）。 */
        mix: number;
        /** 出口电平 -24 ~ +6 dB。 */
        outputDb: number;
    };
    /** 链末限幅器。 */
    limiter: {
        /** 输出上限 -6 ~ 0 dBFS。 */
        ceilingDb: number;
        /** 回落时间 40 ~ 500 ms。 */
        releaseMs: number;
    };
    /**
     * 沉浸音效（协议 v3）。整段可缺省：老 WebView 推上来的包没有这一项，
     * 原生侧按全关处理，听感与升级前一致。
     */
    immersive?: {
        /** 虚拟环绕：off / headphone / speaker。 */
        surround: { mode: 'off' | 'headphone' | 'speaker'; width: number; roomAmount: number };
        /** 交叉馈送（耳机用）：对侧串扰 dB 与延时 ms。 */
        crossfeed: { enabled: boolean; levelDb: number; delayMs: number };
        /** 人声增强：1.2~4 kHz 的动态提升深度。 */
        vocal: { enabled: boolean; amountDb: number };
        /** 夜间模式：秒级 AGC。 */
        night: { enabled: boolean; strength: number; targetLoudness: number };
        /** 黑胶模拟：底噪 / 划痕 / 抖晃。 */
        vinyl: { enabled: boolean; noise: number; crackle: number; wow: number };
        /** 8D 环绕：声像绕头旋转。 */
        orbit: { enabled: boolean; periodSec: number; depth: number };
        /** 超低音增强：谐波激励。 */
        bass: { enabled: boolean; amount: number; crossoverHz: number };
    };
    /** 增益滑入时间（毫秒）：用户改动 15，mod 曲线 250（对齐 Web 的 setTargetAtTime 常数）。 */
    glideMs: number;
};

export type NativeEqualizerState = NativeEqualizerSettings & {
    /** 进程内变更序号：诊断时用来确认「推的这条原生到底收没收到」。 */
    seq: number;
};

/** 一帧频谱：32 段，0..1 对应 -90 dB ~ 0 dB。 */
export type NativeSpectrumFrame = {
    bands: number[];
};

/**
 * 设备级杜比解码能力（只读探测）。这些字段说明「这台手机的 MediaCodec 里有没有对应解码器」，
 * 不表示 Folia 会用它们解对象流 —— 应用没有 Dolby 渲染器与 dev kit 授权。
 */
export type DolbyDeviceCapabilities = {
    /** E-AC-3 / DD+，含 DD+ Atmos 的 5.1 core。 */
    eac3: boolean;
    /** AC-4（Atmos IMS）。 */
    ac4: boolean;
    /** 老 Dolby Digital。 */
    ac3: boolean;
    /** FLAC（Hi-Res 母带能不能直接解）。 */
    flac: boolean;
    /** false = 探测失败，上述布尔值不可当真。 */
    available: boolean;
    error?: string;
};

/**
 * 设备实际音频输出参数（只读探测）。回答「Hi-Res 音源最终以什么采样率输出」，不是
 * 「应用支持 bit-perfect」。`floatPcmOutput` 恒为 false：原生 EQ 挂在 AudioProcessor 链上，
 * 打开 float 输出会让 media3 跳过整条链，所以那条路径主动选择 16 bit PCM（见 Kotlin 侧
 * FoliaAudioSinkFactory）。`available=false` 表示探测失败，采样率不可当真。
 */
export type AudioOutputCapabilities = {
    /** 系统音频输出采样率（Hz）；0 = 读不到。 */
    outputSampleRate: number;
    /** 是否走浮点 PCM 输出。恒为 false，原因见上。 */
    floatPcmOutput: boolean;
    available: boolean;
    error?: string;
};

interface FoliaNativePlayerPlugin {
    prepare(options: {
        url: string;
        startPositionMs?: number | null;
        /** Player.REPEAT_MODE_OFF(0) / ONE(1) / ALL(2)，与 androidx.media3.common.Player 一致。 */
        repeatMode?: number | null;
        /** 这首歌的身份，装进去之后 getSnapshot().songKey 会回它。 */
        songKey?: string | null;
    }): Promise<{ ok: boolean }>;
    play(): Promise<void>;
    pause(): Promise<void>;
    stop(): Promise<void>;
    seek(options: { positionMs: number }): Promise<void>;
    setVolume(options: { volume: number }): Promise<void>;
    setSpeed(options: { speed: number }): Promise<void>;
    setRepeatMode(options: { repeatMode: number }): Promise<void>;
    setEqualizer(options: { settings: NativeEqualizerSettings }): Promise<{ applied: boolean; active: boolean; seq: number }>;
    getEqualizerState(): Promise<NativeEqualizerState>;
    /** 频谱取样开关：只有后置均衡器那一页打开时才开，没人看就不该在音频线程上跑 FFT。 */
    setSpectrumEnabled(options: { enabled: boolean }): Promise<void>;
    getSpectrum(): Promise<NativeSpectrumFrame>;
    getSnapshot(): Promise<NativePlaybackSnapshot>;
    /**
     * 只探测设备是否有杜比相关 MediaCodec 解码器（eac3 / ac4 / ac3），不加载任何解码库、
     * 不改变播放路径。`available=false` 表示探测本身失败，布尔值不可信。见 Kotlin 侧
     * `getDolbyDeviceCapabilities`：这些是「设备能力事实」，不是「应用支持杜比解码」。
     */
    getDolbyDeviceCapabilities(): Promise<DolbyDeviceCapabilities>;
    /** 只读探测系统音频输出参数，不改变播放路径、不开启任何高解析输出模式。 */
    getAudioOutputCapabilities(): Promise<AudioOutputCapabilities>;
    release(): Promise<void>;
    addListener(
        eventName: 'foliaNativePlayer',
        listener: (event: NativePlaybackEvent) => void,
    ): Promise<() => void>;
}

const FoliaNativePlayer = registerPlugin<FoliaNativePlayerPlugin>('FoliaNativePlayer');

/**
 * 这个插件是不是真的在。
 *
 * ⚠️ 不能用 `typeof FoliaNativePlayer?.play === 'function'` 判：registerPlugin() 给回来的是
 * 代理，方法名问过去永远是 function，原生侧一行没写也会返回 true。必须查原生上报的
 * pluginHeaders（同步），否则会出现「开关开着、播放器其实不存在」的静默降级。
 */
export const isNativePlayerAvailable = (): boolean => {
    if (typeof Capacitor === 'undefined') return false;
    if (!Capacitor.isNativePlatform()) return false;
    return Capacitor.isPluginAvailable('FoliaNativePlayer');
};

export const nativePlayer = {
    prepare: (options: Parameters<FoliaNativePlayerPlugin['prepare']>[0]) => FoliaNativePlayer.prepare(options),
    play: () => FoliaNativePlayer.play(),
    pause: () => FoliaNativePlayer.pause(),
    stop: () => FoliaNativePlayer.stop(),
    seek: (positionMs: number) => FoliaNativePlayer.seek({ positionMs }),
    setVolume: (volume: number) => FoliaNativePlayer.setVolume({ volume }),
    setSpeed: (speed: number) => FoliaNativePlayer.setSpeed({ speed }),
    setRepeatMode: (repeatMode: number) => FoliaNativePlayer.setRepeatMode({ repeatMode }),
    setEqualizer: (settings: NativeEqualizerSettings) => FoliaNativePlayer.setEqualizer({ settings }),
    getEqualizerState: () => FoliaNativePlayer.getEqualizerState(),
    setSpectrumEnabled: (enabled: boolean) => FoliaNativePlayer.setSpectrumEnabled({ enabled }),
    getSpectrum: () => FoliaNativePlayer.getSpectrum(),
    getSnapshot: () => FoliaNativePlayer.getSnapshot(),
    getDolbyDeviceCapabilities: () => FoliaNativePlayer.getDolbyDeviceCapabilities(),
    getAudioOutputCapabilities: () => FoliaNativePlayer.getAudioOutputCapabilities(),
    release: () => FoliaNativePlayer.release(),
    addListener: (listener: (event: NativePlaybackEvent) => void) =>
        FoliaNativePlayer.addListener('foliaNativePlayer', listener),
};
