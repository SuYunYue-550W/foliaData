import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    BASS_EXCITER_PARAMS,
    CROSSFEED_PARAMS,
    NIGHT_PARAMS,
    ORBIT_PARAMS,
    SURROUND_PARAMS,
    VINYL_PARAMS,
} from '@/services/audioEffects/immersiveParams';
import { createOrbitBranch } from '@/services/audioEffects/orbitBranch';
import { createVinylBranch } from '@/services/audioEffects/vinylBranch';
import { DEFAULT_AUDIO_CONSOLE_SETTINGS } from '@/utils/audioConsole';

// test/unit/services/audioEffects/immersiveParams.test.ts
// 共享参数表是两端听感对齐的唯一来源（另一头是 android/.../dsp/ImmersiveParams.kt）。
//
// 这里断言两件事：
//   1. 表里的关键数值落在「合理范围」里 —— 不是复述源码，而是锁住物理意义
//      （crackle 系数不能大到盖住音乐，depth = 0 时 wet 必须回到 0.4，等等）；
//   2. 分支文件确实**用**了这张表 —— 用假节点建一遍图，看滑杆被写成什么值。
//      只断言常量存在的话，改回去把数字写死在分支里这组用例照样全绿。

/** 建图之后能读到每个 GainNode 的**目标值**：rampParam 在离线/假上下文里最终落在 .value 上。 */
type FakeParam = {
    value: number;
    cancelScheduledValues: (time: number) => void;
    setTargetAtTime: (value: number) => void;
};

type FakeNode = {
    kind: string;
    connect: (target?: unknown, output?: number, input?: number) => void;
    disconnect: () => void;
    gain?: FakeParam;
    delayTime?: FakeParam;
    frequency?: FakeParam;
    [key: string]: unknown;
};

/**
 * 够建黑胶 / 8D 两条分支的最小 AudioContext（参考 playbackGraph.test.ts 的 FakeNode 写法）。
 *
 * 每个建出来的节点都记进 `created`，测试按 kind 取出来看它被写成了什么值 ——
 * 这样断言的是「分支真的用了共享表」，而不是「常量存在」。
 */
const createFakeContext = () => {
    const created: FakeNode[] = [];
    const param = (value = 0): FakeParam => {
        const self: FakeParam = {
            value,
            cancelScheduledValues: () => {},
            // 记录目标值：rampParam 只会走 setTargetAtTime，记下来就是分支「要求」的电平。
            setTargetAtTime: (next: number) => { self.value = next; },
        };
        return self;
    };
    const node = (kind: string, extra: Record<string, unknown> = {}): FakeNode => {
        const self: FakeNode = {
            kind,
            connect: () => {},
            disconnect: () => {},
            ...extra,
        };
        created.push(self);
        return self;
    };
    const context = {
        sampleRate: 48_000,
        currentTime: 0,
        // 任意两个节点都能连：这里的假节点只是「接线不掉就行」，分支不关心接到哪。
        createGain: () => node('gain', { gain: param(1), connect: () => {} }),
        createDelay: () => node('delay', { delayTime: param(0) }),
        createOscillator: () => node('oscillator', {
            frequency: param(0), start: () => {}, stop: () => {}, setPeriodicWave: () => {},
        }),
        createBiquadFilter: () => node('biquad', { type: 'lowpass', frequency: param(), Q: param() }),
        createBufferSource: () => node('source', { buffer: null, loop: false, start: () => {}, stop: () => {} }),
        // 分支拿到的 input / destination 是「外部节点」，只需要能接上。
        connectable: { connect: () => {}, disconnect: () => {} },
        createBuffer: (channels: number, length: number) => ({
            numberOfChannels: channels,
            getChannelData: () => new Float32Array(length),
        }),
        createPanner: () => node('panner', {
            positionX: param(0), positionY: param(0), positionZ: param(0),
            setPeriodicWave: () => {},
        }),
        createPeriodicWave: () => ({}),
    };
    return { context: context as unknown as AudioContext, created, connectable: context.connectable };
};

