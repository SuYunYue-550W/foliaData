import { rampParam } from './effectParams';
import { createReleaseTimer, type AudioEffectBranch } from './effectBranchRelease';
import { createVinylNoiseBuffer } from './effectSources';
import type { AudioConsoleVinyl } from '../../utils/audioConsole';
import { VINYL_PARAMS } from './immersiveParams';

// src/services/audioEffects/vinylBranch.ts
// 黑胶唱片模拟：底噪 + 爆豆/划痕 + 抖晃（wow & flutter）。
//
// 三部分各管一件事，与原生 VinylStage 一致：
//   · 底噪：粉红噪声（低频能量更多，像唱针在纹路里摩擦），电平很低；
//   · 爆豆：随机脉冲，密度与强度可调；
//   · 抖晃：带速的不稳定 —— 这是「黑胶味」里最关键的一条。0.55 Hz 那一路是 wow（慢飘），
//     6.2 Hz 那一路是 flutter（抖）。用两条 LFO 调制一条延时线的读取位置。
//
// 与老音效里那个 `wowBranch` / `noiseBranch` 的区别：那两条属于「老的音效」那一组
// （均衡器总开关管），这里属于沉浸音效，自己的开关、自己的三个量。两者都在链上，
// 同时打开会叠加 —— 这是有意的：黑胶那组是「听感预设」，这组是「细调」。

// 数值全部来自 immersiveParams.ts（与 Android ImmersiveParams.kt 同步）：
//   · 抖晃的基准延时 4 ms —— 够短所以不会听成「回声」，够长所以能双向调制；
//   · 两条 LFO：0.55 Hz 是慢飘，6.2 Hz 是抖动。
const WOW_BASE_DELAY_SECONDS = VINYL_PARAMS.baseDelaySeconds;

const WOW_HZ = VINYL_PARAMS.wowHz;
const FLUTTER_HZ = VINYL_PARAMS.flutterHz;

/**
 * 抖晃的最大深度，单位是秒。
 *
 * 「±0.3% 带速偏差」换算到延时线上：基准延时 4 ms，0.3% 就是 12 µs 的摆动 ——
 * 这个量级听起来是音高的轻微飘移，正是黑胶的味道；再大就变成走音了。
 */
const WOW_MAX_DEPTH = VINYL_PARAMS.wowDepthSeconds;
const FLUTTER_MAX_DEPTH = WOW_MAX_DEPTH * VINYL_PARAMS.flutterDepthRatio;

type VinylGraph = {
    /** 抖晃用的延时线。 */
    delay: DelayNode;
    wowLfo: OscillatorNode;
    wowDepth: GainNode;
    flutterLfo: OscillatorNode;
    flutterDepth: GainNode;
    /** 底噪与爆豆（一段循环的噪声缓冲）。 */
    noise: AudioBufferSourceNode;
    noiseFilter: BiquadFilterNode;
    noiseGain: GainNode;
    /** 爆豆单独一条：用同一段缓冲的另一份拷贝，滤波器不同（更亮更脆）。 */
    crackle: AudioBufferSourceNode;
    crackleFilter: BiquadFilterNode;
    crackleGain: GainNode;
};

