package top.izuna.foliamajor.player.dsp

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.pow
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/ImmersiveStages.kt
// 沉浸音效的各段处理，全部在音频渲染线程上逐样本运行。
//
// 位置：挂在 StereoStage 之后、ReverbStage 之前（见 EqAudioProcessor 的 ⑦½ 级）。
// 为什么在那儿：这些效果都在改「声场」的干声部分 —— 混响要听到处理之后的声场才有意义，
// 而饱和/压缩需要的是干净的、未展开的干声（先展开再压缩会把串扰当成信号一起压）。
//
// 每个阶段的约定一致：
//   · configure(sampleRate) 建立系数；process(...) 逐块处理；
//   · 关闭时 process 早退，不分配、不计算；
//   · reset() 清掉滤波器/延时线状态，seek 之后不会把上一段尾巴带进来。

/** 最大支持 4 对声道（8 声道），与 StereoStage / BiquadFilter 一致。 */
private const val MAX_PAIRS = 4

/** 交叉馈送的最大延时（秒）：1 ms 在 48 kHz 是 48 个样本，环形缓冲给到 2 ms 足够。 */
private const val CROSSFEED_MAX_DELAY_SEC = ImmersiveParams.Crossfeed.MAX_DELAY_SECONDS

/**
 * 交叉馈送（Crossfeed）。
 *
 * 耳机左右耳完全隔离，早期立体声录音（大量硬声像）听起来是"两坨声音贴在太阳穴上"，
 * 听久了很累。真实音箱摆位时，左耳也能听到右箱 —— 头部的绕射让对侧声音延时约
 * 0.3 ms、衰减 5~10 dB 之后到达。
 *
 *   L' = L + g·HF(R, delay)      R' = R + g·HF(L, delay)
 *
 * 对侧串扰只保留低频：真实头部的绕射对高频衰减更厉害（声波波长短，被头部挡住），
 * 所以串扰通路要过分频 —— 直接全频混进来会听起来"糊"，那正是廉价插件常犯的错。
 */
class CrossfeedStage {

    private var sampleRate = 0
    private var writeIndex = 0
    private var bufferSize = 0
    private val delayL = FloatArray(256)
    private val delayR = FloatArray(256)

    /** 串扰通路的低通（每对声道一份，避免左右互相污染状态）。 */
    private val lowL = Array(MAX_PAIRS) { BiquadFilter() }
    private val lowR = Array(MAX_PAIRS) { BiquadFilter() }

    private var appliedDelayMs = -1f
    private var appliedLevelDb = Float.NaN

    fun configure(sampleRate: Int) {
        this.sampleRate = sampleRate
        bufferSize = (sampleRate * CROSSFEED_MAX_DELAY_SEC).toInt().coerceIn(32, 256)
        writeIndex = 0
        appliedDelayMs = -1f
        appliedLevelDb = Float.NaN
        reset()
    }

    fun reset() {
        delayL.fill(0f)
        delayR.fill(0f)
        writeIndex = 0
        lowL.forEach { it.reset() }
        lowR.forEach { it.reset() }
    }

    fun process(
        buffer: FloatArray,
        offset: Int,
        frames: Int,
        channels: Int,
        settings: CrossfeedSettings,
    ) {
        if (!settings.enabled || channels < 2 || sampleRate <= 0) return
        applyIfNeeded(settings)

        val delaySamples = (settings.delayMs * sampleRate / 1000f).toInt()
            .coerceIn(1, bufferSize - 1)
        val gain = 10.0.pow((-abs(settings.levelDb) / 20f).toDouble()).toFloat()
        val pairs = minOf(channels / 2, MAX_PAIRS)

        for (frame in 0 until frames) {
            val base = offset + frame * channels
            val readIndex = (writeIndex - delaySamples + bufferSize) % bufferSize
            for (pair in 0 until pairs) {
                val left = buffer[base + pair * 2]
                val right = buffer[base + pair * 2 + 1]
                // 先把当前样本写进环形缓冲，再读延迟量
                delayL[writeIndex] = left
                delayR[writeIndex] = right
                // 对侧串扰：低频为主
                var crossToRight = lowL[pair].process(delayL[readIndex], 0)
                var crossToLeft = lowR[pair].process(delayR[readIndex], 0)
                crossToRight *= gain
                crossToLeft *= gain
                buffer[base + pair * 2] = left + crossToLeft
                buffer[base + pair * 2 + 1] = right + crossToRight
            }
            writeIndex = (writeIndex + 1) % bufferSize
        }
    }

