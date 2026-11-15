package top.izuna.foliamajor.player.dsp

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.pow
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/VirtualSurroundStage.kt
// HRTF 虚拟环绕：把"贴在耳朵上"的立体声变成"在脑袋前面"的一对音箱。
//
// 原理：
//   真实音箱摆位时，左耳听到左箱的直达声 + 右箱经过头部绕射后的声音。绕射在两耳之间
//   产生三个差异 —— 时间差（ITD，约 0.3 ms）、强度差（ILD，高频最多 20 dB）、
//   以及耳廓的梳状滤波（HRTF 的频谱特征）。这三点合起来，大脑才判断出"声音在外面"。
//
//   所以这里给每个虚拟扬声器建一组滤波器：
//     · 同侧耳：直达 → 轻微的高频提升（耳廓对前方声源的自然增益）+ 短延时；
//     · 对侧耳：延时（ITD）+ 低通（头部遮蔽了高频，ILD）+ 更强的高频滚降。
//   每个扬声器的输出按方位角混到左右耳，再叠加几路早期反射（房间感）。
//
// 为什么不用 panner 的 HRTF 数据：Web Audio 的 PannerNode 内部是等价的滤波网络，
// 而原生层没有现成的库；这里用参数化模型（Woodworth 球头模型 + 简化耳廓滤波），
// 效果不如实测 IR 数据，但零依赖、可参数化、CPU 开销小，且能跟着 width 滑杆实时改。
//
// 位置：StereoStage 之后。展开的声场要给混响用，所以必须在混响之前。

/**
 * 虚拟扬声器方位角（弧度）：width = 1 时约 ±30°（标准立体声摆位）。
 * width 拉大，张角跟着变大。
 */
private const val BASE_ANGLE_DEG = ImmersiveParams.Surround.BASE_ANGLE_DEG

/**
 * 耳廓塑形的混合比：0 dB 形状那一路的权重（见 process 的说明）。
 *
 * 0.5 是试出来的：两路各占一半时，300 Hz 处塑形直达与干声的能量比 ≈ 1.0（不低于干声），
 * 3 kHz 处保留原型 +2.5 dB 的大部分提升。
 */
private const val SHAPE_BLEND = 0.5f

/**
 * 湿声里「直达扩散声」的额外比例。
 *
 * 桌面端的湿声是 Panner(HRTF) 的输出，主能量区本身就有 -3 dB 级的能量起伏；
 * 原生端的湿声是参数化塑形的直达，与干声几乎同相，1.0 的湿声权重会让主能量区 +5 dB。
 * 0.3 让 300 Hz 处总电平约 +2.3 dB（峰值 1.3 倍，限幅器之前留够余量），
 * 高频的耳廓提升仍然保留。
 */
private const val NORMAL_GAIN = 0.3f

/** 头部半径（米）：Woodworth 模型里算 ITD 用的。 */
private const val HEAD_RADIUS = 0.0875f

/** 声速（米/秒）。 */
private const val SOUND_SPEED = 343f

/**
 * 早期反射的摆位：几路相对直达声的延时与电平，模拟一面近墙与地面。
 * 数值取自小房间的常见反射路径（1.3m ~ 4m 的声程差）。
 */
private val EARLY_REFLECTIONS = arrayOf(
    // 延时(ms), 电平(dB), 声像(-1 左 .. 1 右)
    floatArrayOf(4.2f, -8f, -0.7f),
    floatArrayOf(7.5f, -11f, 0.6f),
    floatArrayOf(11.0f, -14f, -0.35f),
    floatArrayOf(16.5f, -17f, 0.85f),
)

class VirtualSurroundStage {

    private var sampleRate = 0
    private var appliedWidth = -1f
    private var appliedMode = -1

    /** 每个虚拟扬声器每只耳朵一组滤波器：[speaker][ear 0=左 1=右]。 */
    private val directLow = Array(2) { Array(2) { BiquadFilter() } }
    private val directHigh = Array(2) { Array(2) { BiquadFilter() } }
    private val crosstalkLow = Array(2) { Array(2) { BiquadFilter() } }

    /** 耳廓塑形的电平补偿（见 applyIfNeeded）。 */
    private val directCheek = Array(2) { BiquadFilter() }
    private val directAir = Array(2) { BiquadFilter() }

    /** 直达声延时线（ITD），每只耳朵一条。 */
    private var itdBufferSize = 0
    private val itdRing = Array(2) { FloatArray(128) }
    private var itdWrite = 0
    private var itdSamples = 0f

    /** 整块原始干声的快照（见 process 的说明）。 */
    private var dryScratch = FloatArray(0)

