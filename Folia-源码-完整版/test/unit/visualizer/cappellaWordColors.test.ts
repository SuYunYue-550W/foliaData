import { describe, expect, it } from 'vitest';
import type { Theme } from '@/types';
import {
    CAPPELLA_MIN_CONTRAST_RATIO,
    buildCappellaLineColorRanges,
    resolveCappellaCharacterColors,
    resolveReadableWordColor,
} from '@/components/visualizer/cappella/cappellaWordColors';

// test/unit/visualizer/cappellaWordColors.test.ts
// Cappella 气泡词着色：AI 语义词色既要看得见，也要看得清。
// 当初整段注释掉就是因为可读性差，所以命中色一律先过对比度兜底。

/** 深色气泡底（getBubbleColors 走 mixColors，实际是 rgba(..., 0.94~1)）。 */
const BUBBLE_BG = 'rgba(20, 20, 30, 0.94)';
/** 气泡的默认文字色（浅）。 */
const FALLBACK = '#f0f0f0';
/** 与深底拉得够开的高亮色。 */
const BRIGHT = '#ffee88';

const wordColors = (entries: { word: string; color: string; }[]): Theme['wordColors'] => entries;

/** 端到端：整行 + 词色 -> 每个显示字符的颜色。 */
const colorLine = (
    fullText: string,
    entries: Theme['wordColors'],
    keywordColoringEnabled = true,
) => resolveCappellaCharacterColors(
    Array.from(fullText),
    buildCappellaLineColorRanges(fullText, entries, keywordColoringEnabled),
    BUBBLE_BG,
    FALLBACK,
);

describe('cappella word colors', () => {
    it('命中中文词，只给那几个字上色', () => {
        const ranges = buildCappellaLineColorRanges('天空之城', wordColors([{ word: '天空', color: BRIGHT }]));
        expect(ranges).toEqual([{ startOffset: 0, endOffset: 2, color: BRIGHT, priority: 2 }]);
        expect(colorLine('天空之城', wordColors([{ word: '天空', color: BRIGHT }])))
            .toEqual([BRIGHT, BRIGHT, FALLBACK, FALLBACK]);
    });

    it('命中英文词，忽略大小写与标点', () => {
        // 词表里带标点、行里大小写混着来，两边归一化后仍能命中。
        const fullText = 'LOVE, love! Night?';
        const entries = wordColors([
            { word: 'love', color: BRIGHT },
            { word: 'Night, Glow!', color: '#66ccff' },
        ]);
        const colors = colorLine(fullText, entries);
        const highlighted = [...fullText]
            .map((character, index) => colors[index] !== FALLBACK ? character : '')
            .join('');
        expect(highlighted).toBe('LOVEloveNight');
        expect(colors[0]).toBe(BRIGHT);
        expect(colors[colors.length - 1]).toBe(FALLBACK); // 问号不上色
    });

    it('全局开关关闭时一个字都不上色', () => {
        const entries = wordColors([{ word: '天空', color: BRIGHT }]);
        expect(buildCappellaLineColorRanges('天空之城', entries, false)).toEqual([]);
        expect(colorLine('天空之城', entries, false))
            .toEqual([FALLBACK, FALLBACK, FALLBACK, FALLBACK]);
    });

    it('对比度不足的词色回落到默认文字色', () => {
        // #1d1d2b 和深底几乎同色，对比度远低于 3:1。
        const muddy = '#1d1d2b';
        expect(resolveReadableWordColor(muddy, BUBBLE_BG, FALLBACK)).toBe(FALLBACK);
        expect(colorLine('天空之城', wordColors([{ word: '天空', color: muddy }])))
            .toEqual([FALLBACK, FALLBACK, FALLBACK, FALLBACK]);
    });

    it('对比度足够的词色原样保留', () => {
        expect(resolveReadableWordColor(BRIGHT, BUBBLE_BG, FALLBACK)).toBe(BRIGHT);
    });

    it('空 wordColors 时全部回落到默认文字色', () => {
        expect(buildCappellaLineColorRanges('天空之城', [])).toEqual([]);
        expect(colorLine('天空之城', [])).toEqual([FALLBACK, FALLBACK, FALLBACK, FALLBACK]);
        expect(colorLine('天空之城', undefined)).toEqual([FALLBACK, FALLBACK, FALLBACK, FALLBACK]);
    });

    it('解析不出来的颜色相信原值，不擅自回落', () => {
        expect(resolveReadableWordColor('not-a-color', BUBBLE_BG, FALLBACK)).toBe('not-a-color');
    });

    it('astral 字符后仍按码元偏移正确对齐中文词', () => {
        // 🎵 是代理对：Array.from 里占 1 个元素、fullText 里占 2 个码元。
        // 不把字符映射回码元坐标，「天空」的区间 [2,4) 会整体错位。
        const fullText = '🎵天空';
        expect(buildCappellaLineColorRanges(fullText, wordColors([{ word: '天空', color: BRIGHT }])))
            .toEqual([{ startOffset: 2, endOffset: 4, color: BRIGHT, priority: 2 }]);
        expect(colorLine(fullText, wordColors([{ word: '天空', color: BRIGHT }])))
            .toEqual([FALLBACK, BRIGHT, BRIGHT]);
    });

    it('阈值就是导出的那份常量', () => {
        expect(CAPPELLA_MIN_CONTRAST_RATIO).toBe(3);
    });
});
