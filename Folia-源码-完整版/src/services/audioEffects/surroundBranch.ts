import { rampParam } from './effectParams';
import { createReleaseTimer } from './effectBranchRelease';
import type { AudioConsoleSurround } from '../../utils/audioConsole';
import { SURROUND_PARAMS } from './immersiveParams';

// src/services/audioEffects/surroundBranch.ts
// HRTF 虚拟环绕：把「贴在耳朵上」的立体声变成「在脑袋前面」的一对音箱。
//
// 原理与原生 VirtualSurroundStage 逐条对应，只是这里借了 Web Audio 的 PannerNode：
//
//   真实音箱摆位时，左耳听到左箱的直达声 + 右箱经过头部绕射后的声音。绕射在两耳之间
//   产生三个差异 —— 时间差（ITD，约 0.3 ms）、强度差（ILD，高频最多 20 dB）、
//   以及耳廓的梳状滤波（HRTF 的频谱特征）。这三点合起来，大脑才判断出「声音在外面」。
//
//   · PannerNode 的 panningModel = 'HRTF' 做的就是这件事，而且用的是一组实测的 HRTF
//     数据（Chrome/Electron 内建 CIPIC 派生集），比手写参数化模型更准；
//   · 原生层没有现成的库，所以那边用的是 Woodworth 球头模型 + 简化耳廓滤波。
//     两边听感方向一致，细节不会完全一样 —— 这一点在说明里写清楚，不假装是同一份代码。
//
// 摆位：两个虚拟扬声器在听者前方 ±(30° · width)，距离 1 米。width 拉大，张角跟着变大。
// 另外叠四路早期反射（一面近墙 + 地面），成分来自单声道求和 —— 它们负责「房间有多大」。

/** 虚拟扬声器的基础方位角：width = 1 时 ±30°，标准立体声摆位。 */
const BASE_ANGLE_DEG = SURROUND_PARAMS.baseAngleDeg;

/** 虚拟扬声器到听者的距离（米）。只影响空气感，不影响声像。 */
const SPEAKER_DISTANCE = SURROUND_PARAMS.speakerDistance;

/**
 * 早期反射：相对直达声的延时、电平与声像。
 * 数值取自小房间的常见反射路径（1.3 m ~ 4 m 的声程差），与原生 EARLY_REFLECTIONS 一致，
 * 两端都从共享表取值（immersiveParams.ts 的 SURROUND_PARAMS）。
 */
const EARLY_REFLECTIONS: ReadonlyArray<{ delayMs: number; levelDb: number; pan: number }> =
    SURROUND_PARAMS.earlyReflections;

/**
 * 这条通路的开关与参数。
 *
 * 与其它分支不同，环绕的「强度」不是一个 0..1 的量，而是一组参数（模式 / 张角 / 房间量），
 * 所以 set 收的是整份设置而不是一个比例。
 */
export type SurroundBranch = {
    set: (settings: AudioConsoleSurround | null) => void;
    dispose: () => void;
};

type SurroundGraph = {
    /** 左右声道各自先切出来，才能分别送进两个虚拟扬声器。 */
    splitter: ChannelSplitterNode;
    leftIn: GainNode;
    rightIn: GainNode;
    leftPanner: PannerNode;
    rightPanner: PannerNode;
    /** 早期反射：单声道求和 → 四条延时线。 */
    monoSum: GainNode;
    reflections: Array<{ delay: DelayNode; pan: StereoPannerNode; gain: GainNode }>;
    /** 展宽之后的输出。 */
    out: GainNode;
};

