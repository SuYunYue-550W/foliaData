// src/services/audioEffects/immersiveParams.ts
// 沉浸音效的共享参数表：两端（桌面 Web Audio / Android Kotlin DSP）必须一致的数值。
//
// 为什么要有这个文件：审计发现同一份用户设置两端听感差异巨大，根因不是某一段算法写错，
// 而是**同一个物理量两边各写了一份数字**（底噪系数、抖晃深度、早期反射、wet/dry 公式……），
// 改了一边忘了另一边。这里把它们集中到一处，各分支文件从这里取值，原生侧有逐项对应的
// `android/app/src/main/java/top/izuna/foliamajor/player/dsp/ImmersiveParams.kt`。
//
// 约定：
//   · 数值基准取**桌面端现值**（用户日常听的是桌面端，听感基线不能漂）；
//     桌面端与"物理直觉"明显冲突的，单独注明取舍理由。
//   · 这里只放「跨端一致性」参数，不放纯实现细节（如某条滤波器的 Q）。
//   · 改这里 = 改两端。TS 侧有 test/unit/services/audioEffects/immersiveParams.test.ts 锁下限，
//     Kotlin 侧有 test/unit/android/ImmersiveParamsTest.kt 锁同一批数字。

/* ------------------------------------------------------------------------- */
/* 黑胶（Vinyl）                                                              */
/* ------------------------------------------------------------------------- */

/**
 * 黑胶参数。
 *
 * 抖晃以「秒」为单位的延时线摆动量表达（LFO → delayTime 的调制深度）；
 * 底噪 / 爆豆以「设置值 0..1 → 线性幅度」的系数表达（设置值 × 系数 = 增益）。
 */
export const VINYL_PARAMS = {
    /** 抖晃基准延时：4 ms。够短不会听成回声，够长所以能双向调制。 */
    baseDelaySeconds: 0.004,
    /** wow（慢飘）LFO 频率。 */
    wowHz: 0.55,
    /** flutter（抖）LFO 频率。 */
    flutterHz: 6.2,
    /**
     * wow 的最大深度（秒）：基准延时 × 0.3%（±0.3% 带速偏差）。
     * 再大就变成走音了。Kotlin 侧是同一物理量，只是以「相对带速的比例」存储。
     */
    wowDepthSeconds: 0.004 * 0.003,
    /** flutter 深度 = wow 深度 × 0.4。 */
    flutterDepthRatio: 0.4,
    /**
     * 底噪电平系数：noise = 1 时的线性增益。
     *
     * 乘以 createVinylNoiseBuffer 的实测 RMS（≈ 0.074，那段缓冲本身是「白噪声底 0.12 +
     * 稀疏爆豆」），底噪约 -60 dBFS；默认档（noise 0.25）约 -72 dBFS —— 安静但听得见。
     * 原生端的一阶噪声源 RMS ≈ 0.082，同系数下差 < 1 dB（见 ImmersiveParams.Vinyl）。
     */
    noiseLevelCoefficient: 0.012,
    /** 爆豆电平系数：crackle = 1 时单个脉冲的峰值（约 -34 dBFS，比底噪「脆」一点但不会盖住音乐）。 */
    crackleLevelCoefficient: 0.02,
} as const;

/* ------------------------------------------------------------------------- */
/* 夜间模式（Night）                                                          */
/* ------------------------------------------------------------------------- */

/**
 * 夜间模式参数。
 *
 * 两端**算法族不同**（桌面端是 DynamicsCompressor + 固定素材电平假设计算 make-up，
 * Android 端是实测 RMS 的纯 AGC），这里只对齐「语义」：目标响度范围、增益限幅、时间常数。
 * 见 NIGHT_TYPICAL_AVERAGE_DB 的说明。
 */
export const NIGHT_PARAMS = {
    /** 目标响度下限（近似 LUFS）。 */
    minTargetDb: -32,
    /** 目标响度上限（近似 LUFS）。 */
    maxTargetDb: -12,
    /** AGC / 补偿的增益限幅：两端都不许超出 ±18 dB。 */
    minGainDb: -18,
    maxGainDb: 18,
    /** 攻击时间（秒）：400 ms。 */
    attackSeconds: 0.4,
    /** 释放时间（秒）：2.5 s。广播常用取值。 */
    releaseSeconds: 2.5,
    /**
     * 桌面端的 make-up 假设：普通流行/影视素材的平均电平约 -18 dBFS。
     *
     * 桌面端读不回实时电平，只好假设素材平均电平固定是这一档，补偿量按
     * (target - 这一档) × 0.5 × strength 计算；Android 端有逐样本 RMS，直接按实测电平算。
     * 两者的**输出目标相同**（同为 targetLoudness 时实测响度差 < 2 dB），
     * 差别只在「是否相信素材电平」这一件事上 —— 详见 nightBranch.ts / ImmersiveStages.kt 的注释。
     */
    typicalAverageDb: -18,
    /** make-up 只补差额的一半（另一半由压缩器自己做掉）。 */
    makeupFraction: 0.5,
    /** make-up 上限（dB）：再高会把底噪一起推上来。 */
    makeupMaxLiftDb: 12,
} as const;