    /** 串扰通路的低通固定 700 Hz：这是头部绕射开始明显衰减高频的位置（共享表 Crossfeed.LOWPASS_HZ）。 */
    private fun applyIfNeeded(settings: CrossfeedSettings) {
        if (abs(settings.delayMs - appliedDelayMs) < 0.001f && settings.levelDb == appliedLevelDb) return
        appliedDelayMs = settings.delayMs
        appliedLevelDb = settings.levelDb
        for (pair in 0 until MAX_PAIRS) {
            lowL[pair].setLowPass(sampleRate, ImmersiveParams.Crossfeed.LOWPASS_HZ, 0.7071f)
            lowR[pair].setLowPass(sampleRate, ImmersiveParams.Crossfeed.LOWPASS_HZ, 0.7071f)
        }
    }
}

/**
 * 人声增强（对白增强）。
 *
 * 不是固定的 EQ 提升 —— 那样会把整段音乐的 2~4 kHz 都抬起来，齿音变刺、底噪也上来。
 * 这里做的是**动态**处理：先把 1.2~4 kHz 的带通能量测出来，只有当它足够强（说明有人声）
 * 才提升这一段的增益；安静段落增益回到 0。
 *
 * 实现：带通抽头 → 包络跟随 → 增益 = amount · smoothed(envelope / threshold)。
 * 提升用一个 peaking 滤波器完成，它的增益随包络滑变（每块更新一次，避免逐样本重算系数）。
 */
class VocalStage {

    private var sampleRate = 0
    val bandPass = Array(MAX_PAIRS) { BiquadFilter() }
    val bandPass2 = Array(MAX_PAIRS) { BiquadFilter() }
    val shaper = Array(MAX_PAIRS) { BiquadFilter() }

    /** 包络（每对声道一份）。 */
    private val envelope = FloatArray(MAX_PAIRS)
    private var appliedGainDb = -99f

    /** 包络起落时间：起得快（80 ms）跟得上开口，落得慢（400 ms）不会在字与字之间抖。 */
    private val attackCoef = 0f
    private val releaseCoef = 0f

    fun configure(sampleRate: Int) {
        this.sampleRate = sampleRate
        appliedGainDb = -99f
        for (pair in 0 until MAX_PAIRS) {
            bandPass[pair].setHighPass(sampleRate, 1200f, 0.7071f)
            bandPass2[pair].setLowPass(sampleRate, 4000f, 0.7071f)
        }
        envelope.fill(0f)
    }

    fun reset() {
        bandPass.forEach { it.reset() }
        bandPass2.forEach { it.reset() }
        shaper.forEach { it.reset() }
        envelope.fill(0f)
        appliedGainDb = -99f
    }

    fun process(
        buffer: FloatArray,
        offset: Int,
        frames: Int,
        channels: Int,
        settings: VocalSettings,
    ) {
        if (!settings.enabled || settings.amountDb <= 0.01f || sampleRate <= 0) return
        val pairs = minOf(channels / 2, MAX_PAIRS)
        val attack = 1f - kotlin.math.exp(-1f / (0.080f * sampleRate))
        val release = 1f - kotlin.math.exp(-1f / (0.400f * sampleRate))
        val mono = channels == 1

        // 先量一遍人声频段的能量，得到这一块的平均包络
        var sum = 0f
        for (frame in 0 until frames) {
            val base = offset + frame * channels
            if (mono) {
                var v = buffer[base]
                v = bandPass[0].process(v, 0)
                v = bandPass2[0].process(v, 0)
                sum += abs(v)
            } else {
                for (pair in 0 until pairs) {
                    val mid = (buffer[base + pair * 2] + buffer[base + pair * 2 + 1]) * 0.5f
                    var v = bandPass[pair].process(mid, 0)
                    v = bandPass2[pair].process(v, 0)
                    val target = abs(v)
                    val coef = if (target > envelope[pair]) attack else release
                    envelope[pair] += (target - envelope[pair]) * coef
                    sum += envelope[pair]
                }
            }
        }
        val mean = if (mono) sum / max(frames, 1) else sum / max(frames * pairs, 1)
        // -26 dBFS 当作"有人声"的起点；低于这个值不提升。
        val activation = min(1f, max(0f, (mean - 0.05f) / 0.25f))
        val targetGainDb = settings.amountDb * activation
        if (abs(targetGainDb - appliedGainDb) < 0.05f) return
        appliedGainDb = targetGainDb
        for (pair in 0 until MAX_PAIRS) {
            shaper[pair].setPeaking(sampleRate, 2400f, 0.9f, targetGainDb)
        }

        for (frame in 0 until frames) {
            val base = offset + frame * channels
            if (mono) {
                buffer[base] = shaper[0].process(buffer[base], 0)
            } else {
                for (pair in 0 until pairs) {
                    buffer[base + pair * 2] = shaper[pair].process(buffer[base + pair * 2], 0)
                    buffer[base + pair * 2 + 1] = shaper[pair].process(buffer[base + pair * 2 + 1], 0)
                }
            }
        }
    }
}

