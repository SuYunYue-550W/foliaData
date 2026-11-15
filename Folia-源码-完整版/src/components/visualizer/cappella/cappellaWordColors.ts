import type { Theme } from '../../../types';
import { getContrastRatio, parseThemeColor } from '../../../utils/themeColorMath';
import { buildWordColorRanges, type WordColorRange } from '../wordColoring';

// src/components/visualizer/cappella/cappellaWordColors.ts
// Cappella 气泡的逐字取色：复用整行区间匹配，并给 AI 词色加一层「看得清」的兜底。
//
// 这段着色当初被整段注释掉，原因就是 AI 语义色把气泡里的字糊成了看不清的一片。
// 现在放开，但每个命中色先过对比度检查：与气泡底色不够分明就退回默认文字色。

/**
 * 词色与气泡底色至少要拉开的对比度。
 *
 * WCAG AA 正文是 4.5:1，这里取 3:1（WCAG AA 大字号 / 非文本图形门槛）：
 * 气泡正文 >= 15px、active 时还会放大，已接近大字号；而 wordColors 是点缀色而非整段正文，
 * 卡到 4.5 会把大部分中调高亮误杀回默认色，等于又把这功能禁掉一次。
 * 3:1 只挡掉确实糊成一片的那批，剩下的保留 AI 着色。
 */
export const CAPPELLA_MIN_CONTRAST_RATIO = 3;

/**
 * 词色相对气泡底色的可读性兜底：不够分明就回落到默认文字色。
 *
 * 底色来自 getBubbleColors 的 mixColors，是 rgba(...)、alpha 接近 1（0.94 / 1），
 * 对比度按其实色 RGB 算、忽略这点透明度。解析不出来的颜色（命名色等）相信原值，不擅自回落。
 */
export const resolveReadableWordColor = (
    wordColor: string,
    bubbleBackgroundColor: string,
    fallbackColor: string,
): string => {
    if (!parseThemeColor(wordColor) || !parseThemeColor(bubbleBackgroundColor)) {
        return wordColor;
    }

    return getContrastRatio(wordColor, bubbleBackgroundColor) >= CAPPELLA_MIN_CONTRAST_RATIO
        ? wordColor
        : fallbackColor;
};

/** 整行只算一次上色区间；坐标是 fullText 的 UTF-16 码元下标。开关关掉 / 没有词色时为空。 */
export const buildCappellaLineColorRanges = (
    fullText: string,
    wordColors: Theme['wordColors'],
    keywordColoringEnabled = true,
): WordColorRange[] => (
    fullText ? buildWordColorRanges(fullText, wordColors, keywordColoringEnabled) : []
);

/**
 * 逐字取色：characters 来自 Array.from(fullText)（按 code point 拆），而上色区间用的是
 * UTF-16 码元下标；遇到 astral 字符（emoji / 部分汉字）两者会错位，所以自己走一遍码元游标
 * 把每个字映射回区间坐标系，再套可读性兜底。逐字动画 / 高亮只看 characters 的顺序，不受影响。
 */
export const resolveCappellaCharacterColors = (
    characters: string[],
    ranges: WordColorRange[],
    bubbleBackgroundColor: string,
    fallbackColor: string,
): string[] => {
    if (ranges.length === 0) {
        return characters.map(() => fallbackColor);
    }

    let codeUnitOffset = 0;
    return characters.map(character => {
        const startOffset = codeUnitOffset;
        const endOffset = startOffset + character.length;
        codeUnitOffset = endOffset;

        const hit = ranges.find(range => startOffset < range.endOffset && range.startOffset < endOffset);
        return hit
            ? resolveReadableWordColor(hit.color, bubbleBackgroundColor, fallbackColor)
            : fallbackColor;
    });
};
