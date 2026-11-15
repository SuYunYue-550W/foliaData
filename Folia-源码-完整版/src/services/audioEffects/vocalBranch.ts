import { createReleaseTimer, type AudioEffectBranch } from './effectBranchRelease';
import type { AudioConsoleVocal } from '../../utils/audioConsole';

// src/services/audioEffects/vocalBranch.ts
// 人声增强（对白增强）。
//
// 不是固定的 EQ 提升 —— 那样会把整段音乐的 2~4 kHz 都抬起来，齿音变刺、底噪也上来。
// 这里做的是**动态**处理：先把 1.2~4 kHz 的带通能量测出来，只有当它足够强（说明有人声）
// 才提升这一段的增益；安静段落增益回到 0。
//
// 原生的 VocalStage 是逐样本跑包络；Web Audio 这边没有「读回信号」的手段，
// 于是换了一条等价的路：让带通后的信号自己驱动「提升多少」——
//
//   侧链 = bandpass(1.2–4 kHz) → 软整流（WaveShaper）→ 包络跟随（Compressor 的检测回路）
//   激活 = activationCurve(包络)  →  0..1 的「有人声程度」
//   增益 = 激活度 × amountDb      →  写进 peaking 滤波器的 gain（单位就是 dB）
//
// 起落时间与原生一致（攻击 80 ms / 释放 400 ms），激活阈值也同一条线（-26 dBFS）。

/** 人声频段的上下沿：与原生 VocalStage 一致。 */
const VOCAL_BAND_LOW_HZ = 1200;
const VOCAL_BAND_HIGH_HZ = 4000;

/** 提升作用的位置与带宽：2.4 kHz / Q 0.9，正好落在人声的「清晰度」区。 */
const VOCAL_BOOST_HZ = 2400;
const VOCAL_BOOST_Q = 0.9;

/** 激活阈值与斜坡：-26 dBFS 当作「有人声」的起点，与原生同一条线。 */
const VOCAL_ACTIVATION_FLOOR = 0.05;
const VOCAL_ACTIVATION_SPAN = 0.25;

type VocalGraph = {
    highpass: BiquadFilterNode;
    lowpass: BiquadFilterNode;
    /** 软整流：把交流变直流，才能当包络用。 */
    rectify: WaveShaperNode;
    /** 包络跟随：attack/release 与原生一致。 */
    envelope: DynamicsCompressorNode;
    /** 从包络值算 dB 的那一段曲线（0..1 → 0..1 的激活度）。 */
    activate: WaveShaperNode;
    /** 把激活度乘上 amountDb，写进 peaking 的 gain。 */
    depth: GainNode;
    boost: BiquadFilterNode;
};

/** 软整流曲线：|x| 的平滑近似，避免硬取绝对值在零点产生毛刺。 */
const createRectifyCurve = (samples = 1024): Float32Array<ArrayBuffer> => {
    const curve = new Float32Array(samples);
    for (let index = 0; index < samples; index += 1) {
        const input = (index / (samples - 1)) * 2 - 1;
        curve[index] = Math.sqrt(input * input + 1e-6);
    }
    return curve;
};

/**
 * 激活曲线：输入是整流后的包络（0..1），输出是「有人声的程度」（0..1）。
 * 低于 -26 dBFS 不推，超过 -12 dBFS 推满 —— 与原生 `(mean - 0.05) / 0.25` 同一条斜线。
 */
const createActivationCurve = (samples = 1024): Float32Array<ArrayBuffer> => {
    const curve = new Float32Array(samples);
    for (let index = 0; index < samples; index += 1) {
        const input = (index / (samples - 1)) * 2 - 1;
        const level = Math.abs(input);
        curve[index] = Math.min(1, Math.max(0, (level - VOCAL_ACTIVATION_FLOOR) / VOCAL_ACTIVATION_SPAN));
    }
    return curve;
};

export const createVocalBranch = (
    context: AudioContext,
    input: AudioNode,
    destination: AudioNode,
): AudioEffectBranch => {
    let graph: VocalGraph | null = null;
    let output: GainNode | null = null;
    const release = createReleaseTimer();

    const teardown = () => {
        if (!graph || !output) return;
        // 释放窗口内节点可能已被重复断开（或上下文已销毁），disconnect 会抛
        // InvalidAccessError —— 逐个包住，别让一个失败挡住后面的清理。
        Object.values(graph).forEach(node => {
            try {
                node.disconnect();
            } catch {
                // 已断开或上下文已销毁。
            }
        });
        try {
            output.disconnect();
        } catch {
            // 上下文可能已经销毁。
        }
        graph = null;
        output = null;
    };

    const build = () => {
        const highpass = context.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = VOCAL_BAND_LOW_HZ;
        highpass.Q.value = 0.7071;

        const lowpass = context.createBiquadFilter();
        lowpass.type = 'lowpass';
        lowpass.frequency.value = VOCAL_BAND_HIGH_HZ;
        lowpass.Q.value = 0.7071;

        const rectify = context.createWaveShaper();
        rectify.curve = createRectifyCurve();

        const envelope = context.createDynamicsCompressor();
        // 压缩器在这里只当「包络跟随器」用：拐点软、比率小，起落时间就是原生的那一对。
        envelope.threshold.value = -60;
        envelope.knee.value = 0;
        envelope.ratio.value = 1.2;
        envelope.attack.value = 0.08;
        envelope.release.value = 0.4;

        const activate = context.createWaveShaper();
        activate.curve = createActivationCurve();

        const depth = context.createGain();
        depth.gain.value = 0;

        const boost = context.createBiquadFilter();
        boost.type = 'peaking';
        boost.frequency.value = VOCAL_BOOST_HZ;
        boost.Q.value = VOCAL_BOOST_Q;
        boost.gain.value = 0;

        // 侧链与主通路并联：侧链只负责「算出该推多少」，不参与出声。
        input.connect(highpass);
        highpass.connect(lowpass);
        lowpass.connect(rectify);
        rectify.connect(envelope);
        envelope.connect(activate);
        activate.connect(depth);
        // 包络值（0..1）乘上 amountDb，直接写进 peaking 的 gain（单位就是 dB）。
        depth.connect(boost.gain);

        output = context.createGain();
        output.gain.value = 1;
        input.connect(boost);
        boost.connect(output);
        output.connect(destination);

        graph = { highpass, lowpass, rectify, envelope, activate, depth, boost };
    };

    return {
        set: (amount: number, settings?: AudioConsoleVocal) => {
            const active = amount > 0 && Boolean(settings?.enabled) && (settings?.amountDb ?? 0) > 0.01;
            if (active && settings) {
                release.cancel();
                if (!graph) build();
                graph!.depth.gain.value = Math.max(0, Math.min(8, settings.amountDb));
                return;
            }

            if (!graph) return;
            // 关掉时把 depth 归零：侧链照旧跑着（不耗多少），但不再推 gain。
            // 用短 ramp 而不是硬置 0：直接赋值会跳变出爆音，800ms 释放窗口反正兜底。
            const now = context.currentTime;
            graph.depth.gain.setTargetAtTime(0, now, 0.03);
            // 已经推上去的 gain 会停在上一次的值上，这里让 peaking 回到 0。
            graph.boost.gain.setTargetAtTime(0, now, 0.03);
            release.schedule(teardown);
        },
        dispose: () => {
            release.cancel();
            teardown();
        },
    };
};
