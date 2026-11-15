import { rampParam } from './effectParams';
import type { KaraokeMode } from '../../stores/useKaraokeModeStore';

// src/services/audioEffects/karaokeBranch.ts
// 伴唱模式：中/侧（mid/side）实时路由，三档 ——
//
//   off           干声直通，链路上只是多两个增益节点。
//   instrumental  伴奏（人声消除）：输出侧信号 L−R。人声通常摆在声场正中，
//                 中间分量一减，剩下的就是伴奏。经典卡拉 OK 机的那条路。
//   vocal         人声独唱：输出中信号 (L+R)/2，并用高通滤掉 150 Hz 以下的
//                 低频（贝斯与底鼓同样居中，只取中信号会把它们一起带上）。
//
// 为什么不走 htdemucs 分轨：那条管线只分离每首**头/尾各 30 秒的窗口**
// （automix/stems.ts STEM_WINDOW_SEC），是给过渡手势准备的素材，既不覆盖
// 整首歌，也不接受实时播放路由。伴唱要的是「正在播的这首立刻换听法」，
// 中/侧路由在 AudioParam 上做斜坡就能无缝切换 —— 不重载、不重新起播。
//
// 安卓原生（ExoPlayer）出声不经过这张图，所以该端灰置（见 useKaraokeModeStore）。

/** 独唱档切掉的低频：贝斯与底鼓居中，不切会跟着人声一起出来。 */
const VOCAL_HIGHPASS_HZ = 150;

/** 档位切换的斜坡：比 playbackFade 短，感受上是「立刻换了」而不是「淡入淡出」。 */
const SWITCH_TIME_CONSTANT = 0.06;

export type KaraokeBranch = {
    apply: (mode: KaraokeMode) => void;
    dispose: () => void;
};

type KaraokeNodes = {
    bypass: GainNode;
    instrumentalGain: GainNode;
    vocalGain: GainNode;
};

export const createKaraokeBranch = (
    context: AudioContext,
    input: AudioNode,
    output: AudioNode,
): KaraokeBranch => {
    const nodes: KaraokeNodes = {
        bypass: context.createGain(),
        instrumentalGain: context.createGain(),
        vocalGain: context.createGain(),
    };
    nodes.bypass.gain.value = 1;
    nodes.instrumentalGain.gain.value = 0;
    nodes.vocalGain.gain.value = 0;

    const teardown: Array<() => void> = [];
    const disconnect = (node: AudioNode) => {
        try {
            node.disconnect();
        } catch {
            // 已断开或上下文已销毁。
        }
    };

    try {
        // 干声直通。
        input.connect(nodes.bypass);
        nodes.bypass.connect(output);

        // 中/侧拆解。两个「和/差」各自由两条单声道支路相加而成：
        // splitter 的每一路都是单声道，接进同一个增益节点就是相加。
        const splitter = context.createChannelSplitter(2);

        // 侧信号 L−R：支路一乘 1，支路二乘 −1。
        const sideSum = context.createGain();
        const sideLeft = context.createGain();
        const sideRight = context.createGain();
        sideLeft.gain.value = 1;
        sideRight.gain.value = -1;
        splitter.connect(sideLeft, 0);
        splitter.connect(sideRight, 1);
        sideLeft.connect(sideSum);
        sideRight.connect(sideSum);
        sideSum.connect(nodes.instrumentalGain);
        nodes.instrumentalGain.connect(output);

        // 中信号 (L+R)/2：两路各乘 0.5，保持响度不翻倍。
        const midSum = context.createGain();
        const midLeft = context.createGain();
        const midRight = context.createGain();
        midLeft.gain.value = 0.5;
        midRight.gain.value = 0.5;
        splitter.connect(midLeft, 0);
        splitter.connect(midRight, 1);
        midLeft.connect(midSum);
        midRight.connect(midSum);

        const vocalHighpass = context.createBiquadFilter();
        vocalHighpass.type = 'highpass';
        vocalHighpass.frequency.value = VOCAL_HIGHPASS_HZ;
        vocalHighpass.Q.value = 0.7071;
        midSum.connect(vocalHighpass);
        vocalHighpass.connect(nodes.vocalGain);
        nodes.vocalGain.connect(output);

        input.connect(splitter);

        teardown.push(
            () => disconnect(nodes.bypass),
            () => disconnect(nodes.instrumentalGain),
            () => disconnect(nodes.vocalGain),
            () => disconnect(sideSum),
            () => disconnect(sideLeft),
            () => disconnect(sideRight),
            () => disconnect(midSum),
            () => disconnect(midLeft),
            () => disconnect(midRight),
            () => disconnect(vocalHighpass),
            () => disconnect(splitter),
        );
    } catch (error) {
        // 建到一半失败（上下文状态不允许等）：把已建的节点撤掉，直通兜底。
        teardown.forEach(dispose => dispose());
        throw error;
    }

    return {
        apply: (mode: KaraokeMode) => {
            const now = context.currentTime;
            rampParam(context, nodes.bypass.gain, mode === 'off' ? 1 : 0, SWITCH_TIME_CONSTANT);
            rampParam(context, nodes.instrumentalGain.gain, mode === 'instrumental' ? 1 : 0, SWITCH_TIME_CONSTANT);
            rampParam(context, nodes.vocalGain.gain, mode === 'vocal' ? 1 : 0, SWITCH_TIME_CONSTANT);
        },
        dispose: () => {
            teardown.forEach(dispose => dispose());
        },
    };
};