/**
 * 夜间模式（动态响度均衡）。
 *
 * 秒级 AGC：把整体响度往目标值上拉，安静段落提上来、突响压回去。与链末的限幅器分工不同：
 * 限幅器管"不削波"（毫秒级、只在峰值上动），这里管"整首歌别忽大忽小"（秒级、改平均电平）。
 *
 * 关键是把时间常数放对：太快会跟着鼓点泵动（听感像在呼吸），太慢则跟不上段落的切换。
 * 这里用 400 ms 检测 + 2.5 s 释放，是广播里常用的取值。
 *
 * ⚠️ 与桌面端 nightBranch.ts 的差异（有意保留，数值见 ImmersiveParams.Night）：
 *   · 桌面端是 DynamicsCompressor：threshold = 目标响度，比率 1..4，再加一笔**假设**素材
 *     平均电平为 -18 dBFS 的 make-up（Web 侧读不回实时电平）；
 *   · 这里是纯 AGC：逐块实测 RMS，直接把电平拉到 targetLoudness × strength，不需要那条假设。
 *   两端收敛到「同为 targetLoudness 时输出响度差 < 2 dB」：普通 -18 dBFS 素材两者几乎重合，
 *   素材电平偏离 -18 dBFS 时桌面端的补偿会差 (实测 - (-18)) × 0.5 × strength。
 *   结构级对齐（把桌面端也改成逐样本 AGC）成本太高、收益只是抹平这段尾巴，故不做。
 */
class NightStage {

    private var sampleRate = 0
    private var agc = 1f
    private var measuredDb = -60f

    fun configure(sampleRate: Int) {
        this.sampleRate = sampleRate
        agc = 1f
        measuredDb = -60f
    }

    fun reset() {
        agc = 1f
        measuredDb = -60f
    }

    fun process(
        buffer: FloatArray,
        offset: Int,
        frames: Int,
        channels: Int,
        settings: NightSettings,
    ) {
        if (!settings.enabled || sampleRate <= 0) return

        // 1) 测这一块的 RMS
        var sum = 0f
        val count = frames * channels
        for (i in 0 until count) {
            val v = buffer[offset + i]
            sum += v * v
        }
        val rms = kotlin.math.sqrt(sum / max(count, 1))
        val db = if (rms > 1e-6f) 20f * kotlin.math.log10(rms) else -120f

        // 2) 平滑到秒级
        // 每秒的块数：时间常数换算成「每块」的系数。
        val blocksPerSecond = sampleRate.toFloat() / frames.coerceAtLeast(1)
        val detect = 1f - kotlin.math.exp(-1f / (ImmersiveParams.Night.ATTACK_SECONDS * blocksPerSecond))
        measuredDb += (db - measuredDb) * min(1f, detect)

        // 3) 目标增益：向 targetLoudness 靠，strength 决定靠多少
        val target = settings.targetLoudness.coerceIn(ImmersiveParams.Night.MIN_TARGET_DB, ImmersiveParams.Night.MAX_TARGET_DB)
        val err = (target - measuredDb) * settings.strength.coerceIn(0f, 1f)
        val targetGainDb = err.coerceIn(ImmersiveParams.Night.MIN_GAIN_DB, ImmersiveParams.Night.MAX_GAIN_DB)
        val targetGain = 10.0.pow((targetGainDb / 20f).toDouble()).toFloat()

        // 4) 增益本身也要平滑：2.5 秒释放，0.4 秒攻击
        val coef = if (targetGain < agc) {
            1f - kotlin.math.exp(-1f / (ImmersiveParams.Night.ATTACK_SECONDS * blocksPerSecond))
        } else {
            1f - kotlin.math.exp(-1f / (ImmersiveParams.Night.RELEASE_SECONDS * blocksPerSecond))
        }
        agc += (targetGain - agc) * min(1f, coef)

        for (i in 0 until count) {
            buffer[offset + i] *= agc
        }
    }
}

