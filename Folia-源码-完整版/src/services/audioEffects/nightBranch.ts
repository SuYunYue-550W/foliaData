import { rampParam, dbToLinear } from './effectParams';
import { createReleaseTimer, type AudioEffectBranch } from './effectBranchRelease';
import type { AudioConsoleNight } from '../../utils/audioConsole';
import { NIGHT_PARAMS } from './immersiveParams';

// src/services/audioEffects/nightBranch.ts
// 夜间模式（动态响度均衡）。
//
// 秒级 AGC：把整体响度往目标值上拉，安静段落提上来、突响压回去。与链末的限幅器分工不同：
// 限幅器管「不削波」（毫秒级、只在峰值上动），这里管「整首歌别忽大忽小」（秒级、改平均电平）。
//
// 关键是把时间常数放对：太快会跟着鼓点泵动（听感像在呼吸），太慢则跟不上段落切换。
// 这里用 400 ms 检测 + 2.5 s 释放，是广播里常用的取值，与原生 NightStage 一致。
//
// 实现上没有「读回 RMS」的手段，于是把这件事交给 DynamicsCompressorNode：
//   · 它的检测回路本来就是 RMS + 可配的攻击/释放；
//   · 阈值设成目标响度，比它响的段落被压回去；
//   · 比它安静的段落由 makeup（补偿增益）提上来 —— 这半边是「提升」，压缩器本身不做，
//     所以要自己算：目标响度与素材平均电平之间的差，就是补偿量。

/**
 * 目标响度 -32 ~ -12（近似 LUFS），与原生同一个范围。
 *
 * 与 Android NightStage 的**语义对齐**（数值见 immersiveParams.ts 的 NIGHT_PARAMS）：
 *   · 目标响度范围、增益限幅 ±18 dB、400 ms 攻击 / 2.5 s 释放 —— 两端同值；
 *   · 算法族**故意不同**：这里是 DynamicsCompressor（比率压 + 固定假设的 make-up），
 *     Android 是实测 RMS 的纯 AGC。结构级对齐成本太高，且各自在平台上都工作良好；
 *   · 两边都收敛到「同为 targetLoudness 时输出响度差 < 2 dB」：
 *       桌面端补偿量 = (target - TYPICAL_AVERAGE_DB) × 0.5 × strength（假设素材平均 -18 dBFS）；
 *       Android 端直接按实测电平把 RMS 拉到 target × strength。
 *     对 -18 dBFS 左右的普通素材两者几乎重合；偏离这档的素材，桌面端的补偿量会差
 *     (实测电平 - (-18)) × 0.5 × strength —— 见 NIGHT_PARAMS.typicalAverageDb 的注释。
 */
const NIGHT_MIN_TARGET = NIGHT_PARAMS.minTargetDb;
const NIGHT_MAX_TARGET = NIGHT_PARAMS.maxTargetDb;

/**
 * 压缩器的比率。
 *
 * 比率不跟着 strength 线性走：strength = 0 时应完全不动（比率 1），
 * strength = 1 时也只要「压平」而不是「压死」—— 4:1 已经能把电影的爆炸声按在台词后面。
 */
const ratioFor = (strength: number): number => 1 + Math.max(0, Math.min(1, strength)) * 3;

export const createNightBranch = (
    context: AudioContext,
    input: AudioNode,
    destination: AudioNode,
): AudioEffectBranch => {
    let compressor: DynamicsCompressorNode | null = null;
    let makeup: GainNode | null = null;
    const release = createReleaseTimer();

    const teardown = () => {
        if (!compressor || !makeup) return;
        try {
            makeup.disconnect();
        } catch {
            // 上下文可能已经销毁。
        }
        compressor.disconnect();
        compressor = null;
        makeup = null;
    };

    const build = () => {
        compressor = context.createDynamicsCompressor();
        compressor.knee.value = 8;
        compressor.attack.value = NIGHT_PARAMS.attackSeconds;
        compressor.release.value = NIGHT_PARAMS.releaseSeconds;
        makeup = context.createGain();
        makeup.gain.value = 1;
        input.connect(compressor);
        compressor.connect(makeup);
        makeup.connect(destination);
    };

    return {
        set: (amount: number, settings?: AudioConsoleNight) => {
            const active = amount > 0 && Boolean(settings?.enabled);
            if (active && settings) {
                release.cancel();
                if (!compressor || !makeup) build();

                const strength = Math.max(0, Math.min(1, settings.strength));
                const target = Math.min(NIGHT_MAX_TARGET, Math.max(NIGHT_MIN_TARGET, settings.targetLoudness));
                rampParam(context, compressor!.threshold, target, 0.2);
                rampParam(context, compressor!.ratio, ratioFor(strength), 0.2);

                /*
                 * 补偿量：压缩器把超出的部分按比率压下来，平均电平因此掉了一截；
                 * makeup 把被压掉的那一块补回来，让安静段落听得见。
                 *
                 * 这里不用「目标响度 - 素材实时平均电平」（Web 侧读不回电平），
                 * 而是用一条保守估计：普通流行/影视素材的平均电平约 -18 dBFS，
                 * 于是补偿 = (target - (-18)) 的一半，再乘上 strength。
                 * 一半，是因为压缩器自己已经做掉了一半的工作；乘 strength 是让强度滑杆
                 * 真的两头都有变化，而不是「只有阈值在动、响度没动」。
                 *
                 * ⚠️ 这就是与 Android 纯 AGC 的差异所在：那边有逐样本 RMS，不需要这条假设。
                 * 两端的对齐目标写在 NIGHT_PARAMS.typicalAverageDb 的注释里（同为 target 时 < 2 dB）。
                 */
                const liftDb = Math.max(0, target - NIGHT_PARAMS.typicalAverageDb)
                    * NIGHT_PARAMS.makeupFraction * strength;
                // 上限 +12 dB：再高会把底噪一起推上来。
                rampParam(context, makeup!.gain, dbToLinear(Math.min(NIGHT_PARAMS.makeupMaxLiftDb, liftDb)), 0.3);
                return;
            }

            if (!compressor || !makeup) return;
            // 关掉：比率回到 1（等于不压），补偿回到 0 dB —— 与没建这一段完全一样。
            rampParam(context, compressor.ratio, 1, 0.2);
            rampParam(context, makeup.gain, 1, 0.2);
            release.schedule(teardown);
        },
        dispose: () => {
            release.cancel();
            teardown();
        },
    };
};
