package top.izuna.foliamajor.player.dsp

import org.json.JSONObject

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/ImmersiveSettings.kt
// 沉浸音效的设置快照：虚拟环绕 / 交叉馈送 / 人声增强 / 夜间模式 / 黑胶 / 8D / 超低音。
//
// 与 Web 的 `AudioConsoleImmersive`（src/utils/audioConsole.ts）一一对应。字段全部可缺省：
// 老版本 WebView 推上来的包不带 `immersive`，此时每一项都按 NEUTRAL 兜底 —— 听感与升级前
// 完全一致，不会因为装了新包就突然"变声"。

/** 虚拟环绕的听感目标。 */
object SurroundMode {
    /** 关：整段跳过，不产生任何计算。 */
    const val OFF = 0
    /** 耳机：HRTF 双耳渲染 + 早期反射。 */
    const val HEADPHONE = 1
    /** 外放：轻度展宽 + 早期反射，不做双耳串扰。 */
    const val SPEAKER = 2

    fun clamp(value: Int): Int = value.coerceIn(OFF, SPEAKER)
}

/**
 * HRTF 虚拟环绕。
 *
 * 实现见 [VirtualSurroundStage]：左右声道分别经过一组按方位角计算的 HRTF 滤波器，
 * 再叠加早期反射，最后与干声按比例混合。
 */
class SurroundSettings(
    val mode: Int = SurroundMode.OFF,
    /** 虚拟扬声器张角 0.4 ~ 1.6（1.0 约 ±30°）。 */
    val width: Float = 1f,
    /** 房间反射量 0 ~ 1。 */
    val roomAmount: Float = 0.35f,
) {
    val enabled: Boolean get() = mode != SurroundMode.OFF

    companion object {
        val NEUTRAL = SurroundSettings()
    }
}

/**
 * 交叉馈送：耳机专用，把对侧声道延迟 + 衰减后混进来，模拟头部绕射。
 */
class CrossfeedSettings(
    val enabled: Boolean = false,
    /** 对侧串扰量 1 ~ 15 dB。 */
    val levelDb: Float = 8f,
    /** 对侧延时 0.1 ~ 1.0 ms。 */
    val delayMs: Float = 0.3f,
) {
    companion object {
        val NEUTRAL = CrossfeedSettings()
    }
}

/** 人声增强：1.2 ~ 4 kHz 的动态提升，只在人声能量高时推。 */
class VocalSettings(
    val enabled: Boolean = false,
    /** 提升深度 0 ~ 8 dB。 */
    val amountDb: Float = 4f,
) {
    companion object {
        val NEUTRAL = VocalSettings()
    }
}

/** 夜间模式：秒级 AGC，安静段落提上来、突响压回去。 */
class NightSettings(
    val enabled: Boolean = false,
    /** 压缩强度 0 ~ 1。 */
    val strength: Float = 0.5f,
    /** 目标响度 -32 ~ -12（近似 LUFS）。 */
    val targetLoudness: Float = -20f,
) {
    companion object {
        val NEUTRAL = NightSettings()
    }
}

/** 黑胶模拟：底噪 / 划痕 / 抖晃。 */
class VinylSettings(
    val enabled: Boolean = false,
    val noise: Float = 0.25f,
    val crackle: Float = 0.3f,
    val wow: Float = 0.5f,
) {
    companion object {
        val NEUTRAL = VinylSettings()
    }
}

/** 8D 环绕：声像在水平面上绕听者旋转。 */
class OrbitSettings(
    val enabled: Boolean = false,
    /** 一圈秒数 4 ~ 30。 */
    val periodSec: Float = 12f,
    /** 强度 0 ~ 1。 */
    val depth: Float = 0.8f,
) {
    companion object {
        val NEUTRAL = OrbitSettings()
    }
}

/** 超低音增强：谐波激励伪造低频，让手机喇叭也有低音感。 */
class BassSettings(
    val enabled: Boolean = false,
    /** 激励量 0 ~ 1。 */
    val amount: Float = 0.5f,
    /** 分频点 60 ~ 200 Hz。 */
    val crossoverHz: Float = 120f,
) {
    companion object {
        val NEUTRAL = BassSettings()
    }
}

