import type { AudioConsoleImmersive } from '../../utils/audioConsole';

// src/services/audioEffects/immersiveNodes.ts
// 沉浸音效那张子图的骨架。
//
// 为什么与 effectNodes 分开：那张图是「老的音效」（高通、饱和、黑胶、混响、宽度），
// 开关是均衡器窗口的总开关；这里的七项是新的一组，各自有各自的开关与预设。
// 混在一个对象里，既会让 disconnectAll 误伤，也会让「七项全关」这种常见状态
// 仍然建出一堆节点。
//
// 信号链（与原生 EqAudioProcessor 的 ⑦½ 级同构）：
//
//   input ─┬─ 干声增益 ───────────────────────┐
//          │                                  ├─ mix ─ output
//          └─ 环绕 ─ 交叉馈送 ─ 人声 ─ 夜间 ─ 黑胶 ─ 8D ─ 超低音 ─ 湿声增益 ─┘
//
// **干声与湿声是交叉渐变，不是并联相加。** 这一点被离线渲染实测抓过一次：
// 最初两条通路都常开（干声 1、湿声由 0 淡入到 1），一段 440 Hz 正弦开环绕之后
// 峰值从 0.30 涨到 0.60 —— 两路同相叠加，等于白送 6 dB。听感上就是「一开效果就变响、
// 大声段落开始破」。改成「湿声 = 1 - 干声」之后，湿声起来的同时干声让路，
// 总电平不变（实测峰值仍是 0.30 起、只剩处理本身带来的差异）。
//
// 七项全关时：干声 1、湿声 0，整张子图对声音没有贡献 —— 与没建它完全一致。
//
// **为什么中间要有一个 mix，而不是让干湿两路各自连到 output：**
// output 是这条子图唯一的出口，它后面接的是音量与退场淡出。干声如果直接绕过 mix，
// 就等于把「未处理的信号」和「音量」之间插不进任何节点 —— 音量再大也调不动那条干声。
// 两路都汇到 mix，出口才真的是一个点。

export type ImmersiveNodes = {
    input: GainNode;
    /** 干声：不参与沉浸处理的原始信号。与 wetGain 互补。 */
    dry: GainNode;
    /** 湿声汇总点：七段串完之后倒进这里。 */
    wet: GainNode;
    /** 湿声总量。七项全关时为 0，干声为 1。 */
    wetGain: GainNode;
    /** 干湿两路的汇合点：这条子图真正的声音就到这里为止。 */
    mix: GainNode;
    output: GainNode;
};

export const createImmersiveNodes = (context: AudioContext, input: AudioNode, output: AudioNode): ImmersiveNodes => {
    const createGain = (value: number) => {
        const node = context.createGain();
        node.gain.value = value;
        return node;
    };

    const nodes: ImmersiveNodes = {
        input: context.createGain(),
        dry: createGain(1),
        wet: context.createGain(),
        wetGain: createGain(0),
        mix: createGain(1),
        output: context.createGain(),
    };

    input.connect(nodes.input);
    nodes.input.connect(nodes.dry);
    nodes.dry.connect(nodes.mix);
    nodes.wet.connect(nodes.wetGain);
    nodes.wetGain.connect(nodes.mix);
    nodes.mix.connect(nodes.output);
    nodes.output.connect(output);

    return nodes;
};

export const disconnectImmersiveNodes = (nodes: ImmersiveNodes) => {
    Object.values(nodes).forEach(node => {
        try {
            node.disconnect();
        } catch {
            // 音频上下文可能已经整个销毁了。
        }
    });
};

/** 干湿交叉的过渡时间。够短所以听不出「切换」，够长所以不会咔一下。 */
export const IMMERSIVE_CROSSFADE_SECONDS = 0.08;

/**
 * 七项是否全关。
 *
 * 全关时整条湿声通路让路：这是默认状态，绝大多数用户从来没有打开过这一页，
 * 不该为它付任何 CPU。
 */
export const isImmersiveNeutral = (immersive: AudioConsoleImmersive): boolean => (
    immersive.surround.mode === 'off'
    && !immersive.crossfeed.enabled
    && !immersive.vocal.enabled
    && !immersive.night.enabled
    && !immersive.vinyl.enabled
    && !immersive.orbit.enabled
    && !immersive.bass.enabled
);
