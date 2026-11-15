import { rampParam } from './effectParams';
import { createReleaseTimer, type AudioEffectBranch } from './effectBranchRelease';
import type { AudioConsoleCrossfeed } from '../../utils/audioConsole';
import { CROSSFEED_PARAMS } from './immersiveParams';

// src/services/audioEffects/crossfeedBranch.ts
// 交叉馈送：耳机专用。
//
// 耳机左右耳完全隔离，早期立体声录音（大量硬声像）听起来是「两坨声音贴在太阳穴上」，
// 听久了很累。真实音箱摆位时，左耳也能听到右箱 —— 头部的绕射让对侧声音延时约
// 0.3 ms、衰减 5~10 dB 之后到达。
//
//   L' = L + g·HF(R, delay)      R' = R + g·HF(L, delay)
//
// 对侧串扰只保留低频：真实头部的绕射对高频衰减更厉害（波长短，被头挡住），
// 所以串扰通路要过分频 —— 直接全频混进来会听起来「糊」，那正是廉价插件常犯的错。

/** 串扰通路的低通：700 Hz 是头部绕射开始明显衰减高频的位置，与原生一致（immersiveParams.ts）。 */
const CROSSFEED_LOWPASS_HZ = CROSSFEED_PARAMS.lowpassHz;

export const createCrossfeedBranch = (
    context: AudioContext,
    destination: AudioNode,
): AudioEffectBranch => {
    let graph: {
        splitter: ChannelSplitterNode;
        merger: ChannelMergerNode;
        direct: GainNode;
        leftToRight: { delay: DelayNode; filter: BiquadFilterNode; gain: GainNode };
        rightToLeft: { delay: DelayNode; filter: BiquadFilterNode; gain: GainNode };
    } | null = null;
    const release = createReleaseTimer();

    const teardown = () => {
        if (!graph) return;
        try {
            graph.merger.disconnect();
        } catch {
            // 上下文可能已经销毁。
        }
        Object.values(graph).forEach(value => {
            if (value instanceof AudioNode) value.disconnect();
            else if (typeof value === 'object' && value !== null) {
                Object.values(value).forEach(inner => {
                    if (inner instanceof AudioNode) inner.disconnect();
                });
            }
        });
        graph = null;
    };

    const build = () => {
        const splitter = context.createChannelSplitter(2);
        const merger = context.createChannelMerger(2);
        const direct = context.createGain();
        direct.gain.value = 1;

        const makeLeg = (source: number, target: number) => {
            const delay = context.createDelay(0.01);
            delay.delayTime.value = CROSSFEED_PARAMS.defaultDelayMs / 1000;
            const filter = context.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = CROSSFEED_LOWPASS_HZ;
            filter.Q.value = 0.7071;
            const gain = context.createGain();
            gain.gain.value = 0;
            // splitter 的每个输出是「一路声道」，不是「一个节点」：必须把声道号当输出号、
            // 0 当输入号一起给 —— 少了输入号，这一路会接不上（离线渲染实测：输出恒为 0）。
            splitter.connect(delay, source, 0);
            delay.connect(filter);
            filter.connect(gain);
            gain.connect(merger, 0, target);
            return { delay, filter, gain };
        };

        // 左声道 → 右耳，右声道 → 左耳。
        const leftToRight = makeLeg(0, 1);
        const rightToLeft = makeLeg(1, 0);

        splitter.connect(direct, 0, 0);
        splitter.connect(direct, 1, 0);
        direct.connect(merger, 0, 0);
        direct.connect(merger, 0, 1);
        merger.connect(destination);

        graph = { splitter, merger, direct, leftToRight, rightToLeft };
    };

    return {
        set: (amount: number, settings?: AudioConsoleCrossfeed) => {
            const active = amount > 0 && Boolean(settings?.enabled);
            if (active && settings) {
                release.cancel();
                if (!graph) build();
                const delaySec = Math.min(CROSSFEED_PARAMS.maxDelayMs, Math.max(CROSSFEED_PARAMS.minDelayMs, settings.delayMs)) / 1000;
                const level = 10 ** (-Math.abs(settings.levelDb) / 20);
                rampParam(context, graph!.leftToRight.delay.delayTime, delaySec, 0.05);
                rampParam(context, graph!.rightToLeft.delay.delayTime, delaySec, 0.05);
                // 串扰量与总开关的 amount 相乘：关掉整页时这一路也一起让路。
                rampParam(context, graph!.leftToRight.gain.gain, level * amount, 0.08);
                rampParam(context, graph!.rightToLeft.gain.gain, level * amount, 0.08);
                return;
            }

            if (!graph) return;
            rampParam(context, graph.leftToRight.gain.gain, 0, 0.08);
            rampParam(context, graph.rightToLeft.gain.gain, 0, 0.08);
            release.schedule(teardown);
        },
        dispose: () => {
            release.cancel();
            teardown();
        },
    };
};