describe('immersiveParams 共享参数表', () => {
    it('黑胶：爆豆系数比底噪「脆」但不至于盖住音乐', () => {
        expect(VINYL_PARAMS.crackleLevelCoefficient).toBeGreaterThan(0);
        expect(VINYL_PARAMS.crackleLevelCoefficient).toBeLessThan(0.1);
        // 爆豆单个脉冲比底噪响，但差距不超过 6 dB —— 再大就是「噼啪」盖住音乐了。
        expect(VINYL_PARAMS.crackleLevelCoefficient / VINYL_PARAMS.noiseLevelCoefficient).toBeLessThan(2);
        expect(VINYL_PARAMS.noiseLevelCoefficient).toBeGreaterThan(0);
        expect(VINYL_PARAMS.noiseLevelCoefficient).toBeLessThan(0.05);
    });

    it('黑胶：抖晃是「±0.3% 带速」，flutter 是 wow 的 4 成', () => {
        expect(VINYL_PARAMS.wowDepthSeconds).toBeCloseTo(VINYL_PARAMS.baseDelaySeconds * 0.003, 10);
        expect(VINYL_PARAMS.flutterDepthRatio).toBe(0.4);
        // 0.55 Hz 慢飘、6.2 Hz 抖动。
        expect(VINYL_PARAMS.wowHz).toBe(0.55);
        expect(VINYL_PARAMS.flutterHz).toBe(6.2);
        // 12 µs 量级：再大就听成走音。
        expect(VINYL_PARAMS.wowDepthSeconds).toBeLessThan(5e-5);
    });

    it('夜间模式：目标响度 -32..-12、增益限幅 ±18 dB、400 ms / 2.5 s', () => {
        expect(NIGHT_PARAMS.minTargetDb).toBe(-32);
        expect(NIGHT_PARAMS.maxTargetDb).toBe(-12);
        expect(NIGHT_PARAMS.minGainDb).toBe(-18);
        expect(NIGHT_PARAMS.maxGainDb).toBe(18);
        expect(NIGHT_PARAMS.attackSeconds).toBe(0.4);
        expect(NIGHT_PARAMS.releaseSeconds).toBe(2.5);
        // 桌面端 make-up 的素材电平假设：补偿只会往上推，且封顶 12 dB。
        expect(NIGHT_PARAMS.typicalAverageDb).toBe(-18);
        expect(NIGHT_PARAMS.makeupMaxLiftDb).toBeLessThanOrEqual(18);
    });

    it('交叉馈送：700 Hz 低通、延时范围 0.1..1 ms', () => {
        expect(CROSSFEED_PARAMS.lowpassHz).toBe(700);
        expect(CROSSFEED_PARAMS.minDelayMs).toBe(0.1);
        expect(CROSSFEED_PARAMS.maxDelayMs).toBe(1);
        expect(CROSSFEED_PARAMS.defaultDelayMs).toBeGreaterThanOrEqual(CROSSFEED_PARAMS.minDelayMs);
        expect(CROSSFEED_PARAMS.defaultDelayMs).toBeLessThanOrEqual(CROSSFEED_PARAMS.maxDelayMs);
    });

    it('环绕：耳机湿声比外放高、早期反射系数仍是 0.45', () => {
        expect(SURROUND_PARAMS.headphoneWetGain).toBeGreaterThan(SURROUND_PARAMS.speakerWetGain);
        // 外放不留太多直达声会被听成「更远」而不是「更宽」。
        expect(SURROUND_PARAMS.speakerDirectGain).toBeLessThan(SURROUND_PARAMS.headphoneDirectGain);
        expect(SURROUND_PARAMS.earlyReflectionGain).toBe(0.45);
        expect(SURROUND_PARAMS.baseAngleDeg).toBe(30);
        // 四路早期反射，电平逐路递减 —— 越远的路径越弱。
        expect(SURROUND_PARAMS.earlyReflections).toHaveLength(4);
        const levels = SURROUND_PARAMS.earlyReflections.map(item => item.levelDb);
        expect([...levels].sort((a, b) => b - a)).toEqual(levels);
    });

    it('8D：depth = 0 时 wet = 0.4、dry = 1；depth = 1 时 wet 完全接管', () => {
        const wet = (depth: number) => ORBIT_PARAMS.wetBase + depth * ORBIT_PARAMS.wetSpan;
        const dry = (depth: number) => 1 - depth * ORBIT_PARAMS.drySpan;
        expect(wet(0)).toBeCloseTo(0.4, 10);
        expect(dry(0)).toBeCloseTo(1, 10);
        expect(wet(1)).toBeCloseTo(1, 10);
        expect(dry(1)).toBeCloseTo(0.3, 10);
    });

    it('低音激励：amount 上限 0.9，整流曲线是 sqrt(x² + ε)', () => {
        expect(BASS_EXCITER_PARAMS.maxAmount).toBe(0.9);
        expect(BASS_EXCITER_PARAMS.rectifyEpsilon).toBeGreaterThan(0);
        expect(BASS_EXCITER_PARAMS.rectifyEpsilon).toBeLessThan(1e-3);
        expect(BASS_EXCITER_PARAMS.harmonicHighpassHz).toBe(80);
        expect(BASS_EXCITER_PARAMS.minCrossoverHz).toBe(60);
        expect(BASS_EXCITER_PARAMS.maxCrossoverHz).toBe(200);
    });
});

