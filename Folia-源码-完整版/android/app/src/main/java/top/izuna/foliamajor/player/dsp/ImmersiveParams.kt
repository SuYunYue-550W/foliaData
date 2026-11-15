package top.izuna.foliamajor.player.dsp

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/ImmersiveParams.kt
// 沉浸音效的共享参数表（原生侧）。
//
// ⚠️ 本文件与 src/services/audioEffects/immersiveParams.ts **一一对应**。
//    改任何一项都必须两边一起改：桌面端与 Android 端听的是同一份用户设置，
//    数值不同 = 同一份设置两端听感不同（这正是本次审计要修的 bug）。
//    对应关系：
//      VINYL_PARAMS      ↔ ImmersiveParams.Vinyl
//      NIGHT_PARAMS      ↔ ImmersiveParams.Night
//      CROSSFEED_PARAMS  ↔ ImmersiveParams.Crossfeed
//      SURROUND_PARAMS   ↔ ImmersiveParams.Surround
//      ORBIT_PARAMS      ↔ ImmersiveParams.Orbit
//      BASS_EXCITER_PARAMS ↔ ImmersiveParams.Bass
//
// 数值基准是桌面端现值（用户日常听的是桌面端，听感基线不能漂）。
// 数值由 test/unit/android/ImmersiveParamsTest.kt 锁住，与 TS 侧测试断言同一批数字。

object ImmersiveParams {

    /**
     * 黑胶。
     *
     * 桌面端的抖晃以「延时线摆动多少秒」表达（LFO → delayTime 的调制深度），
     * 这里同样用秒：原生侧延时线也是一个 Delay 读取位置，物理量一致，
     * 直接乘 sampleRate 换算成样本偏移即可。
     *
     * 曾经原生侧用「相对带速比例」（wow × 0.003、flutter × 0.0012）再乘基准延时，
     * 得到的深度是桌面端的 2 倍（flutter 更是 2.5 倍），听感上黑胶明显更"飘"。
     * 现在两端都直接给出秒数，不再各自推导。
     */
    object Vinyl {
        /** 抖晃基准延时（秒）。 */
        const val BASE_DELAY_SECONDS = 0.004f
        /** wow（慢飘）LFO 频率。 */
        const val WOW_HZ = 0.55f
        /** flutter（抖）LFO 频率。 */
        const val FLUTTER_HZ = 6.2f
        /** wow 最大深度（秒）= 基准延时 × 0.3%（±0.3% 带速偏差）。 */
        const val WOW_DEPTH_SECONDS = 0.004f * 0.003f
        /** flutter 深度 = wow 深度 × 0.4。 */
        const val FLUTTER_DEPTH_RATIO = 0.4f
        /**
         * 底噪电平系数：noise = 1 时底噪的线性幅度（桌面端增益值）。
         *
         * 两端构造噪声的方式不同：桌面端用一段实测峰值的粉红噪声缓冲，直接把系数当增益；
         * 原生端是一阶低通噪声（峰值 ≈ 1，但 RMS 小得多），需要乘
         * [NOISE_RMS_COMPENSATION] 才能落到同一电平。换算由 ImmersiveParamsTest 守护。
         */
        const val NOISE_LEVEL_COEFFICIENT = 0.012f
        /** 爆豆电平系数：crackle = 1 时的脉冲峰值。 */
        const val CRACKLE_LEVEL_COEFFICIENT = 0.02f
        /**
         * 原生端噪声的幅度换算系数，相对桌面端 `createVinylNoiseBuffer`。
         *
         * 桌面端的那段缓冲本身就是「白噪声底 0.12 + 稀疏爆豆」，整体 RMS ≈ 0.074，
         * 而原生端的一阶低通噪声（out = 0.96·out + 0.04·white）RMS ≈ 0.082 —— 两者同量级。
         * 曾经原生端在这里再乘 6，底噪比桌面端响约 16 dB（开黑胶后整首歌"嘶"起来）。
         * 现在两端同系数、各自按自己的噪声源输出，差值 < 1 dB（用例实测守护）。
         */
        const val NOISE_RMS_COMPENSATION = 1f

        /**
         * 原生端爆豆的事件密度（次 / 秒）= crackle × 本系数。
         *
         * 桌面端缓冲里爆豆触发概率 0.0007 / 样本 ≈ 34 次 / 秒，一簇爆豆衰减到可闻以下约 15 ms。
         * 原生端原先用 crackle × 20 次 / 秒，听感明显更"稀"。统一到 30：crackle = 1 时
         * 每秒 30 次脉冲，与桌面端同密度。
         */
        const val CRACKLE_RATE_PER_UNIT = 30f
    }