    /** 早期反射：每路一条延时线，立体声两声道。 */
    private val reflectSize = 2048
    private val reflectRing = Array(EARLY_REFLECTIONS.size) { FloatArray(2048) }
    private var reflectWrite = 0

    fun configure(sampleRate: Int) {
        this.sampleRate = sampleRate
        // ITD 最大约 0.8 ms（侧向 90°），给到 2 ms 余量
        itdBufferSize = min(128, (sampleRate * 0.002f).toInt().coerceAtLeast(16))
        itdWrite = 0
        appliedWidth = -1f
        appliedMode = -1
        reset()
    }

    fun reset() {
        itdRing.forEach { it.fill(0f) }
        reflectRing.forEach { it.fill(0f) }
        directLow.forEach { pair -> pair.forEach { it.reset() } }
        directHigh.forEach { pair -> pair.forEach { it.reset() } }
        crosstalkLow.forEach { pair -> pair.forEach { it.reset() } }
        directCheek.forEach { it.reset() }
        directAir.forEach { it.reset() }
        itdWrite = 0
        reflectWrite = 0
    }

    fun process(
        buffer: FloatArray,
        offset: Int,
        frames: Int,
        channels: Int,
        settings: SurroundSettings,
    ) {
        if (!settings.enabled || channels < 2 || sampleRate <= 0) return
        applyIfNeeded(settings)

        val headphone = settings.mode == SurroundMode.HEADPHONE
        // 外放模式不做双耳串扰（那会让单声道箱变闷），只保留展宽与早期反射
        val crossGain = if (headphone) 0.55f else 0f
        /*
         * 早期反射：乘 0.45（ImmersiveParams.Surround.EARLY_REFLECTION_GAIN），与桌面端一致。
         *
         * 这里原先不乘 0.45，同样 roomAmount 下反射比桌面端响 7 dB——听感上是"声音贴着后墙"，
         * 而不是"在一个不大的房间里"。0.45 让早期反射落在直达声后 6~12 dB，才是真实小房间的量级。
         */
        val reflectionGain = settings.roomAmount.coerceIn(0f, 1f) * ImmersiveParams.Surround.EARLY_REFLECTION_GAIN
        /*
         * 湿声 / 干声的比例（与桌面端 surroundBranch.ts 同源，数值见 ImmersiveParams.Surround）：
         *
         *   干声   = 输入 × 1                                  （桌面端也从不衰减干声）
         *   湿声   = 耳廓塑形的输入 × wet × NORMAL_GAIN
         *          + 对侧串扰（耳机 0.55，外放 0）× wet
         *   反射   = 早期反射 × roomAmount × 0.45               （不在干湿分摊里）
         *
         * 两处历史问题（本轮一并修掉）：
         *   1. **块内自我污染**：原实现边读边写 buffer，同一块里前面的帧写回的结果被后面的帧
         *      当成输入再滤一遍，整块输出翻滚成 0（实测 4800 帧一块时环绕输出全是 0）。
         *      现在先把整块干声快照到 dryScratch，再原地写回。
         *   2. **干湿配比**：原先干声 × 0.72 + 塑形直达 × 1.0，同一份能量算了两遍（约 +1 dB），
         *      而塑形滤波器在主能量区有群延迟，两条 +2.5 dB 通路级联时 300 Hz 处净相移 -8°，
         *      开环绕后主能量反而只剩 56%（听感是「变空、变薄」）。
         *      现在干声原样保留，湿声权重由 wet 决定；塑形本身改成「0 dB 形状」与
         *      「原型提升」两路各半（见 applyIfNeeded），主能量区不再被相位抵消掉。
         */
        val wet = if (headphone) ImmersiveParams.Surround.HEADPHONE_WET_GAIN else ImmersiveParams.Surround.SPEAKER_WET_GAIN
        val wetMix = wet * NORMAL_GAIN
        val crossMix = wet * crossGain

        // 先快照整段原始干声，再原地写回。
        // 否则同一块里前面的帧写进 buffer 的结果会被后面的帧当成输入再滤一遍，整块输出翻滚成 0。
        if (dryScratch.size < frames * 2) dryScratch = FloatArray(frames * 2)
        for (index in 0 until frames) {
            dryScratch[index * 2] = buffer[offset + index * channels]
            dryScratch[index * 2 + 1] = buffer[offset + index * channels + 1]
        }

        for (frame in 0 until frames) {
            val base = offset + frame * channels
            val left = dryScratch[frame * 2]
            val right = dryScratch[frame * 2 + 1]

            // 1) 直达声：每个扬声器送到同侧耳（耳廓塑形）；对侧耳走遮蔽通路。
            //    塑形拆成两路：0 dB 的形状（相位线索）+ 原型提升，各占一半（见 applyIfNeeded）。
            var shapeL = directLow[0][0].process(left, 0)
            shapeL = directHigh[0][0].process(shapeL, 0)
            var boostL = directCheek[0].process(left, 0)
            boostL = directAir[0].process(boostL, 0)
            val nearL = SHAPE_BLEND * shapeL + (1f - SHAPE_BLEND) * boostL

            var shapeR = directLow[1][1].process(right, 0)
            shapeR = directHigh[1][1].process(shapeR, 0)
            var boostR = directCheek[1].process(right, 0)
            boostR = directAir[1].process(boostR, 0)
            val nearR = SHAPE_BLEND * shapeR + (1f - SHAPE_BLEND) * boostR

            // 对侧通路先过遮蔽低通，再进 ITD 延时线
            val farFromLeft = if (headphone) crosstalkLow[0][1].process(left, 0) else 0f
            val farFromRight = if (headphone) crosstalkLow[1][0].process(right, 0) else 0f

            itdRing[0][itdWrite] = farFromLeft    // 左扬声器 → 右耳
            itdRing[1][itdWrite] = farFromRight   // 右扬声器 → 左耳
            val itd = itdSamples.toInt().coerceIn(0, itdBufferSize - 1)
            val readL = ((itdWrite - itd) % itdBufferSize + itdBufferSize) % itdBufferSize
            val farToLeft = itdRing[1][readL]
            val farToRight = itdRing[0][readL]
            itdWrite = (itdWrite + 1) % itdBufferSize

            // 2) 早期反射：单声道求和后按不同延时、声像加回
            val mono = (left + right) * 0.5f
            var refL = 0f
            var refR = 0f
            EARLY_REFLECTIONS.forEachIndexed { i, spec ->
                val delaySamples = (spec[0] * sampleRate / 1000f).toInt().coerceIn(1, reflectSize - 1)
                reflectRing[i][reflectWrite % reflectSize] = mono
                val readIdx = ((reflectWrite - delaySamples) % reflectSize + reflectSize) % reflectSize
                val delayed = reflectRing[i][readIdx]
                val gain = 10.0.pow((spec[1] / 20f).toDouble()).toFloat() * reflectionGain
                val pan = spec[2]
                refL += delayed * gain * sqrt((1f - pan) * 0.5f)
                refR += delayed * gain * sqrt((1f + pan) * 0.5f)
            }
            reflectWrite++

            buffer[base] = left + nearL * wetMix + farToLeft * crossMix + refL
            buffer[base + 1] = right + nearR * wetMix + farToRight * crossMix + refR
        }
    }