/**
 * 黑胶唱片模拟：底噪 + 爆豆/划痕 + 抖晃（wow & flutter）。
 *
 * 三部分各管一件事：
 *   · 底噪：粉红噪声（低频能量更多，像唱针在纹路里摩擦），电平很低；
 *   · 爆豆：随机脉冲，泊松分布，强度与密度可调；
 *   · 抖晃：带速的不稳定 —— 这是"黑胶味"里最关键的一条。用一条 LFO 调制读取位置，
 *     0.5 Hz 那一路是 wow（慢飘），6 Hz 那一路是 flutter（抖）。
 *
 * 实现上抖晃用变长延时线做变速读取（线性插值）。为了不引入巨大的延迟，只用环形缓冲
 * 里几毫秒的一段。
 *
 * 数值全部取自 ImmersiveParams.Vinyl（与桌面端 vinylBranch.ts 同源）：
 * 抖晃深度以「秒」表达（与桌面端 LFO → delayTime 的调制量是同一物理量），
 * 底噪 / 爆豆以「设置值 × 系数」表达。
 */
class VinylStage {

    private var sampleRate = 0
    private var writeIndex = 0
    private var bufferSize = 0
    private val ring = FloatArray(2048)
    private var phaseWow = 0f
    private var phaseFlutter = 0f
    private var rng = 0x9E3779B9.toInt()
    private val pinkState = FloatArray(MAX_PAIRS)

    fun configure(sampleRate: Int) {
        this.sampleRate = sampleRate
        bufferSize = min(2048, (sampleRate * 0.02f).toInt())
        writeIndex = 0
        reset()
    }

    fun reset() {
        ring.fill(0f)
        writeIndex = 0
        phaseWow = 0f
        phaseFlutter = 0f
        pinkState.fill(0f)
    }

    fun process(
        buffer: FloatArray,
        offset: Int,
        frames: Int,
        channels: Int,
        settings: VinylSettings,
    ) {
        if (!settings.enabled || sampleRate <= 0) return
        val wowAmount = settings.wow.coerceIn(0f, 1f)
        // 深度单位是秒：读取偏移 = (基准延时 + 摆动) × sampleRate，与桌面端同量纲。
        val wowDepth = wowAmount * ImmersiveParams.Vinyl.WOW_DEPTH_SECONDS
        val flutterDepth = wowAmount * ImmersiveParams.Vinyl.WOW_DEPTH_SECONDS * ImmersiveParams.Vinyl.FLUTTER_DEPTH_RATIO
        val noiseLevel = settings.noise.coerceIn(0f, 1f) * ImmersiveParams.Vinyl.NOISE_LEVEL_COEFFICIENT
        // 爆豆密度与幅度：与桌面端同一组系数（见 ImmersiveParams.Vinyl 的注释）。
        val crackleRate = settings.crackle.coerceIn(0f, 1f) * ImmersiveParams.Vinyl.CRACKLE_RATE_PER_UNIT
        val crackleAmp = settings.crackle.coerceIn(0f, 1f) * ImmersiveParams.Vinyl.CRACKLE_LEVEL_COEFFICIENT

        val wowInc = 2f * PI.toFloat() * ImmersiveParams.Vinyl.WOW_HZ / sampleRate
        val flutterInc = 2f * PI.toFloat() * ImmersiveParams.Vinyl.FLUTTER_HZ / sampleRate

        for (frame in 0 until frames) {
            // 抖晃：两条 LFO 加起来决定读取位置偏移
            phaseWow += wowInc
            if (phaseWow > 2f * PI.toFloat()) phaseWow -= 2f * PI.toFloat()
            phaseFlutter += flutterInc
            if (phaseFlutter > 2f * PI.toFloat()) phaseFlutter -= 2f * PI.toFloat()
            val drift = sin(phaseWow) * wowDepth + sin(phaseFlutter) * flutterDepth
            val delaySamples = (ImmersiveParams.Vinyl.BASE_DELAY_SECONDS + drift) * sampleRate
            val readF = writeIndex - delaySamples
            val readIndex = ((readF.toInt() % bufferSize) + bufferSize) % bufferSize
            val frac = readF - kotlin.math.floor(readF)
            val nextIndex = (readIndex + 1) % bufferSize
            val interpolatedL = ring[readIndex] * (1f - frac) + ring[nextIndex] * frac

            val base = offset + frame * channels
            for (ch in 0 until channels) {
                val src = buffer[base + ch]
                // 写入环形缓冲（所有声道共用一条，足够做带速抖动）
                if (ch == 0) ring[writeIndex] = src
                var out = interpolatedL
                // 粉红噪声（一阶低通近似）
                val white = nextRandom()
                pinkState[ch.coerceAtMost(MAX_PAIRS - 1)] = pinkState[ch.coerceAtMost(MAX_PAIRS - 1)] * 0.96f + white * 0.04f
                out += pinkState[ch.coerceAtMost(MAX_PAIRS - 1)] * noiseLevel * ImmersiveParams.Vinyl.NOISE_RMS_COMPENSATION
                // 爆豆
                if (nextRandom() < crackleRate / sampleRate) {
                    out += (nextRandom() * 2f - 1f) * crackleAmp
                }
                buffer[base + ch] = out
            }
            writeIndex = (writeIndex + 1) % bufferSize
        }
    }