/* ------------------------------------------------------------------------- */
/* 交叉馈送（Crossfeed）                                                      */
/* ------------------------------------------------------------------------- */

export const CROSSFEED_PARAMS = {
    /** 串扰通路的低通：头部绕射开始明显衰减高频的位置。 */
    lowpassHz: 700,
    /** 延时范围（ms）。 */
    minDelayMs: 0.1,
    maxDelayMs: 1.0,
    /** 默认延时：头部绕射的经典值 0.3 ms。 */
    defaultDelayMs: 0.3,
} as const;

/* ------------------------------------------------------------------------- */
/* 环绕（Surround）                                                           */
/* ------------------------------------------------------------------------- */

/**
 * 环绕参数。
 *
 * Web 端用 PannerNode(HRTF) + output 增益表达「直达 / 湿声」；
 * Android 端用 参数化 HRTF 滤波器 + dry 系数表达同一件事。
 * 这里把两侧等价的量对齐：headphone / speaker 的干湿比、早期反射增益。
 */
export const SURROUND_PARAMS = {
    /** 虚拟扬声器基础方位角（度）：width = 1 时 ±30°。 */
    baseAngleDeg: 30,
    /** 张角滑杆范围。 */
    minWidth: 0.4,
    maxWidth: 1.6,
    /** 虚拟扬声器到听者距离（米）。 */
    speakerDistance: 1,
    /** 耳机模式：每个虚拟扬声器的直达声系数（Android 的 dry）。 */
    headphoneDirectGain: 0.72,
    /** 外放模式：每个虚拟扬声器的直达声系数。 */
    speakerDirectGain: 0.62,
    /** 耳机模式：整段湿声输出系数（桌面端 output.gain）。 */
    headphoneWetGain: 0.9,
    /** 外放模式：整段湿声输出系数 —— 干声多留、湿声压低，听起来是「更宽」而不是「更远」。 */
    speakerWetGain: 0.5,
    /**
     * 早期反射相对电平的总系数。
     *
     * 桌面端乘 0.45、Android 原先不乘 —— 同一份 roomAmount=0.35 时 Android 的反射比桌面端
     * 响 7 dB，房间感明显更"糊"。统一保留 0.45：真实小房间的早期反射在直达声之后
     * 6~12 dB 处到达，不乘 0.45 会落在 0~5 dB，听起来像"声音贴着后墙"。
     */
    earlyReflectionGain: 0.45,
    /** 早期反射的摆位：相对直达声的延时 / 电平 / 声像（小房间常见反射路径，1.3m ~ 4m 声程差）。 */
    earlyReflections: [
        { delayMs: 4.2, levelDb: -8, pan: -0.7 },
        { delayMs: 7.5, levelDb: -11, pan: 0.6 },
        { delayMs: 11.0, levelDb: -14, pan: -0.35 },
        { delayMs: 16.5, levelDb: -17, pan: 0.85 },
    ],
} as const;

/* ------------------------------------------------------------------------- */
/* 8D 环绕（Orbit）                                                           */
/* ------------------------------------------------------------------------- */

/**
 * 8D 的 wet/dry 公式。
 *
 *   wet = wetBase + depth × wetSpan
 *   dry = 1 - depth × drySpan
 *
 * depth = 0 时 wet = 0.4、dry = 1：旋转声部低占位，原声像完整保留；
 * depth = 1 时 wet = 1、dry = 0.3：旋转完全接管，但仍留一点干声锚住定位。
 */
export const ORBIT_PARAMS = {
    /** 旋转半径（米）。 */
    radiusMeters: 1,
    /** 一圈秒数范围。 */
    minPeriodSec: 4,
    maxPeriodSec: 30,
    /** wet = base + depth × span。 */
    wetBase: 0.4,
    wetSpan: 0.6,
    /** dry = 1 - depth × span。 */
    drySpan: 0.7,
} as const;

/* ------------------------------------------------------------------------- */
/* 超低音激励（Bass exciter）                                                 */
/* ------------------------------------------------------------------------- */

export const BASS_EXCITER_PARAMS = {
    /** amount 上限：再高谐波会盖过基频本身，听起来像嗡嗡声而不是低音。 */
    maxAmount: 0.9,
    /**
     * 整流曲线型：`1 = sqrt(x² + rectifyEpsilon)`（桌面端 WaveShaper 曲线），
     * `0 = |x|`（Android 端直接取绝对值）。
     *
     * 两者在数学上只差 ε 带来的零点平滑，听感等价 —— 但两端各按自己更省的做法实现，
     * 这个常量只是把「等价」这件事写进代码，防止哪天有人一边改成平方律。
     */
    rectifyCurve: 1,
    /** 分频点范围（Hz）。 */
    minCrossoverHz: 60,
    maxCrossoverHz: 200,
    /** 谐波高通：谐波必须从 80 Hz 以上才放得出来，否则又被喇叭滤掉了。 */
    harmonicHighpassHz: 80,
    /** 软整流曲线的平滑项：sqrt(x² + ε)，ε 越小零点越锐、毛刺越多。 */
    rectifyEpsilon: 1e-6,
} as const;

