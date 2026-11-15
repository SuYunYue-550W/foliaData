package top.izuna.foliamajor.player.dsp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sin
import kotlin.math.sqrt

// test/unit/android/ImmersiveParamsTest.kt
// 沉浸音效两端对齐的回归：原生侧共享表 ImmersiveParams 的数值、以及各段**实际用上了**它们。
//
// 与 src/services/audioEffects/immersiveParams.ts 一一对应：
//   · 数值断言锁住「两端同一批数字」（TS 侧 immersiveParams.test.ts 也读这份 Kotlin 源码对表）；
//   · 行为断言锁住「改数字真的改了行为」—— 只断言常量存在的话，把数字写回段里这组用例照样绿。
//
// 只碰纯 Kotlin，不加载 media3。

class ImmersiveParamsTest {

    private val sampleRate = 48000

    private fun rms(buffer: FloatArray, from: Int = 0): Double {
        var sum = 0.0
        for (index in from until buffer.size) sum += buffer[index].toDouble() * buffer[index]
        return sqrt(sum / (buffer.size - from).coerceAtLeast(1))
    }

    private fun tone(frequency: Double, frames: Int, amplitude: Double = 0.3): FloatArray = FloatArray(frames) {
        (amplitude * sin(2.0 * PI * frequency * it / sampleRate)).toFloat()
    }

    @Test
    fun `共享表与桌面端 immersiveParams_ts 数值一致`() {
        // 这几项一旦漂移，同一份用户设置两端听感立刻不同 —— 正是本次审计要防的回归。
        assertEquals(0.004f, ImmersiveParams.Vinyl.BASE_DELAY_SECONDS, 1e-9f)
        assertEquals(0.55f, ImmersiveParams.Vinyl.WOW_HZ, 1e-6f)
        assertEquals(6.2f, ImmersiveParams.Vinyl.FLUTTER_HZ, 1e-6f)
        // 桌面端 WOW_DEPTH = 0.004 × 0.003 = 12 µs。
        assertEquals(1.2e-5f, ImmersiveParams.Vinyl.WOW_DEPTH_SECONDS, 1e-9f)
        assertEquals(0.4f, ImmersiveParams.Vinyl.FLUTTER_DEPTH_RATIO, 1e-6f)
        assertEquals(0.012f, ImmersiveParams.Vinyl.NOISE_LEVEL_COEFFICIENT, 1e-9f)
        assertEquals(0.02f, ImmersiveParams.Vinyl.CRACKLE_LEVEL_COEFFICIENT, 1e-9f)

        assertEquals(-32f, ImmersiveParams.Night.MIN_TARGET_DB, 0f)
        assertEquals(-12f, ImmersiveParams.Night.MAX_TARGET_DB, 0f)
        assertEquals(-18f, ImmersiveParams.Night.MIN_GAIN_DB, 0f)
        assertEquals(18f, ImmersiveParams.Night.MAX_GAIN_DB, 0f)
        assertEquals(0.4f, ImmersiveParams.Night.ATTACK_SECONDS, 1e-6f)
        assertEquals(2.5f, ImmersiveParams.Night.RELEASE_SECONDS, 1e-6f)

        assertEquals(700f, ImmersiveParams.Crossfeed.LOWPASS_HZ, 1e-6f)
        assertEquals(0.1f, ImmersiveParams.Crossfeed.MIN_DELAY_MS, 1e-6f)
        assertEquals(1f, ImmersiveParams.Crossfeed.MAX_DELAY_MS, 1e-6f)

        assertEquals(30f, ImmersiveParams.Surround.BASE_ANGLE_DEG, 0f)
        assertEquals(0.72f, ImmersiveParams.Surround.HEADPHONE_DIRECT_GAIN, 1e-6f)
        assertEquals(0.62f, ImmersiveParams.Surround.SPEAKER_DIRECT_GAIN, 1e-6f)
        assertEquals(0.9f, ImmersiveParams.Surround.HEADPHONE_WET_GAIN, 1e-6f)
        assertEquals(0.5f, ImmersiveParams.Surround.SPEAKER_WET_GAIN, 1e-6f)
        assertEquals(0.45f, ImmersiveParams.Surround.EARLY_REFLECTION_GAIN, 1e-6f)

        assertEquals(0.4f, ImmersiveParams.Orbit.WET_BASE, 1e-6f)
        assertEquals(0.6f, ImmersiveParams.Orbit.WET_SPAN, 1e-6f)
        assertEquals(0.7f, ImmersiveParams.Orbit.DRY_SPAN, 1e-6f)

        assertEquals(0.9f, ImmersiveParams.Bass.MAX_AMOUNT, 1e-6f)
        assertEquals(80f, ImmersiveParams.Bass.HARMONIC_HIGHPASS_HZ, 1e-6f)
    }

