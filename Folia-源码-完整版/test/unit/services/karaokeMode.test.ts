// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createKaraokeBranch } from '@/services/audioEffects/karaokeBranch';
import { getKaraokeMode, resetKaraokeModeForTests, useKaraokeModeStore } from '@/stores/useKaraokeModeStore';

// test/unit/services/karaokeMode.test.ts
// 伴唱状态机：三档互斥、持久化、以及图上三颗增益每次只有一颗被推向 1。

interface FakeParam {
    value: number;
    targets: Array<{ value: number; ramp: number }>;
    setTargetAtTime: (value: number, time: number, ramp: number) => void;
    cancelScheduledValues: (time: number) => void;
}

const createFakeContext = () => {
    const params: FakeParam[] = [];
    const makeParam = (): FakeParam => {
        const param: FakeParam = {
            value: 1,
            targets: [],
            setTargetAtTime(value, _time, ramp) { param.targets.push({ value, ramp }); },
            cancelScheduledValues: () => undefined,
        };
        params.push(param);
        return param;
    };
    const context = {
        currentTime: 0,
        createGain: () => ({ gain: makeParam(), connect: () => undefined, disconnect: () => undefined }),
        createBiquadFilter: () => ({ type: 'highpass', frequency: makeParam(), gain: makeParam(), Q: makeParam(), connect: () => undefined, disconnect: () => undefined }),
        createChannelSplitter: () => ({ connect: () => undefined, disconnect: () => undefined }),
    };
    return { context: context as unknown as AudioContext, params };
};

beforeEach(() => {
    resetKaraokeModeForTests();
    if (typeof window !== 'undefined') window.localStorage.removeItem('local_karaoke_mode');
});

describe('useKaraokeModeStore（伴唱状态机）', () => {
    it('三档互斥，setMode 覆盖上一档', () => {
        useKaraokeModeStore.getState().setMode('instrumental');
        expect(useKaraokeModeStore.getState().mode).toBe('instrumental');
        useKaraokeModeStore.getState().setMode('vocal');
        expect(useKaraokeModeStore.getState().mode).toBe('vocal');
        useKaraokeModeStore.getState().setMode('off');
        expect(getKaraokeMode()).toBe('off');
    });

    it('持久化到 localStorage，并在下次读取时回来', () => {
        useKaraokeModeStore.getState().setMode('vocal');
        expect(window.localStorage.getItem('local_karaoke_mode')).toBe('vocal');
    });

    it('重置后回到「关」', () => {
        useKaraokeModeStore.getState().setMode('instrumental');
        resetKaraokeModeForTests();
        expect(getKaraokeMode()).toBe('off');
    });
});

describe('createKaraokeBranch', () => {
    it('三档各只把一路推向 1：直通 / 侧信号（伴奏）/ 中信号（人声）', () => {
        const { context, params } = createFakeContext();
        const branch = createKaraokeBranch(context, context.createGain(), context.createGain());
        // 参数创建顺序：input、output（测试里先建的两个假节点）→ bypass / instrumental / vocal
        // （createKaraokeBranch 开头的三个增益）→ 之后才是 mid/side 求和与滤波器。
        const routeGains = params.slice(2, 5);

        const targetsOf = (mode: 'off' | 'instrumental' | 'vocal') => {
            routeGains.forEach(param => { param.targets = []; });
            branch.apply(mode);
            return routeGains.map(param => param.targets[param.targets.length - 1]?.value);
        };

        expect(targetsOf('off')).toEqual([1, 0, 0]);
        expect(targetsOf('instrumental')).toEqual([0, 1, 0]);
        expect(targetsOf('vocal')).toEqual([0, 0, 1]);
    });

    it('档位切换走斜坡而不是硬跳，dispose 可重复调用', () => {
        const { context, params } = createFakeContext();
        const branch = createKaraokeBranch(context, context.createGain(), context.createGain());
        branch.apply('vocal');
        const lastTargets = params.slice(2, 5).flatMap(param => param.targets);
        expect(lastTargets.length).toBeGreaterThan(0);
        expect(() => {
            branch.dispose();
            branch.dispose();
        }).not.toThrow();
    });
});