/** 沉浸音效总成。 */
class ImmersiveSettings(
    val surround: SurroundSettings = SurroundSettings.NEUTRAL,
    val crossfeed: CrossfeedSettings = CrossfeedSettings.NEUTRAL,
    val vocal: VocalSettings = VocalSettings.NEUTRAL,
    val night: NightSettings = NightSettings.NEUTRAL,
    val vinyl: VinylSettings = VinylSettings.NEUTRAL,
    val orbit: OrbitSettings = OrbitSettings.NEUTRAL,
    val bass: BassSettings = BassSettings.NEUTRAL,
) {

    /** 七项全关：调用方据此整段跳过，零开销。 */
    fun isNeutral(): Boolean = !surround.enabled
        && !crossfeed.enabled
        && !vocal.enabled
        && !night.enabled
        && !vinyl.enabled
        && !orbit.enabled
        && !bass.enabled

    fun toJson(): JSONObject = JSONObject().apply {
        put("surround", JSONObject().apply {
            put("mode", surroundModeName(surround.mode))
            put("width", surround.width.toDouble())
            put("roomAmount", surround.roomAmount.toDouble())
        })
        put("crossfeed", JSONObject().apply {
            put("enabled", crossfeed.enabled)
            put("levelDb", crossfeed.levelDb.toDouble())
            put("delayMs", crossfeed.delayMs.toDouble())
        })
        put("vocal", JSONObject().apply {
            put("enabled", vocal.enabled)
            put("amountDb", vocal.amountDb.toDouble())
        })
        put("night", JSONObject().apply {
            put("enabled", night.enabled)
            put("strength", night.strength.toDouble())
            put("targetLoudness", night.targetLoudness.toDouble())
        })
        put("vinyl", JSONObject().apply {
            put("enabled", vinyl.enabled)
            put("noise", vinyl.noise.toDouble())
            put("crackle", vinyl.crackle.toDouble())
            put("wow", vinyl.wow.toDouble())
        })
        put("orbit", JSONObject().apply {
            put("enabled", orbit.enabled)
            put("periodSec", orbit.periodSec.toDouble())
            put("depth", orbit.depth.toDouble())
        })
        put("bass", JSONObject().apply {
            put("enabled", bass.enabled)
            put("amount", bass.amount.toDouble())
            put("crossoverHz", bass.crossoverHz.toDouble())
        })
    }

    companion object {
        val NEUTRAL = ImmersiveSettings()

        private fun surroundModeName(mode: Int): String = when (SurroundMode.clamp(mode)) {
            SurroundMode.HEADPHONE -> "headphone"
            SurroundMode.SPEAKER -> "speaker"
            else -> "off"
        }

        /** 解析 Web 推来的 `immersive` 段；整段缺席时返回 NEUTRAL。 */
        fun fromJson(json: JSONObject?): ImmersiveSettings {
            if (json == null) return NEUTRAL
            val surround = json.optJSONObject("surround")
            val crossfeed = json.optJSONObject("crossfeed")
            val vocal = json.optJSONObject("vocal")
            val night = json.optJSONObject("night")
            val vinyl = json.optJSONObject("vinyl")
            val orbit = json.optJSONObject("orbit")
            val bass = json.optJSONObject("bass")

            val mode = when (surround?.optString("mode", "off")) {
                "headphone" -> SurroundMode.HEADPHONE
                "speaker" -> SurroundMode.SPEAKER
                else -> SurroundMode.OFF
            }

            return ImmersiveSettings(
                surround = SurroundSettings(
                    mode = mode,
                    width = surround.number("width", 1.0, 0.4f, 1.6f),
                    roomAmount = surround.number("roomAmount", 0.35, 0f, 1f),
                ),
                crossfeed = CrossfeedSettings(
                    enabled = crossfeed?.optBoolean("enabled", false) == true,
                    levelDb = crossfeed.number("levelDb", 8.0, 1f, 15f),
                    delayMs = crossfeed.number("delayMs", 0.3, 0.1f, 1f),
                ),
                vocal = VocalSettings(
                    enabled = vocal?.optBoolean("enabled", false) == true,
                    amountDb = vocal.number("amountDb", 4.0, 0f, 8f),
                ),
                night = NightSettings(
                    enabled = night?.optBoolean("enabled", false) == true,
                    strength = night.number("strength", 0.5, 0f, 1f),
                    targetLoudness = night.number("targetLoudness", -20.0, -32f, -12f),
                ),
                vinyl = VinylSettings(
                    enabled = vinyl?.optBoolean("enabled", false) == true,
                    noise = vinyl.number("noise", 0.25, 0f, 1f),
                    crackle = vinyl.number("crackle", 0.3, 0f, 1f),
                    wow = vinyl.number("wow", 0.5, 0f, 1f),
                ),
                orbit = OrbitSettings(
                    enabled = orbit?.optBoolean("enabled", false) == true,
                    periodSec = orbit.number("periodSec", 12.0, 4f, 30f),
                    depth = orbit.number("depth", 0.8, 0f, 1f),
                ),
                bass = BassSettings(
                    enabled = bass?.optBoolean("enabled", false) == true,
                    amount = bass.number("amount", 0.5, 0f, 1f),
                    crossoverHz = bass.number("crossoverHz", 120.0, 60f, 200f),
                ),
            )
        }

        /** 与 EqSettings 里那个同名的私有扩展重复，但跨文件不可见，这里再写一份。 */
        private fun JSONObject?.number(key: String, fallback: Double, min: Float, max: Float): Float {
            val value = this?.optDouble(key, fallback) ?: fallback
            if (!value.isFinite()) return fallback.toFloat()
            return value.coerceIn(min.toDouble(), max.toDouble()).toFloat()
        }
    }
}