    /** xorshift：不分配、够快，音质无关紧要的地方用它。返回 -1 ~ 1。 */
    private fun nextRandom(): Float {
        rng = rng xor (rng shl 13)
        rng = rng xor (rng ushr 17)
        rng = rng xor (rng shl 5)
        return (rng and 0x7FFFFFFF) / 1073741824f - 1f
    }
}

/**
 * 8D 环绕：声像在水平面上绕听者旋转。
 *
 * 用等功率声像（constant-power panning），每帧算出方位角，再把左右增益写成
 * 余弦/正弦 —— 这样旋转过程中总响度不变，不会转到正前/正后时音量忽大忽小。
 *
 * depth 控制"绕多远"：1 时转到脑后（左右完全互换），0 时不动。
 *
 * wet/dry 的公式与桌面端 orbitBranch.ts 相同（ImmersiveParams.Orbit）：
 * 旋转分量按 wet = 0.4 + depth × 0.6 加权，原始分量按 dry = 1 - depth × 0.7。
 * 原生端的等功率声像退化方式与桌面端 HRTF Panner 不同（没有「脑后」的耳廓滤波），
 * 但两端的干湿比例一致 —— 同一 depth 下总量不会一端更"飘"。
 */
class OrbitStage {

    private var sampleRate = 0
    private var angle = 0f

    fun configure(sampleRate: Int) {
        this.sampleRate = sampleRate
        angle = 0f
    }

    fun reset() {
        angle = 0f
    }

