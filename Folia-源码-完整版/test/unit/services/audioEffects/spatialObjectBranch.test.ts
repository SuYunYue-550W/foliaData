// test/unit/services/audioEffects/spatialObjectBranch.test.ts
// 空间对象层确实被建出来并接进环绕图。
//
// 只验证「图的结构 + 参数写到了对象 panner 上」，不冒充听感验证 ——
// 真实空间感需要戴上耳机在 Electron 里 A/B 试听（见 AGENTS.md 的真机要求）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSurroundBranch } from '@/services/audioEffects/surroundBranch';
import { spatialObjectPlacement } from '@/services/audioEffects/spatialObjectMath';
import { SURROUND_PARAMS } from '@/services/audioEffects/immersiveParams';
import type { AudioConsoleSurround } from '@/utils/audioConsole';

vi.mock('@/services/audioEffects/effectParams', () => ({
    rampParam: (_ctx: unknown, param: { value: number }, value: number) => { param.value = value; },
}));

type FakeParam = { value: number };
type FakeNode = {
    kind: string;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    gain?: FakeParam;
    positionX?: FakeParam;
    positionY?: FakeParam;
    positionZ?: FakeParam;
    delayTime?: FakeParam;
    pan?: FakeParam;
    panningModel?: string;
};

const param = (value = 0): FakeParam => ({ value });

const makeContext = () => {
    const created: FakeNode[] = [];
    const node = (kind: string, extra: Partial<FakeNode> = {}): FakeNode => {
        const result: FakeNode = {
            kind, connect: vi.fn(), disconnect: vi.fn(), ...extra,
        };
        created.push(result);
        return result;
    };
    const context = {
        currentTime: 0,
        sampleRate: 48000,
        createGain: () => node('gain', { gain: param(1) }),
        createDelay: () => node('delay', { delayTime: param(0) }),
        createChannelSplitter: () => node('splitter'),
        createStereoPanner: () => node('stereoPanner', { pan: param(0) }),
        createPanner: () => node('panner', {
            panningModel: 'equalpower',
            positionX: param(0), positionY: param(0), positionZ: param(0),
        }),
    };
    return { context: context as unknown as AudioContext, created };
};

const settings = (overrides: Partial<AudioConsoleSurround> = {}): AudioConsoleSurround => ({
    mode: 'headphone', width: 1, roomAmount: 0.35, ...overrides,
});

describe('环绕分支的空间对象层', () => {
    let ctx: ReturnType<typeof makeContext>;

    beforeEach(() => { ctx = makeContext(); });

    it('建图时有第三个 HRTF panner，且它是对象的那一路', () => {
        const branch = createSurroundBranch(ctx.context, { connect: vi.fn(), disconnect: vi.fn() } as never);
        branch.set(settings());
        const panners = ctx.created.filter(n => n.kind === 'panner');
        expect(panners).toHaveLength(3);
        expect(panners.every(p => p.panningModel === 'HRTF')).toBe(true);
        branch.dispose();
    });

    it('对象方位按 width 的一半摆位，与纯函数结果一致', () => {
        const branch = createSurroundBranch(ctx.context, { connect: vi.fn(), disconnect: vi.fn() } as never);
        const width = 1.4;
        branch.set(settings({ width }));
        const object = spatialObjectPlacement({
            azimuthDeg: (SURROUND_PARAMS.baseAngleDeg * width) / 2,
            distance: SURROUND_PARAMS.speakerDistance,
        });
        const third = ctx.created.filter(n => n.kind === 'panner')[2];
        expect(third.positionX?.value).toBeCloseTo(object.x, 6);
        expect(third.positionY?.value).toBeCloseTo(object.y, 6);
        expect(third.positionZ?.value).toBeCloseTo(object.z, 6);
        branch.dispose();
    });

    it('关闭环绕后对象层随整条通路淡出', () => {
        const branch = createSurroundBranch(ctx.context, { connect: vi.fn(), disconnect: vi.fn() } as never);
        branch.set(settings());
        const panners = ctx.created.filter(n => n.kind === 'panner');
        expect(panners).toHaveLength(3);
        branch.set(null);
        // set(null) 只淡出，不清图（节点留到 fade 结束），对象 panner 仍在但输出已静音。
        expect(ctx.created.filter(n => n.kind === 'panner')).toHaveLength(3);
        branch.dispose();
    });
});