    /**
     * 夜间模式。
     *
     * 两端**算法族不同**，这里只对齐语义：
     *   · 桌面端：DynamicsCompressor（threshold = target，比率 1..4）+ 固定假设的 make-up。
     *     Web 侧读不回实时电平，只好假设素材平均电平是 [TYPICAL_AVERAGE_DB]，
     *     补偿 = (target - 这一档) × [MAKEUP_FRACTION] × strength，上限 [MAKEUP_MAX_LIFT_DB]。
     *   · 原生端：逐样本 RMS → 秒级平滑 → 增益 = (target - 实测) × strength，限幅 ±18 dB，
     *     再按 0.4 s 攻击 / 2.5 s 释放平滑。不需要「素材平均电平」这条假设。
     *
     * 两端的收敛目标：**同为 targetLoudness、同一素材时，输出响度差 < 2 dB**。
     * 按 -18 dBFS 左右的普通流行素材实测，两者几乎重合；素材电平偏离 -18 dBFS 时，
     * 桌面端补偿会差 (实测 - (-18)) × 0.5 × strength，这是两端算法族不同带来的已知差异，
     * 不值得为了抹平它把桌面端改写成逐样本 AGC（代价是整条信号链多一个 ScriptProcessor）。
     */
    object Night {
        const val MIN_TARGET_DB = -32f
        const val MAX_TARGET_DB = -12f
        /** 增益限幅：两端都不许超出 ±18 dB。 */
        const val MIN_GAIN_DB = -18f
        const val MAX_GAIN_DB = 18f
        /** 攻击时间（秒）。 */
        const val ATTACK_SECONDS = 0.4f
        /** 释放时间（秒）。 */
        const val RELEASE_SECONDS = 2.5f
        /** 桌面端 make-up 的素材平均电平假设（dBFS）。原生端不使用，仅作对齐说明。 */
        const val TYPICAL_AVERAGE_DB = -18f
        /** 桌面端 make-up 只补差额的一半。 */
        const val MAKEUP_FRACTION = 0.5f
        /** 桌面端 make-up 上限（dB）。 */
        const val MAKEUP_MAX_LIFT_DB = 12f
    }

    /** 交叉馈送。 */
    object Crossfeed {
        /** 串扰通路低通：头部绕射开始明显衰减高频的位置。 */
        const val LOWPASS_HZ = 700f
        const val MIN_DELAY_MS = 0.1f
        const val MAX_DELAY_MS = 1.0f
        const val DEFAULT_DELAY_MS = 0.3f
        /** 环形缓冲的余量：最大延时之外的额外空间。 */
        const val MAX_DELAY_SECONDS = 0.002f
    }

    /**
     * 虚拟环绕。
     *
     * 「直达 / 湿声」两端的表达方式不同（桌面端是 Panner 输出 × output.gain，
     * 原生端是 left × dry + near + far × cross + reflection），
     * 这里把等价的干湿系数对齐，并统一早期反射的 0.45 总系数。
     */
    object Surround {
        const val BASE_ANGLE_DEG = 30f
        const val MIN_WIDTH = 0.4f
        const val MAX_WIDTH = 1.6f
        /** 耳机模式：直达声系数（桌面端 leftIn/rightIn gain）。 */
        const val HEADPHONE_DIRECT_GAIN = 0.72f
        /** 外放模式：直达声系数。 */
        const val SPEAKER_DIRECT_GAIN = 0.62f
        /** 耳机模式：湿声总系数（桌面端 output.gain）。 */
        const val HEADPHONE_WET_GAIN = 0.9f
        /** 外放模式：湿声总系数。 */
        const val SPEAKER_WET_GAIN = 0.5f
        /**
         * 早期反射总系数。
         *
         * 桌面端一直乘 0.45，原生端原先不乘 —— 同样 roomAmount 时原生端的反射响 7 dB，
         * 房间感"糊"到盖住直达声。统一保留 0.45：真实小房间的早期反射在直达声后 6~12 dB
         * 到达，不乘会落到 0~5 dB，听起来像声音贴着后墙。
         */
        const val EARLY_REFLECTION_GAIN = 0.45f
    }

    /**
     * 8D 环绕的 wet/dry 公式。
     *
     *   桌面端：wet = base + depth × span，dry = 1 - depth × span
     *   原生端用同一组系数表达「旋转分量 / 原始分量」：
     *     rot = depth × span'，dry = 1 - rot（depth = 0 时 wet 等效 0.4、dry 1）
     */
    object Orbit {
        const val MIN_PERIOD_SEC = 4f
        const val MAX_PERIOD_SEC = 30f
        const val WET_BASE = 0.4f
        const val WET_SPAN = 0.6f
        const val DRY_SPAN = 0.7f
    }

    /** 超低音激励。 */
    object Bass {
        /** amount 上限：再高谐波会盖过基频。 */
        const val MAX_AMOUNT = 0.9f
        const val MIN_CROSSOVER_HZ = 60f
        const val MAX_CROSSOVER_HZ = 200f
        const val HARMONIC_HIGHPASS_HZ = 80f
        /** 软整流平滑项（桌面端 sqrt(x² + ε)）。原生端用 |x|，语义等价。 */
        const val RECTIFY_EPSILON = 1e-6f
    }
}