const createSurroundGraph = (context: AudioContext): SurroundGraph => {
    const splitter = context.createChannelSplitter(2);
    const leftIn = context.createGain();
    const rightIn = context.createGain();
    const out = context.createGain();

    const createPanner = () => {
        const panner = context.createPanner();
        panner.panningModel = 'HRTF';
        // 只按方位角摆位，不做多普勒与距离衰减：声像要稳定，不能跟着播放速度飘。
        panner.distanceModel = 'inverse';
        panner.refDistance = SPEAKER_DISTANCE;
        panner.rolloffFactor = 0;
        panner.maxDistance = 10000;
        panner.positionY.value = 0;
        panner.positionZ.value = -SPEAKER_DISTANCE;
        return panner;
    };

    const leftPanner = createPanner();
    const rightPanner = createPanner();

    splitter.connect(leftIn, 0);
    splitter.connect(rightIn, 1);
    leftIn.connect(leftPanner);
    rightIn.connect(rightPanner);
    leftPanner.connect(out);
    rightPanner.connect(out);

    const monoSum = context.createGain();
    monoSum.gain.value = 0.5;
    splitter.connect(monoSum, 0);
    splitter.connect(monoSum, 1);

    const reflections = EARLY_REFLECTIONS.map(spec => {
        const delay = context.createDelay(0.1);
        delay.delayTime.value = spec.delayMs / 1000;
        const gain = context.createGain();
        gain.gain.value = 0;
        const pan = context.createStereoPanner();
        pan.pan.value = spec.pan;
        monoSum.connect(delay);
        delay.connect(gain);
        gain.connect(pan);
        pan.connect(out);
        return { delay, pan, gain };
    });

    return { splitter, leftIn, rightIn, leftPanner, rightPanner, monoSum, reflections, out };
};

/**
 * 建一条环绕通路。
 *
 * amount 为 0 时整条通路让路（湿声为 0），节点保留到 fade 结束 —— 拖滑杆来回切模式时
 * 不会每次重建 HRTF 卷积器（那是这张图里最贵的一次分配）。
 */
export const createSurroundBranch = (
    context: AudioContext,
    destination: AudioNode,
): SurroundBranch => {
    let graph: SurroundGraph | null = null;
    let output: GainNode | null = null;
    const release = createReleaseTimer();

    const teardown = () => {
        if (!graph || !output) return;
        try {
            graph.out.disconnect();
        } catch {
            // 上下文可能已经销毁。
        }
        Object.values(graph).forEach(value => {
            if (Array.isArray(value)) {
                value.forEach(item => {
                    item.delay.disconnect();
                    item.gain.disconnect();
                    item.pan.disconnect();
                });
                return;
            }
            if (value instanceof AudioNode) value.disconnect();
        });
        output?.disconnect();
        graph = null;
        output = null;
    };

    const build = () => {
        output = context.createGain();
        output.gain.value = 0;
        graph = createSurroundGraph(context);
        graph.out.connect(output);
        output.connect(destination);
    };

    return {
        set: (settings) => {
            const active = settings !== null && settings.mode !== 'off';
            if (active && settings) {
                release.cancel();
                if (!graph || !output) build();

                const width = Math.min(SURROUND_PARAMS.maxWidth, Math.max(SURROUND_PARAMS.minWidth, settings.width));
                const angle = (BASE_ANGLE_DEG * width * Math.PI) / 180;
                const x = SPEAKER_DISTANCE * Math.sin(angle);
                const z = -SPEAKER_DISTANCE * Math.cos(angle);
                // 等功率摆位：两个扬声器各自的位置写进去，PannerNode 自己算双耳滤波。
                rampParam(context, graph!.leftPanner.positionX, -x, 0.08);
                rampParam(context, graph!.leftPanner.positionZ, z, 0.08);
                rampParam(context, graph!.rightPanner.positionX, x, 0.08);
                rampParam(context, graph!.rightPanner.positionZ, z, 0.08);

                const room = Math.min(1, Math.max(0, settings.roomAmount));
                EARLY_REFLECTIONS.forEach((spec, index) => {
                    const gain = 10 ** (spec.levelDb / 20) * room * SURROUND_PARAMS.earlyReflectionGain;
                    rampParam(context, graph!.reflections[index].gain.gain, gain, 0.1);
                });

                // 外放模式不做双耳串扰（那会让单声道箱变闷），只保留展宽与早期反射：
                // 干声多留一些，湿声压下来，听起来是「更宽」而不是「更远」。
                // 系数与 Android VirtualSurroundStage 的 dry / 湿声系数同源（SURROUND_PARAMS）。
                const headphone = settings.mode === 'headphone';
                const direct = headphone ? SURROUND_PARAMS.headphoneDirectGain : SURROUND_PARAMS.speakerDirectGain;
                rampParam(context, graph!.leftIn.gain, direct, 0.1);
                rampParam(context, graph!.rightIn.gain, direct, 0.1);
                rampParam(context, output!.gain, headphone ? SURROUND_PARAMS.headphoneWetGain : SURROUND_PARAMS.speakerWetGain, 0.1);
                return;
            }

            if (!output) return;
            rampParam(context, output.gain, 0, 0.1);
            release.schedule(teardown);
        },
        dispose: () => {
            release.cancel();
            teardown();
        },
    };
};