    fun process(
        buffer: FloatArray,
        offset: Int,
        frames: Int,
        channels: Int,
        settings: OrbitSettings,
    ) {
        if (!settings.enabled || channels < 2 || sampleRate <= 0) return
        val period = settings.periodSec.coerceIn(ImmersiveParams.Orbit.MIN_PERIOD_SEC, ImmersiveParams.Orbit.MAX_PERIOD_SEC)
        val depth = settings.depth.coerceIn(0f, 1f)
        // depth = 0 时旋转分量为 0、原始分量完整；depth = 1 时旋转接管 9 成，仍留一点干声锚住定位。
        val wet = ImmersiveParams.Orbit.WET_BASE + depth * ImmersiveParams.Orbit.WET_SPAN
        val dry = 1f - depth * ImmersiveParams.Orbit.DRY_SPAN
        val inc = 2f * PI.toFloat() / (period * sampleRate)
        val pairs = minOf(channels / 2, MAX_PAIRS)

        for (frame in 0 until frames) {
            angle += inc
            if (angle > 2f * PI.toFloat()) angle -= 2f * PI.toFloat()
            val pan = (sin(angle) + 1f) * 0.5f              // 0 = 全左, 1 = 全右
            val gl = cos(pan * PI.toFloat() * 0.5f)          // 等功率：gl² + gr² = 1
            val gr = sin(pan * PI.toFloat() * 0.5f)
            val base = offset + frame * channels
            for (pair in 0 until pairs) {
                val l = buffer[base + pair * 2]
                val r = buffer[base + pair * 2 + 1]
                val mid = (l + r) * 0.5f
                val side = (l - r) * 0.5f
                // 旋转分量：中置能量按等功率声像摆到当前位置，再乘 wet。
                // 原始的左右分量按 dry 保留（depth = 0 时 wet = 0.4、dry = 1，与桌面端公式一致）。
                val rotL = mid * wet * gl
                val rotR = mid * wet * gr
                buffer[base + pair * 2] = side * dry + mid * dry + rotL
                buffer[base + pair * 2 + 1] = -side * dry + mid * dry + rotR
            }
        }
    }
}

/**
 * 超低音增强：谐波激励。
 *
 * 手机/笔记本喇叭放不出 60 Hz 以下，但人耳会把缺失基频的谐波"补"回来（missing fundamental）——
 * 这就是小喇叭也能有低音感的原理。所以这里不去加真低频（那只会让喇叭失真甚至烧掉），
 * 而是把低频整流后产生的二次/三次谐波加回去。
 *
 *   low = LP(buf, crossover)          // 取出低频段
 *   env = |low|                        // 整流 → 产生直流与谐波
 *   out = buf + amount · HPF(env, 80)  // 谐波本身在 80 Hz 以上，才放得出来
 */
class BassExciterStage {

    private var sampleRate = 0
    private val lowPass = Array(MAX_PAIRS) { BiquadFilter() }
    private val harmonicHigh = Array(MAX_PAIRS) { BiquadFilter() }
    private var appliedHz = -1f

    fun configure(sampleRate: Int) {
        this.sampleRate = sampleRate
        appliedHz = -1f
        reset()
    }

    fun reset() {
        lowPass.forEach { it.reset() }
        harmonicHigh.forEach { it.reset() }
    }

    fun process(
        buffer: FloatArray,
        offset: Int,
        frames: Int,
        channels: Int,
        settings: BassSettings,
    ) {
        if (!settings.enabled || settings.amount <= 0.01f || sampleRate <= 0) return
        applyIfNeeded(settings.crossoverHz)
        // 上限 0.9（ImmersiveParams.Bass.MAX_AMOUNT，与桌面端一致）。
        val amount = settings.amount.coerceIn(0f, 1f) * ImmersiveParams.Bass.MAX_AMOUNT
        val pairs = minOf(channels / 2, MAX_PAIRS)
        val mono = channels == 1

        for (frame in 0 until frames) {
            val base = offset + frame * channels
            if (mono) {
                var low = lowPass[0].process(buffer[base], 0)
                low = harmonicHigh[0].process(abs(low), 0)
                buffer[base] += low * amount
            } else {
                for (pair in 0 until pairs) {
                    val mid = (buffer[base + pair * 2] + buffer[base + pair * 2 + 1]) * 0.5f
                    var low = lowPass[pair].process(mid, 0)
                    low = harmonicHigh[pair].process(abs(low), 0)
                    buffer[base + pair * 2] += low * amount
                    buffer[base + pair * 2 + 1] += low * amount
                }
            }
        }
    }

    private fun applyIfNeeded(hz: Float) {
        if (abs(hz - appliedHz) < 0.5f) return
        appliedHz = hz
        val crossover = hz.coerceIn(ImmersiveParams.Bass.MIN_CROSSOVER_HZ, ImmersiveParams.Bass.MAX_CROSSOVER_HZ)
        for (pair in 0 until MAX_PAIRS) {
            lowPass[pair].setLowPass(sampleRate, crossover, 0.7071f)
            // 谐波必须从 80 Hz 以上才放得出，否则又被喇叭滤掉了
            harmonicHigh[pair].setHighPass(sampleRate, ImmersiveParams.Bass.HARMONIC_HIGHPASS_HZ, 0.7071f)
        }
    }
}