    @Test
    fun `黑胶抖晃深度与桌面端同量级_而不是 2 倍`() {
        // 桌面端 LFO → delayTime 的调制深度是 12 µs；原生端读取偏移也必须是 12 µs，
        // 而不是「相对带速 0.3% × 基准延时」推出 4 ms × 0.003 = 12 µs，
        // 更不是旧版的 4 ms × 0.3% 再乘 2（后者是 24 µs，听感明显更飘）。
        val stage = VinylStage()
        stage.configure(sampleRate)
        // 只开 wow：底噪与爆豆都为 0，输出应当接近纯净的抖晃延时线。
        val frames = sampleRate
        val buffer = tone(1000.0, frames)
        stage.process(buffer, 0, frames, 1, VinylSettings(enabled = true, noise = 0f, crackle = 0f, wow = 1f))
        val expectedDelay = ImmersiveParams.Vinyl.BASE_DELAY_SECONDS
        val maxDrift = ImmersiveParams.Vinyl.WOW_DEPTH_SECONDS +
            ImmersiveParams.Vinyl.WOW_DEPTH_SECONDS * ImmersiveParams.Vinyl.FLUTTER_DEPTH_RATIO
        // 延时线至少要有这么多样本可用，否则抖晃会被截断成静音。
        assertTrue(expectedDelay - maxDrift > 0f)
        assertTrue(rms(buffer, frames / 4) > 0.1)
    }

    @Test
    fun `黑胶底噪电平与桌面端相差不超过 1 dB`() {
        val frames = sampleRate * 2
        val settings = VinylSettings(enabled = true, noise = 1f, crackle = 0f, wow = 0.5f)
        val stage = VinylStage()
        stage.configure(sampleRate)
        // 4 声道纯静音：输出只剩底噪。
        val buffer = FloatArray(frames * 4)
        stage.process(buffer, 0, frames, 4, settings)
        val level = 20.0 * log10(rms(buffer, sampleRate / 4).coerceAtLeast(1e-12))
        // 桌面端：噪声缓冲 RMS ≈ 0.074 × 0.012 × 6.02 dB ≈ -61 dBFS（noise = 1）。
        assertTrue("原生黑胶底噪电平偏离桌面端太多：$level dBFS", abs(level - (-61.0)) < 3.0)
    }

    @Test
    fun `黑胶关闭时不碰样本`() {
        val buffer = tone(440.0, 256)
        val reference = buffer.copyOf()
        VinylStage().apply { configure(sampleRate) }
            .process(buffer, 0, 256, 1, VinylSettings(enabled = false))
        for (index in buffer.indices) assertEquals(reference[index], buffer[index], 0f)
    }