export const createVinylBranch = (
    context: AudioContext,
    input: AudioNode,
    destination: AudioNode,
): AudioEffectBranch => {
    let graph: VinylGraph | null = null;
    let output: GainNode | null = null;
    const release = createReleaseTimer();

    const stopSource = (source: AudioBufferSourceNode | null) => {
        if (!source) return;
        try {
            source.stop();
        } catch {
            // 已经跟着上下文停了。
        }
        source.disconnect();
    };

    const stopOscillator = (oscillator: OscillatorNode | null) => {
        if (!oscillator) return;
        try {
            oscillator.stop();
        } catch {
            // 已经跟着上下文停了。
        }
        oscillator.disconnect();
    };

    const teardown = () => {
        if (!graph || !output) return;
        stopOscillator(graph.wowLfo);
        stopOscillator(graph.flutterLfo);
        stopSource(graph.noise);
        stopSource(graph.crackle);
        Object.values(graph).forEach(value => value.disconnect());
        try {
            output.disconnect();
        } catch {
            // 上下文可能已经销毁。
        }
        graph = null;
        output = null;
    };

    const build = () => {
        output = context.createGain();
        output.gain.value = 1;

        // 1) 抖晃：延时线串在主通路上。
        const delay = context.createDelay(0.05);
        delay.delayTime.value = WOW_BASE_DELAY_SECONDS;
        input.connect(delay);
        delay.connect(output);

        const wowLfo = context.createOscillator();
        wowLfo.frequency.value = WOW_HZ;
        const wowDepth = context.createGain();
        wowDepth.gain.value = 0;
        wowLfo.connect(wowDepth);
        wowDepth.connect(delay.delayTime);

        const flutterLfo = context.createOscillator();
        flutterLfo.frequency.value = FLUTTER_HZ;
        const flutterDepth = context.createGain();
        flutterDepth.gain.value = 0;
        flutterLfo.connect(flutterDepth);
        flutterDepth.connect(delay.delayTime);

        wowLfo.start();
        flutterLfo.start();

        // 2) 底噪与爆豆：同一段缓冲，两条不同滤波的通路。
        const buffer = createVinylNoiseBuffer(context);
        const noise = context.createBufferSource();
        noise.buffer = buffer;
        noise.loop = true;
        const noiseFilter = context.createBiquadFilter();
        noiseFilter.type = 'lowpass';
        noiseFilter.frequency.value = 5200;
        noiseFilter.Q.value = 0.4;
        const noiseGain = context.createGain();
        noiseGain.gain.value = 0;
        noise.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(output);

        const crackle = context.createBufferSource();
        crackle.buffer = buffer;
        crackle.loop = true;
        // 两条通路读同一段缓冲，但爆豆走高通：底噪是「沙」，爆豆是「啪」，频段分得开才像唱片。
        const crackleFilter = context.createBiquadFilter();
        crackleFilter.type = 'highpass';
        crackleFilter.frequency.value = 1400;
        crackleFilter.Q.value = 0.7;
        const crackleGain = context.createGain();
        crackleGain.gain.value = 0;
        crackle.connect(crackleFilter);
        crackleFilter.connect(crackleGain);
        crackleGain.connect(output);

        noise.start();
        crackle.start();

        output.connect(destination);

        graph = { delay, wowLfo, wowDepth, flutterLfo, flutterDepth, noise, noiseFilter, noiseGain, crackle, crackleFilter, crackleGain };
    };

    return {
        set: (level: number, settings?: AudioConsoleVinyl) => {
            const amounts = settings ? {
                noise: Math.max(0, Math.min(1, settings.noise)),
                crackle: Math.max(0, Math.min(1, settings.crackle)),
                wow: Math.max(0, Math.min(1, settings.wow)),
            } : { noise: 0, crackle: 0, wow: 0 };
            const active = level > 0 && Boolean(settings?.enabled)
                && (amounts.noise > 0.005 || amounts.crackle > 0.005 || amounts.wow > 0.005);

            if (active) {
                release.cancel();
                if (!graph) build();
                /*
                 * 三个量各自映射：
                 *   · 底噪 0.25 时大约是 -46 dBFS —— 安静但听得见，开到头也只在背景里；
                 *   · 爆豆比底噪更「显眼」，同一档位压得更低，否则会盖住音乐；
                 *   · 抖晃按带速百分比换算成延时线的摆动量（秒）。
                 */
                rampParam(context, graph!.noiseGain.gain, amounts.noise * VINYL_PARAMS.noiseLevelCoefficient * level, 0.15);
                rampParam(context, graph!.crackleGain.gain, amounts.crackle * VINYL_PARAMS.crackleLevelCoefficient * level, 0.15);
                rampParam(context, graph!.wowDepth.gain, amounts.wow * WOW_MAX_DEPTH, 0.15);
                rampParam(context, graph!.flutterDepth.gain, amounts.wow * FLUTTER_MAX_DEPTH, 0.15);
                return;
            }

            if (!graph) return;
            rampParam(context, graph.noiseGain.gain, 0, 0.15);
            rampParam(context, graph.crackleGain.gain, 0, 0.15);
            rampParam(context, graph.wowDepth.gain, 0, 0.15);
            rampParam(context, graph.flutterDepth.gain, 0, 0.15);
            release.schedule(teardown);
        },
        dispose: () => {
            release.cancel();
            teardown();
        },
    };
};