describe('分支文件确实从共享表取值', () => {
    it('黑胶：底噪 / 爆豆 / 抖晃深度 = 设置值 × 共享系数', () => {
        const { context, created, connectable } = createFakeContext();
        const branch = createVinylBranch(context, connectable as unknown as AudioNode, connectable as unknown as AudioNode);
        const settings = { ...DEFAULT_AUDIO_CONSOLE_SETTINGS.immersive.vinyl, enabled: true };
        (branch.set as (level: number, next?: unknown) => void)(1, settings);

        // 建图时的增益节点按创建顺序：output / wowDepth / flutterDepth / noiseGain / crackleGain。
        const gains = created.filter(item => item.kind === 'gain').map(item => item.gain!.value);
        expect(gains[1]).toBeCloseTo(settings.wow * VINYL_PARAMS.wowDepthSeconds, 10);
        expect(gains[2]).toBeCloseTo(
            settings.wow * VINYL_PARAMS.wowDepthSeconds * VINYL_PARAMS.flutterDepthRatio,
            10,
        );
        expect(gains[3]).toBeCloseTo(settings.noise * VINYL_PARAMS.noiseLevelCoefficient, 10);
        // 爆豆系数是底噪的 2 / 1.2 倍 —— 默认档下爆豆增益反而更大（0.6 × 0.02 > 0.25 × 0.012），
        // 这是有意的：爆豆是稀疏的脉冲，峰值高一点才听得见，连续能量远小于底噪。
        expect(gains[4]).toBeCloseTo(settings.crackle * VINYL_PARAMS.crackleLevelCoefficient, 10);
        expect(VINYL_PARAMS.crackleLevelCoefficient / VINYL_PARAMS.noiseLevelCoefficient).toBeLessThan(3);

        branch.dispose();
    });

    it('黑胶：总开关的 level 乘在噪声与爆豆上，抖晃不乘', () => {
        const { context, created, connectable } = createFakeContext();
        const branch = createVinylBranch(context, connectable as unknown as AudioNode, connectable as unknown as AudioNode);
        const settings = { ...DEFAULT_AUDIO_CONSOLE_SETTINGS.immersive.vinyl, enabled: true };
        (branch.set as (level: number, next?: unknown) => void)(0.5, settings);
        const gains = created.filter(item => item.kind === 'gain').map(item => item.gain!.value);
        expect(gains[3]).toBeCloseTo(settings.noise * VINYL_PARAMS.noiseLevelCoefficient * 0.5, 10);
        expect(gains[1]).toBeCloseTo(settings.wow * VINYL_PARAMS.wowDepthSeconds, 10);
        branch.dispose();
    });

    it('8D：wet = base + depth × span，dry = 1 - depth × span', () => {
        const { context, created, connectable } = createFakeContext();
        const branch = createOrbitBranch(context, connectable as unknown as AudioNode, connectable as unknown as AudioNode);
        (branch.set as (amount: number, next?: unknown) => void)(1, { ...DEFAULT_AUDIO_CONSOLE_SETTINGS.immersive.orbit, enabled: true, depth: 0.8 });
        // 建图时的增益节点按创建顺序：xDepth / zDepth / dry / wet / merged / output。
        const gains = created.filter(item => item.kind === 'gain').map(item => item.gain!.value);
        const depth = 0.8;
        expect(gains[2]).toBeCloseTo(1 - depth * ORBIT_PARAMS.drySpan, 10);
        expect(gains[3]).toBeCloseTo(ORBIT_PARAMS.wetBase + depth * ORBIT_PARAMS.wetSpan, 10);
        branch.dispose();
    });
});