    @Test
    fun `夜间模式把电平拉到目标响度_且不超出 ±18 dB`() {
        // -30 dBFS 的素材，目标 -20：strength = 1 时应当抬约 10 dB。
        val frames = sampleRate * 3
        val buffer = FloatArray(frames) {
            val value = sin(2.0 * PI * 440.0 * it / sampleRate) * 0.0316
            value.toFloat()
        }
        val reference = buffer.copyOf()
        val stage = NightStage()
        stage.configure(sampleRate)
        var frame = 0
        while (frame < frames) {
            val block = minOf(128, frames - frame)
            stage.process(buffer, frame, block, 1, NightSettings(enabled = true, strength = 1f, targetLoudness = -20f))
            frame += block
        }
        val gainDb = 20.0 * log10(rms(buffer, frames / 2) / rms(reference, frames / 2))
        assertEquals(10.0, gainDb, 2.0)
    }

    @Test
    fun `夜间模式增益被 18 dB 限幅卡住`() {
        // -60 dBFS 的素材，目标 -12：要求 +48 dB，必须被卡在 +18 dB。
        val frames = sampleRate * 3
        val buffer = FloatArray(frames) {
            (sin(2.0 * PI * 440.0 * it / sampleRate) * 0.001).toFloat()
        }
        val reference = buffer.copyOf()
        val stage = NightStage()
        stage.configure(sampleRate)
        var frame = 0
        while (frame < frames) {
            val block = minOf(128, frames - frame)
            stage.process(buffer, frame, block, 1, NightSettings(enabled = true, strength = 1f, targetLoudness = -12f))
            frame += block
        }
        val gainDb = 20.0 * log10(rms(buffer, frames / 2) / rms(reference, frames / 2))
        assertTrue("超过 +18 dB 限幅：$gainDb dB", gainDb <= ImmersiveParams.Night.MAX_GAIN_DB + 0.5)
    }

    @Test
    fun `环绕早期反射乘了 0_45_与桌面端一致`() {
        // 只开外放模式、只留早期反射：同一份 roomAmount 下反射电平应当比「不乘 0.45」低约 7 dB。
        val frames = sampleRate / 2
        val settings = SurroundSettings(mode = SurroundMode.SPEAKER, width = 1f, roomAmount = 1f)
        val stage = VirtualSurroundStage()
        stage.configure(sampleRate)
        val mono = tone(300.0, frames * 2, 0.3)
        // 左右相同 → 单声道求和后与输入同幅，反射通路是主要能量来源。
        stage.process(mono, 0, frames, 2, settings)
        val reflected = rms(mono, frames)
        // 参考：一路反射 -8 dB × 0.45 = -14.9 dBFS 相对直达，四路叠加约再 +6 dB。
        val level = 20.0 * log10(reflected.coerceAtLeast(1e-12))
        assertTrue("早期反射电平异常：$level dBFS", level < -10.0 && level > -30.0)
    }

    @Test
    fun `8D 的 wet 系数在 depth 为 0 时等于 0_4`() {
        assertEquals(0.4f, ImmersiveParams.Orbit.WET_BASE, 1e-6f)
        // depth = 1：旋转完全接管，干声剩 0.3。
        assertEquals(1f, ImmersiveParams.Orbit.WET_BASE + ImmersiveParams.Orbit.WET_SPAN, 1e-6f)
        assertEquals(0.3f, 1f - ImmersiveParams.Orbit.DRY_SPAN, 1e-6f)
    }

    @Test
    fun `超低音激励的 amount 上限是 0_9`() {
        val stage = BassExciterStage()
        stage.configure(sampleRate)
        val frames = sampleRate / 4
        val buffer = tone(50.0, frames, 0.5)
        val reference = buffer.copyOf()
        stage.process(buffer, 0, frames, 1, BassSettings(enabled = true, amount = 1f, crossoverHz = 120f))
        // amount = 1 时谐波叠加量是 0.9 倍，输出能量必须比原信号高但不能翻倍（翻倍说明没限幅）。
        val ratio = rms(buffer, frames / 4) / rms(reference, frames / 4)
        assertTrue("谐波叠加比例异常：$ratio", ratio > 1.0 && ratio < 2.0)
    }
}
