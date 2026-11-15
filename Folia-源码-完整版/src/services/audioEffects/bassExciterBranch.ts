import { rampParam } from './effectParams';
import { createReleaseTimer, type AudioEffectBranch } from './effectBranchRelease';
import type { AudioConsoleBass } from '../../utils/audioConsole';
import { BASS_EXCITER_PARAMS } from './immersiveParams';

// src/services/audioEffects/bassExciterBranch.ts
// 超低音增强：谐波激励。
//
// 手机/笔记本喇叭放不出 60 Hz 以下，但人耳会把缺失基频的谐波「补」回来
// （missing fundamental）—— 这就是小喇叭也能有低音感的原因。所以这里不去加真低频
// （那只会让喇叭失真甚至烧掉），而是把低频整流后产生的二次/三次谐波加回去。
//
//   low = LP(buf, crossover)          // 取出低频段
//   env = |low|                        // 整流 → 产生直流与谐波
//   out = buf + amount · HPF(env, 80)  // 谐波本身在 80 Hz 以上，才放得出来
//
// 与原生 BassExciterStage 同构。不同的是 Web Audio 里没有逐样本的 abs()，
// 用 WaveShaper 做软整流（sqrt(x² + ε)），效果等价且不在零点产生毛刺。

/** 谐波必须从 80 Hz 以上才放得出来，否则又被喇叭滤掉了。 */
const HARMONIC_HIGHPASS_HZ = BASS_EXCITER_PARAMS.harmonicHighpassHz;

/** 软整流曲线：|x| 的平滑近似。 */
const createRectifyCurve = (samples = 2048): Float32Array<ArrayBuffer> => {
    const curve = new Float32Array(samples);
    for (let index = 0; index < samples; index += 1) {
        const input = (index / (samples - 1)) * 2 - 1;
        curve[index] = Math.sqrt(input * input + BASS_EXCITER_PARAMS.rectifyEpsilon);
    }
    return curve;
};

export const createBassExciterBranch = (
    context: AudioContext,
    input: AudioNode,
    destination: AudioNode,
): AudioEffectBranch => {
    let graph: {
        lowpass: BiquadFilterNode;
        rectify: WaveShaperNode;
        harmonicHigh: BiquadFilterNode;
        amount: GainNode;
    } | null = null;
    let output: GainNode | null = null;
    const release = createReleaseTimer();

    const teardown = () => {
        if (!graph || !output) return;
        Object.values(graph).forEach(node => node.disconnect());
        try {
            output.disconnect();
        } catch {
            // 上下文可能已经销毁。
        }
        graph = null;
        output = null;
    };

    const build = () => {
        const lowpass = context.createBiquadFilter();
        lowpass.type = 'lowpass';
        lowpass.frequency.value = 120;
        lowpass.Q.value = 0.7071;

        const rectify = context.createWaveShaper();
        rectify.curve = createRectifyCurve();

        const harmonicHigh = context.createBiquadFilter();
        harmonicHigh.type = 'highpass';
        harmonicHigh.frequency.value = HARMONIC_HIGHPASS_HZ;
        harmonicHigh.Q.value = 0.7071;

        const amount = context.createGain();
        amount.gain.value = 0;

        // 侧链：输入 → 低通 → 整流 → 高通的谐波 → 按比例加回输出。
        input.connect(lowpass);
        lowpass.connect(rectify);
        rectify.connect(harmonicHigh);
        harmonicHigh.connect(amount);

        output = context.createGain();
        output.gain.value = 1;
        // 干声直通，谐波并联叠上去。
        input.connect(output);
        amount.connect(output);
        output.connect(destination);

        graph = { lowpass, rectify, harmonicHigh, amount };
    };

    return {
        set: (level: number, settings?: AudioConsoleBass) => {
            const active = level > 0 && Boolean(settings?.enabled) && (settings?.amount ?? 0) > 0.01;
            if (active && settings) {
                release.cancel();
                if (!graph) build();
                const crossover = Math.min(
                    BASS_EXCITER_PARAMS.maxCrossoverHz,
                    Math.max(BASS_EXCITER_PARAMS.minCrossoverHz, settings.crossoverHz),
                );
                rampParam(context, graph!.lowpass.frequency, crossover, 0.1);
                // 上限 0.9：再高谐波会盖过基频本身，听起来像「嗡嗡声」而不是低音。
                rampParam(context, graph!.amount.gain, Math.min(BASS_EXCITER_PARAMS.maxAmount, settings.amount * BASS_EXCITER_PARAMS.maxAmount), 0.1);
                return;
            }

            if (!graph) return;
            rampParam(context, graph.amount.gain, 0, 0.1);
            release.schedule(teardown);
        },
        dispose: () => {
            release.cancel();
            teardown();
        },
    };
};
