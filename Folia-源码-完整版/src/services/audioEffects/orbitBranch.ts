import { rampParam } from './effectParams';
import { createReleaseTimer, type AudioEffectBranch } from './effectBranchRelease';
import type { AudioConsoleOrbit } from '../../utils/audioConsole';
import { ORBIT_PARAMS } from './immersiveParams';

// src/services/audioEffects/orbitBranch.ts
// 8D 环绕：声像在水平面上绕听者旋转。
//
// 「绕到脑后」在 Web Audio 里有一件比原生更好的工具：PannerNode 的 HRTF 模型会把方位角
// 换算成双耳滤波 —— 声音转到身后时，高频被「头」挡住、对侧耳朵听到的是绕射声，
// 大脑因此判断它在后面。原生层没有这份数据，只能做等功率声像（左右互换），
// 听感上是「左右来回」而不是「绕着转」。这一点在界面的说明里写清楚，不假装两边一样。
//
// 用法上两端一致：声像按一条 LFO 在水平面上转，periodSec 是一圈几秒，depth 是转多远。
// depth 为 0 时整段跳过（与不建这条通路等价）。

/** 环绕半径（米）：1 米是「手臂可及」的距离，HRTF 在这个距离上最自然。 */
const ORBIT_RADIUS = ORBIT_PARAMS.radiusMeters;

/**
 * 圆的参数：x = R·sin(θ)，z = -R·cos(θ)。
 *
 * 两个轴差 90°。OscillatorNode 没有相位参数，所以这里用两条同频振荡器：
 * 一条 sine 驱动 x，一条 cosine 驱动 z。cosine 用 `OscillatorNode.setPeriodicWave`
 * 造一个只有一次谐波、相位偏移 90° 的波形 —— 比「两条独立 LFO 靠频率碰巧相等」
 * 可靠得多：频率一改，两者永远同步。
 */
// 一次谐波：实部为 1 就是 cos，虚部为 1 就是 sin。
const COSINE_REAL = new Float32Array([0, 1]);
const COSINE_IMAG = new Float32Array([0, 0]);
const SINE_REAL = new Float32Array([0, 0]);
const SINE_IMAG = new Float32Array([0, 1]);

/**
 * PeriodicWave 绑定 context，不能跨 ctx 复用；但同一 context 反复 build 不必每次重造，
 * 按 context 用 WeakMap 缓存（context 被回收时缓存条目跟着走）。
 */
const periodicWaveCache = new WeakMap<AudioContext, { sin: PeriodicWave; cos: PeriodicWave }>();

const getPeriodicWaves = (context: AudioContext): { sin: PeriodicWave; cos: PeriodicWave } => {
    let waves = periodicWaveCache.get(context);
    if (!waves) {
        waves = {
            sin: context.createPeriodicWave(SINE_REAL, SINE_IMAG),
            cos: context.createPeriodicWave(COSINE_REAL, COSINE_IMAG),
        };
        periodicWaveCache.set(context, waves);
    }
    return waves;
};

type OrbitGraph = {
    panner: PannerNode;
    /** 左右分量：sin 相位。 */
    xLfo: OscillatorNode;
    xDepth: GainNode;
    /** 前后分量：cos 相位。 */
    zLfo: OscillatorNode;
    zDepth: GainNode;
    /** 未旋转的干声（depth < 1 时保留一部分原始声像）。 */
    dry: GainNode;
    /** 旋转之后的湿声。 */
    wet: GainNode;
};

export const createOrbitBranch = (
    context: AudioContext,
    input: AudioNode,
    destination: AudioNode,
): AudioEffectBranch => {
    let graph: OrbitGraph | null = null;
    let output: GainNode | null = null;
    const release = createReleaseTimer();

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
        stopOscillator(graph.xLfo);
        stopOscillator(graph.zLfo);
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
        const { sin, cos } = getPeriodicWaves(context);
        const panner = context.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = ORBIT_RADIUS;
        // 转一圈时距离不变，不该有音量起伏：rolloff 归零，半径恒为 1 米。
        panner.rolloffFactor = 0;
        panner.positionY.value = 0;

        const xLfo = context.createOscillator();
        xLfo.setPeriodicWave(sin);
        xLfo.frequency.value = 1 / 12;
        const xDepth = context.createGain();
        xDepth.gain.value = 0;
        xLfo.connect(xDepth);
        xDepth.connect(panner.positionX);

        const zLfo = context.createOscillator();
        zLfo.setPeriodicWave(cos);
        zLfo.frequency.value = 1 / 12;
        const zDepth = context.createGain();
        // 负号：开始时 z 朝前（-1 是听者正前方），一圈转下来是顺时针。
        zDepth.gain.value = 0;
        zLfo.connect(zDepth);
        zDepth.connect(panner.positionZ);

        xLfo.start();
        zLfo.start();

        const dry = context.createGain();
        dry.gain.value = 1;
        const wet = context.createGain();
        wet.gain.value = 0;
        const merged = context.createGain();

        input.connect(dry);
        dry.connect(merged);
        input.connect(panner);
        panner.connect(wet);
        wet.connect(merged);

        output = context.createGain();
        output.gain.value = 1;
        merged.connect(output);
        output.connect(destination);

        graph = { panner, xLfo, xDepth, zLfo, zDepth, dry, wet };
    };

    return {
        set: (amount: number, settings?: AudioConsoleOrbit) => {
            const active = amount > 0 && Boolean(settings?.enabled) && (settings?.depth ?? 0) > 0.01;
            if (active && settings) {
                release.cancel();
                if (!graph) build();
                const depth = Math.max(0, Math.min(1, settings.depth));
                const period = Math.min(ORBIT_PARAMS.maxPeriodSec, Math.max(ORBIT_PARAMS.minPeriodSec, settings.periodSec));
                const hz = 1 / period;
                rampParam(context, graph!.xLfo.frequency, hz, 0.2);
                rampParam(context, graph!.zLfo.frequency, hz, 0.2);
                // depth 决定圆的半径：0 时停在圆心（正前方），1 时是完整的 1 米圆。
                rampParam(context, graph!.xDepth.gain, depth * ORBIT_RADIUS, 0.2);
                rampParam(context, graph!.zDepth.gain, -depth * ORBIT_RADIUS, 0.2);
                // 旋转声部在 100% 时完全接管，低 depth 时与原声像并存（不会突然只剩一个点）。
                // 公式与系数见 immersiveParams.ts 的 ORBIT_PARAMS（depth = 0 时 wet = 0.4）。
                rampParam(context, graph!.wet.gain, ORBIT_PARAMS.wetBase + depth * ORBIT_PARAMS.wetSpan, 0.15);
                rampParam(context, graph!.dry.gain, 1 - depth * ORBIT_PARAMS.drySpan, 0.15);
                return;
            }

            if (!graph) return;
            rampParam(context, graph.wet.gain, 0, 0.15);
            rampParam(context, graph.dry.gain, 1, 0.15);
            release.schedule(teardown);
        },
        dispose: () => {
            release.cancel();
            teardown();
        },
    };
};
