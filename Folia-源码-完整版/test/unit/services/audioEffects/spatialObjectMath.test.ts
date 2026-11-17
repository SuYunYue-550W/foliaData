// test/unit/services/audioEffects/spatialObjectMath.test.ts
// 自研空间对象摆位的数值护栏。纯函数，不需要 AudioContext。
import { describe, expect, it } from 'vitest';
import {
    spatialObjectPlacement, spatialSeparation,
} from '@/services/audioEffects/spatialObjectMath';
import { SURROUND_PARAMS } from '@/services/audioEffects/immersiveParams';

const close = (actual: number, expected: number, tolerance = 1e-9) => (
    expect(Math.abs(actual - expected)).toBeLessThan(tolerance)
);

describe('空间对象摆位', () => {
    it('方位角 0 放在正前方（-Z），仰角为 0', () => {
        const p = spatialObjectPlacement({ azimuthDeg: 0 });
        close(p.x, 0);
        close(p.y, 0);
        close(p.z, -SURROUND_PARAMS.speakerDistance);
        close(p.gain, 1);
    });

    it('方位角 +90 放在正右方（+X）', () => {
        const p = spatialObjectPlacement({ azimuthDeg: 90, distance: 2 });
        close(p.x, 2);
        close(p.y, 0);
        close(p.z, 0);
    });

    it('方位角 -90 放在正左方（-X）', () => {
        const p = spatialObjectPlacement({ azimuthDeg: -90, distance: 2 });
        close(p.x, -2);
        close(p.y, 0);
        close(p.z, 0);
    });

    it('仰角把对象抬高，水平半径按 cos 收缩', () => {
        const p = spatialObjectPlacement({ azimuthDeg: 0, elevationDeg: 30, distance: 2 });
        close(p.y, 1);
        close(p.x, 0);
        close(p.z, -Math.sqrt(3));
    });

    it('非法输入退回安全默认值，不产生 NaN', () => {
        for (const input of [
            { azimuthDeg: Number.NaN },
            { azimuthDeg: 400 },
            { azimuthDeg: 0, distance: 0 },
            { azimuthDeg: 0, distance: Number.NaN },
            { azimuthDeg: 0, depth: Number.NaN },
        ]) {
            const p = spatialObjectPlacement(input);
            expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
            expect(p.gain).toBeGreaterThanOrEqual(0);
            expect(p.gain).toBeLessThanOrEqual(1);
        }
    });

    it('depth 直接作为直达增益', () => {
        close(spatialObjectPlacement({ azimuthDeg: 30, depth: 0.4 }).gain, 0.4);
        close(spatialObjectPlacement({ azimuthDeg: 30, depth: -1 }).gain, 0);
        close(spatialObjectPlacement({ azimuthDeg: 30, depth: 5 }).gain, 1);
    });
});

describe('空间分离度', () => {
    it('同一点为 0，反方向为 1', () => {
        const center = spatialObjectPlacement({ azimuthDeg: 0 });
        expect(spatialSeparation(center, center)).toBeCloseTo(0, 9);
        const back = spatialObjectPlacement({ azimuthDeg: 180 });
        expect(spatialSeparation(center, back)).toBeCloseTo(1, 9);
    });

    it('左右两个虚拟扬声器有明显分离', () => {
        const left = spatialObjectPlacement({ azimuthDeg: -SURROUND_PARAMS.baseAngleDeg });
        const right = spatialObjectPlacement({ azimuthDeg: SURROUND_PARAMS.baseAngleDeg });
        // ±30° 分离 = (1 - cos60°)/2 = 0.25
        expect(spatialSeparation(left, right)).toBeCloseTo(0.25, 6);
    });
});
