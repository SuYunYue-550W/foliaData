import { describe, expect, it } from 'vitest';
import {
    AUTOEQ_TARGET_BAND_HZ,
    mapAutoEqPointsToBands,
    parseAutoEqText,
    planAutoEqPreamp,
    type AutoEqPoint,
} from '@/services/autoeqImport';

// test/unit/services/autoeqImport.test.ts
// AutoEQ 导入的解析（三种格式 + 非法输入）与十段拟合（边界与插值）。

const BAND_HZ = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

describe('parseAutoEqText — CSV', () => {
    it('reads a headerless frequency,gain table', () => {
        const result = parseAutoEqText('31,-2.5\n62,-1.0\n1000,0.5');
        expect(result.errors).toEqual([]);
        expect(result.preampDb).toBeNull();
        expect(result.points).toEqual([
            { frequency: 31, gainDb: -2.5 },
            { frequency: 62, gainDb: -1.0 },
            { frequency: 1000, gainDb: 0.5 },
        ]);
    });

    it('skips the header row and extra columns', () => {
        const text = [
            'frequency,gain,raw,target',
            '31,-2.5,-2.6,-1.0',
            '62,-1.0,-1.1,-0.4',
        ].join('\n');
        const result = parseAutoEqText(text);
        expect(result.errors).toEqual([]);
        expect(result.points).toEqual([
            { frequency: 31, gainDb: -2.5 },
            { frequency: 62, gainDb: -1.0 },
        ]);
        expect(result.format).toBe('csv');
    });

    it('accepts spaces and semicolons as separators', () => {
        const result = parseAutoEqText('31, -2.5\n62; -1.0');
        expect(result.points).toEqual([
            { frequency: 31, gainDb: -2.5 },
            { frequency: 62, gainDb: -1.0 },
        ]);
    });
});

describe('parseAutoEqText — ParametricEQ.txt', () => {
    const parametricText = [
        'Preamp: -3.2 dB',
        'Number of filters: 2',
        'Filter 1: ON PK Fc 31 Hz Gain -2.0 dB Q 0.70',
        'Filter 2: ON PK Fc 1000 Hz Gain 1.5 dB Q 0.70',
    ].join('\n');

    it('reads the preamp line and every filter line', () => {
        const result = parseAutoEqText(parametricText);
        expect(result.preampDb).toBe(-3.2);
        expect(result.errors).toEqual([]);
        expect(result.points).toEqual([
            { frequency: 31, gainDb: -2.0 },
            { frequency: 1000, gainDb: 1.5 },
        ]);
        expect(result.format).toBe('parametric');
    });

    it('parses filter lines without a preamp line', () => {
        const result = parseAutoEqText('Filter 1: ON PK Fc 62 Hz Gain -1.0 dB Q 1.10');
        expect(result.preampDb).toBeNull();
        expect(result.points).toEqual([{ frequency: 62, gainDb: -1.0 }]);
    });
});

describe('parseAutoEqText — graphic EQ list', () => {
    it('reads one line of colon pairs', () => {
        const result = parseAutoEqText('31: -2.5, 62: -1.0, 125: 0.5');
        expect(result.errors).toEqual([]);
        expect(result.points).toEqual([
            { frequency: 31, gainDb: -2.5 },
            { frequency: 62, gainDb: -1.0 },
            { frequency: 125, gainDb: 0.5 },
        ]);
        expect(result.format).toBe('graphic');
    });

    it('reads one pair per line and Hz units', () => {
        const result = parseAutoEqText('31 Hz: -2.5\n62Hz:-1.0');
        expect(result.points).toEqual([
            { frequency: 31, gainDb: -2.5 },
            { frequency: 62, gainDb: -1.0 },
        ]);
    });
});