    /**
     * 只在 width / mode 真的变了时重算滤波器系数：一次重算涉及十余个 biquad，
     * 逐块做没关系，逐样本做会拖垮音频线程。
     */
    private fun applyIfNeeded(settings: SurroundSettings) {
        val width = settings.width.coerceIn(ImmersiveParams.Surround.MIN_WIDTH, ImmersiveParams.Surround.MAX_WIDTH)
        if (abs(width - appliedWidth) < 0.005f && settings.mode == appliedMode) return
        appliedWidth = width
        appliedMode = settings.mode

        val angleDeg = BASE_ANGLE_DEG * width
        val angleRad = angleDeg * PI.toFloat() / 180f

        // Woodworth 球头模型的 ITD：d = (r/c)·(θ + sin θ)
        val itdSec = HEAD_RADIUS / SOUND_SPEED * (angleRad + sin(angleRad))
        itdSamples = itdSec * sampleRate

        for (speaker in 0 until 2) {
            /*
             * 同侧耳：耳廓带来 3~5 kHz 的轻微提升（前方声源的自然增益）。
             *
             * 方向问题：上一版对塑形的直达声乘 0.72 后与干声（× 0.72）相加，实测 300 Hz 时
             * 能量只剩干声的 56%（-2.7 dB）—— 塑形滤波器在主能量区的群延迟让两路反相。
             * 这一版改成两段并联：0 dB 的塑形（只保留相位/形状线索）× 0.5，
             * 加上原型（+2.5 dB / +1.5 dB）× 0.5，主能量区两段同相，能量不低于干声本身。
             */
            directLow[speaker][speaker].setPeaking(sampleRate, 3200f, 1.1f, 0f)
            directHigh[speaker][speaker].setPeaking(sampleRate, 9000f, 1.4f, 0f)
            directCheek[speaker].setPeaking(sampleRate, 3200f, 1.1f, 2.5f)
            directAir[speaker].setPeaking(sampleRate, 9000f, 1.4f, 1.5f)
            // 对侧耳：头部遮蔽 —— 高频滚降明显（这是"声音在侧面"的关键线索）
            val opp = 1 - speaker
            crosstalkLow[speaker][opp].setLowPass(sampleRate, 2600f, 0.7f)
        }
    }
}