/**
 * 离线渲染冒烟：黑胶改值之后，桌面端的黑胶片必须仍然「有声音、不出 NaN」。
 *
 * 仓库里现有的离线渲染先例（playbackGraph.test.ts / drumHitsResume.test.ts）都是手写假节点，
 * 没有精度足够的 OfflineAudioContext 模拟库；为了一个冒烟用例引入整套 Web Audio 模拟不划算。
 * 于是退一步：把「渲染」这一侧的保证交给真实浏览器，这里只锁住渲染之前的全部契约 ——
 *   1. 抖晃深度落在延时线的可动范围里（不会把 delayTime 推成负数或越过 50 ms 缓冲）；
 *   2. 三个增益量级都在「听得见但不会盖住音乐」的区间（-80 dBFS ~ -20 dBFS）；
 *   3. 噪声缓冲能真的造出来，且不全是 0（createVinylNoiseBuffer 的随机源没被破坏）。
 */
describe('黑胶离线渲染冒烟（数值契约）', () => {
    it('抖晃深度不会把延时线推出合法范围', () => {
        const maxDrift = VINYL_PARAMS.wowDepthSeconds + VINYL_PARAMS.wowDepthSeconds * VINYL_PARAMS.flutterDepthRatio;
        expect(VINYL_PARAMS.baseDelaySeconds - maxDrift).toBeGreaterThan(0);
        expect(VINYL_PARAMS.baseDelaySeconds + maxDrift).toBeLessThan(0.05);
    });

    it('三个增益量级都在可闻区间内', () => {
        const db = (linear: number) => 20 * Math.log10(linear);
        const noise = VINYL_PARAMS.noiseLevelCoefficient;
        const crackle = VINYL_PARAMS.crackleLevelCoefficient;
        expect(db(noise)).toBeGreaterThan(-45);
        expect(db(noise)).toBeLessThan(-20);
        expect(db(crackle)).toBeGreaterThan(-45);
        expect(db(crackle)).toBeLessThan(-20);
    });

    it('噪声缓冲有真实内容，且 RMS 与共享系数配合后落在 -80..-40 dBFS', async () => {
        const { createVinylNoiseBuffer } = await import('@/services/audioEffects/effectSources');
        const data = new Map<number, Float32Array>();
        const fakeContext = {
            sampleRate: 48_000,
            createBuffer: (channels: number, length: number) => ({
                numberOfChannels: channels,
                length,
                getChannelData: (channel: number) => {
                    let existing = data.get(channel);
                    if (!existing) {
                        existing = new Float32Array(length);
                        data.set(channel, existing);
                    }
                    return existing;
                },
            }),
        };
        const buffer = createVinylNoiseBuffer(fakeContext as unknown as BaseAudioContext);
        const samples = Array.from(data.values()).flatMap(channel => Array.from(channel));
        expect(samples.length).toBeGreaterThan(0);
        expect(samples.some(value => value !== 0)).toBe(true);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        // 桌面端默认 noise = 0.25：底噪应是「安静但听得见」——约 -70 dBFS 上下。
        const floorDb = 20 * Math.log10(rms * 0.25 * VINYL_PARAMS.noiseLevelCoefficient);
        expect(floorDb).toBeGreaterThan(-80);
        expect(floorDb).toBeLessThan(-40);
    });

    it('Kotlin 共享表与 TS 共享表的关键数值一致', () => {
        // 两端数值同源是这次任务的核心：TS 改了、Kotlin 忘了改，正是听感差异的来源。
        // 这里做一次「轻量对表」：从 Kotlin 源码里抠出关键常量，与 TS 表比对。
        const root = process.cwd();
        const kotlinPath = path.join(
            root,
            'android/app/src/main/java/top/izuna/foliamajor/player/dsp/ImmersiveParams.kt',
        );
        const kotlin = readFileSync(kotlinPath, 'utf8');
        const read = (name: string) => {
            const match = kotlin.match(new RegExp(`const val ${name}\\s*=\\s*([-0-9.eEf]+)`));
            expect(match, `Kotlin 里找不到 ${name}`).toBeTruthy();
            return Number.parseFloat(match![1].replace(/f$/, ''));
        };
        expect(read('BASE_DELAY_SECONDS')).toBeCloseTo(VINYL_PARAMS.baseDelaySeconds, 8);
        expect(read('WOW_HZ')).toBeCloseTo(VINYL_PARAMS.wowHz, 6);
        expect(read('FLUTTER_HZ')).toBeCloseTo(VINYL_PARAMS.flutterHz, 6);
        expect(read('NOISE_LEVEL_COEFFICIENT')).toBeCloseTo(VINYL_PARAMS.noiseLevelCoefficient, 8);
        expect(read('CRACKLE_LEVEL_COEFFICIENT')).toBeCloseTo(VINYL_PARAMS.crackleLevelCoefficient, 8);
        expect(read('MIN_TARGET_DB')).toBe(NIGHT_PARAMS.minTargetDb);
        expect(read('MAX_TARGET_DB')).toBe(NIGHT_PARAMS.maxTargetDb);
        expect(read('LOWPASS_HZ')).toBe(CROSSFEED_PARAMS.lowpassHz);
        expect(read('EARLY_REFLECTION_GAIN')).toBe(SURROUND_PARAMS.earlyReflectionGain);
        expect(read('HEADPHONE_DIRECT_GAIN')).toBe(SURROUND_PARAMS.headphoneDirectGain);
        expect(read('SPEAKER_DIRECT_GAIN')).toBe(SURROUND_PARAMS.speakerDirectGain);
        expect(read('WET_BASE')).toBe(ORBIT_PARAMS.wetBase);
        expect(read('WET_SPAN')).toBe(ORBIT_PARAMS.wetSpan);
        expect(read('HEADPHONE_WET_GAIN')).toBe(SURROUND_PARAMS.headphoneWetGain);
        expect(read('SPEAKER_WET_GAIN')).toBe(SURROUND_PARAMS.speakerWetGain);
        expect(read('DRY_SPAN')).toBe(ORBIT_PARAMS.drySpan);
        expect(read('MAX_AMOUNT')).toBe(BASS_EXCITER_PARAMS.maxAmount);
        expect(read('HARMONIC_HIGHPASS_HZ')).toBe(BASS_EXCITER_PARAMS.harmonicHighpassHz);
    });
});
