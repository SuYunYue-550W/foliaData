package top.izuna.foliamajor.player.dsp

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.log10
import kotlin.math.sin

// test/unit/android/ImmersiveEqDecoupleTest.kt
// EQ 总开关与沉浸音效解耦的回归。
//
// 旧行为：queueInput 开头的 `if (!settings.enabled || settings.isFlat())` 把整条 processor 直通，
// 连 ⑦½ 级的沉浸音效一起关掉 —— 用户在均衡器窗口关掉 EQ，环绕/交叉馈送也一起失效，
// 而桌面端的 immersiveChain 由独立开关驱动，不看均衡器总开关。
//
// 新行为：EQ 总开关只管 EQ 各级；沉浸音效只由 `immersive.isNeutral()` 决定。
// 这里用「EQ 关闭 + 环绕 headphone」的 16bit PCM 走一遍真实 processor，证明环绕仍然生效。

class ImmersiveEqDecoupleTest {

    private val sampleRate = 48000
    private val channels = 2
    private val frames = sampleRate / 2

    /** 1 kHz 正弦，振幅 0.2（约 -14 dBFS），左右相同。 */
    private fun tone(): ShortArray {
        val samples = ShortArray(frames * channels)
        for (frame in 0 until frames) {
            val value = (0.2 * sin(2.0 * PI * 1000.0 * frame / sampleRate) * Short.MAX_VALUE).toInt()
            for (channel in 0 until channels) samples[frame * channels + channel] = value.toShort()
        }
        return samples
    }

    private fun toBuffer(samples: ShortArray): ByteBuffer {
        val buffer = ByteBuffer.allocateDirect(samples.size * 2).order(ByteOrder.nativeOrder())
        for (sample in samples) buffer.putShort(sample)
        buffer.flip()
        return buffer
    }

    private fun readAll(buffer: ByteBuffer): ShortArray {
        val copy = buffer.duplicate().order(ByteOrder.nativeOrder())
        val out = ShortArray(copy.remaining() / 2)
        for (index in out.indices) out[index] = copy.short
        return out
    }

    private fun rmsDb(samples: ShortArray): Double {
        val start = (samples.size / 2 / channels) * channels
        var energy = 0.0
        var count = 0
        for (index in start until samples.size) {
            val value = samples[index] / Short.MAX_VALUE.toDouble()
            energy += value * value
            count += 1
        }
        return 10.0 * log10(energy / count)
    }

    private fun run(input: ShortArray, settings: EqSettings): ShortArray {
        NativeEqualizerState.apply(settings)
        val processor = EqAudioProcessor(NativeEqualizerState)
        processor.configure(AudioProcessor.AudioFormat(sampleRate, channels, C.ENCODING_PCM_16BIT))
        processor.flush()
        processor.queueInput(toBuffer(input))
        val result = readAll(processor.getOutput())
        processor.reset()
        return result
    }

    /**
     * EQ 关闭、环绕 headphone：处理器必须**改**过信号（早期反射 / HRTF 之后左右不再相同），
     * 而不是走直通。
     */
    private fun surroundOnly(eqEnabled: Boolean, mode: String = "headphone"): EqSettings = EqSettings.fromJson(
        JSONObject()
            .put("version", 3)
            .put("enabled", eqEnabled)
            .put("curve", "geq")
            .put("q", 1.4)
            .put("globalGainDb", 0)
            .put("gains", org.json.JSONArray().apply { repeat(10) { put(0L) } })
            .put(
                "immersive",
                JSONObject().put(
                    "surround",
                    JSONObject()
                        .put("mode", mode)
                        .put("width", 1.0)
                        .put("roomAmount", 0.8),
                ),
            ),
    )

    private fun channelDifference(samples: ShortArray): Double {
        var sum = 0.0
        val start = (samples.size / 2 / channels) * channels
        for (index in start until samples.size step channels) {
            val diff = samples[index] / Short.MAX_VALUE.toDouble() - samples[index + 1] / Short.MAX_VALUE.toDouble()
            sum += diff * diff
        }
        return Math.sqrt(sum / (samples.size / 2 / channels))
    }

    @Test
    fun `关掉 EQ 之后环绕仍然生效`() {
        val input = tone()
        val output = run(input, surroundOnly(eqEnabled = false))
        // 输入左右完全相同；只要环绕在跑，早期反射的声像与 HRTF 都会让左右分开。
        assertTrue("EQ 关闭后环绕被一起关掉了：左右仍然完全相同", channelDifference(output) > 1e-4)
    }

    @Test
    fun `EQ 关闭且沉浸七项全关时仍是逐字节直通`() {
        val input = tone()
        val output = run(input, surroundOnly(eqEnabled = false, mode = "off"))
        assertEquals("帧数不能变", input.size, output.size)
        var worst = 0
        for (index in input.indices) worst = maxOf(worst, kotlin.math.abs(input[index].toInt() - output[index].toInt()))
        assertTrue("两边都不需要处理时必须原样输出，最大偏差 $worst", worst <= 1)
    }

    @Test
    fun `行走完整条链时环绕同样生效`() {
        // 与上一个用例的差别只在「EQ 关闭」这一个开关上：如果仍按旧逻辑直通，这里同样全左=全右。
        val input = tone()
        val output = run(input, surroundOnly(eqEnabled = true))
        assertTrue("EQ 打开时环绕当然要生效", channelDifference(output) > 1e-4)
    }

    @Test
    fun `EQ 关闭不会把整体电平抬高`() {
        val input = tone()
        val output = run(input, surroundOnly(eqEnabled = false))
        val delta = rmsDb(output) - rmsDb(input)
        assertTrue("环绕单独生效时电平不应大幅变化，实测 $delta dB", delta in -6.0..6.0)
    }
}