describe('parseAutoEqText — invalid input', () => {
    it('returns no points for empty or comment-only text', () => {
        expect(parseAutoEqText('').points).toEqual([]);
        expect(parseAutoEqText('   \n\n').points).toEqual([]);
        expect(parseAutoEqText('# a comment\n// another').errors).toEqual([]);
    });

    it('reports garbage lines with their line numbers', () => {
        const result = parseAutoEqText('31,-2.5\nthis is not data\n62,-1.0');
        expect(result.points).toEqual([
            { frequency: 31, gainDb: -2.5 },
            { frequency: 62, gainDb: -1.0 },
        ]);
        expect(result.errors).toEqual([{ line: 2, text: 'this is not data', reason: 'unrecognized' }]);
    });

    it('reports a bare dB value list (no frequencies) as an error', () => {
        const result = parseAutoEqText('-2.5\n-1.0\n0.5');
        expect(result.points).toEqual([]);
        expect(result.errors).toHaveLength(3);
        expect(result.errors[0]).toMatchObject({ line: 1, reason: 'unrecognized' });
    });

    it('rejects implausible frequencies', () => {
        const result = parseAutoEqText('44100,-1.0\n5,-2.0');
        expect(result.points).toEqual([]);
        expect(result.errors.every(error => error.reason === 'invalidNumber')).toBe(true);
    });

    it('averages repeated frequencies and sorts the output', () => {
        const result = parseAutoEqText('1000,1.0\n62,-1.0\n1000,3.0');
        expect(result.points).toEqual([
            { frequency: 62, gainDb: -1.0 },
            { frequency: 1000, gainDb: 2.0 },
        ]);
    });
});

describe('mapAutoEqPointsToBands', () => {
    it('returns all zeros for no points', () => {
        expect(mapAutoEqPointsToBands([])).toEqual(new Array(10).fill(0));
    });

    it('uses a source point directly when it lands on a band', () => {
        const points: AutoEqPoint[] = BAND_HZ.map(frequency => ({ frequency, gainDb: 1 }));
        expect(mapAutoEqPointsToBands(points)).toEqual(new Array(10).fill(1));
    });

    it('interpolates linearly in the log-frequency domain between neighbours', () => {
        // 500 与 2000 之间的几何中点正好是 1000 Hz：对数域插值应给出中点增益。
        const points: AutoEqPoint[] = [
            { frequency: 500, gainDb: -4 },
            { frequency: 2000, gainDb: 4 },
        ];
        const gains = mapAutoEqPointsToBands(points);
        const index1000 = BAND_HZ.indexOf(1000);
        expect(gains[index1000]).toBeCloseTo(0, 10);
        // 31 Hz 低于源最低频点：夹紧到端点值。
        expect(gains[0]).toBe(-4);
        // 16 kHz 高于源最高频点：夹紧到端点值。
        expect(gains[9]).toBe(4);
    });

    it('interpolates between a band and the nearest endpoint outside the source range', () => {
        const points: AutoEqPoint[] = [
            { frequency: 40, gainDb: -6 },
            { frequency: 13000, gainDb: 6 },
        ];
        const gains = mapAutoEqPointsToBands(points);
        // 31 Hz 在 40 Hz 之下：取端点。
        expect(gains[0]).toBe(-6);
        // 8 kHz 落在源范围内，介于 -6 与 +6 之间。
        const index8000 = BAND_HZ.indexOf(8000);
        expect(gains[index8000]).toBeGreaterThan(-6);
        expect(gains[index8000]).toBeLessThan(6);
    });

    it('clamps when the source is a single point', () => {
        const gains = mapAutoEqPointsToBands([{ frequency: 1000, gainDb: 3 }]);
        expect(gains).toEqual(new Array(10).fill(3));
    });

    it('does not depend on the input order', () => {
        const ordered: AutoEqPoint[] = [
            { frequency: 31, gainDb: -2 },
            { frequency: 16000, gainDb: 2 },
        ];
        const reversed = [...ordered].reverse();
        expect(mapAutoEqPointsToBands(ordered)).toEqual(mapAutoEqPointsToBands(reversed));
    });

    it('targets the project ten bands by default', () => {
        expect(AUTOEQ_TARGET_BAND_HZ).toEqual(BAND_HZ);
        expect(mapAutoEqPointsToBands([{ frequency: 62, gainDb: -1 }])).toHaveLength(10);
    });
});

describe('planAutoEqPreamp', () => {
    it('passes null through as no-op', () => {
        expect(planAutoEqPreamp(null)).toEqual({ globalGainDb: 0, perBandDb: 0, folded: false });
    });

    it('applies an in-range preamp to the global gain only', () => {
        expect(planAutoEqPreamp(-3.2)).toEqual({ globalGainDb: -3.2, perBandDb: 0, folded: false });
    });

    it('folds the out-of-range remainder into the bands', () => {
        const plan = planAutoEqPreamp(-30);
        expect(plan.globalGainDb).toBe(-24);
        expect(plan.perBandDb).toBeCloseTo(-6, 10);
        expect(plan.folded).toBe(true);
    });

    it('folds positive overflow too', () => {
        const plan = planAutoEqPreamp(15);
        expect(plan.globalGainDb).toBe(12);
        expect(plan.perBandDb).toBeCloseTo(3, 10);
    });
});
