// src/services/autoeqImport.ts
// AutoEq（github.com/jaakkopasanen/AutoEq）校正参数的解析与十段拟合。
//
// AutoEq 为具体型号耳机生成补偿曲线，产物常见三种文本形态：
//   1. ParametricEQ.txt —— 「Preamp: -3.2 dB」+ 一串「Filter n: ON PK Fc 62 Hz Gain -1.0 dB Q 0.70」；
//   2. 结果 CSV —— 「frequency,gain」表头（可能还有别的列）+ 数据行；
//   3. 图形 EQ 数值列表 —— 「31: -2.5, 62: -1.0, …」（逗号/分号/空白/换行分隔都认）。
//
// 这里只做纯文本 → 数据，不碰任何 store / DOM / 平台 API，手机与桌面共用同一份。

import { AUDIO_EQUALIZER_BANDS } from '../utils/audioEqualizer';

/** 一个原始频点：AutoEq 给的频率（Hz）与增益（dB）。 */
export type AutoEqPoint = {
    frequency: number;
    gainDb: number;
};

/** 单行解析失败的原因码，界面按它取 i18n 文案。 */
export type AutoEqLineErrorReason = 'unrecognized' | 'invalidNumber';

export type AutoEqLineError = {
    /** 文本中的第几行（从 1 起）。 */
    line: number;
    /** 该行去掉首尾空白后的原文（截断展示由界面负责）。 */
    text: string;
    reason: AutoEqLineErrorReason;
};

export type AutoEqFormat = 'parametric' | 'csv' | 'graphic' | 'mixed';

export type AutoEqParseResult = {
    /** 解析成功的频点（按频率升序）。 */
    points: AutoEqPoint[];
    /** preamp 行给出的前置增益（dB）；没有该行时为 null。 */
    preampDb: number | null;
    errors: AutoEqLineError[];
    /** 命中最多的那种格式；混着粘贴时给 mixed，界面照常展示结果。 */
    format: AutoEqFormat;
};

/** 本项目十段 EQ 的频点（Hz），来自 utils/audioEqualizer.ts 的 AUDIO_EQUALIZER_BANDS。 */
export const AUTOEQ_TARGET_BAND_HZ: readonly number[] = AUDIO_EQUALIZER_BANDS.map(band => band.frequency);

const PREAMP_RE = /^preamp\s*:\s*(-?\d+(?:\.\d+)?)\s*db\b/i;

// ParametricEQ.txt 的滤波器行，例如：
//   Filter 1: ON PK Fc 31 Hz Gain -2.0 dB Q 0.70
// Fc 与 Gain 各自独立匹配，先后顺序不敏感。
const PARAMETRIC_FC_RE = /\bFc\s+(\d+(?:\.\d+)?)\s*Hz/i;
const PARAMETRIC_GAIN_RE = /\bGain\s+(-?\d+(?:\.\d+)?)\s*dB/i;

const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;

// 「频点: 增益」对。31: -2.5 / 31 Hz: -2.5 / 31Hz:-2.5 都算；全局匹配，一行可含多对。
const GRAPHIC_PAIR_GLOBAL_RE = /(\d+(?:\.\d+)?)\s*(?:hz)?\s*[:：]\s*(-?\d+(?:\.\d+)?)\s*(?:db)?/gi;

/** 有效频点范围：低于 10 Hz / 高于 24 kHz 的数字几乎一定是误贴（时间戳、采样率等）。 */
const isPlausibleFrequency = (hz: number): boolean => hz >= 10 && hz <= 24000;

type LineMatch =
    | { kind: 'preamp'; preampDb: number }
    | { kind: 'points'; points: AutoEqPoint[] }
    | { kind: 'error'; reason: AutoEqLineErrorReason };

/**
 * 解析一行。空行 / 注释（# 或 //）返回 null（直接跳过，不算错）。
 *
 * 判定顺序：preamp → 图形 EQ 对 → CSV 列。图形放在 CSV 前面是因为「31: -2.5」
 * 也能被按列切开，但按「对」匹配才不会把频率和增益拆散。
 */
const matchLine = (rawLine: string): LineMatch | null => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) return null;

    const preamp = PREAMP_RE.exec(line);
    if (preamp) return { kind: 'preamp', preampDb: Number(preamp[1]) };

    // ParametricEQ.txt 的滤波器行：Fc 与 Gain 各取一处（顺序不敏感）。
    if (PARAMETRIC_FC_RE.test(line) && PARAMETRIC_GAIN_RE.test(line)) {
        const frequency = Number(PARAMETRIC_FC_RE.exec(line)![1]);
        if (!isPlausibleFrequency(frequency)) return { kind: 'error', reason: 'invalidNumber' };
        return { kind: 'points', points: [{ frequency, gainDb: Number(PARAMETRIC_GAIN_RE.exec(line)![1]) }] };
    }

    // 「Number of filters: 3」这类元数据行：认得，跳过。
    if (/^number of filters\s*:/i.test(line)) return null;

    // 图形 EQ 形态：整行找出全部「频点: 增益」对。要求至少一对、且每对频率都合理，
    // 否则 ParametricEQ 的「Filter 1: ON …」可能被「1: 数字」这种巧合误中。
    if (GRAPHIC_PAIR_GLOBAL_RE.test(line)) {
        GRAPHIC_PAIR_GLOBAL_RE.lastIndex = 0;
        const pairs: AutoEqPoint[] = [];
        let match: RegExpExecArray | null;
        while ((match = GRAPHIC_PAIR_GLOBAL_RE.exec(line)) !== null) {
            const frequency = Number(match[1]);
            if (!isPlausibleFrequency(frequency)) continue;
            pairs.push({ frequency, gainDb: Number(match[2]) });
        }
        if (pairs.length > 0) return { kind: 'points', points: pairs };
    }

    // CSV 形态：按逗号 / 分号 / 制表符切列，第一列频率、第二列增益，其余列忽略 ——
    // AutoEq 的结果 csv 常带 raw / target / smoothing 等多余列。
    const columns = line.split(/[,;\t]+/).map(column => column.trim()).filter(Boolean);
    if (columns.length >= 2) {
        const [frequencyText, gainText] = columns;
        // 表头行（任一关键列不是数字）按跳过处理：对用户来说「带表头能直接贴」
        // 比「表头报错」更符合直觉。
        if (!NUMBER_RE.test(frequencyText) || !NUMBER_RE.test(gainText)) return null;
        const frequency = Number(frequencyText);
        if (!isPlausibleFrequency(frequency)) return { kind: 'error', reason: 'invalidNumber' };
        return { kind: 'points', points: [{ frequency, gainDb: Number(gainText) }] };
    }

    // 孤立的数字（只贴了一串 dB 值、没有频点）无法映射到十段，按无法识别报错，
    // 提示用户贴带频点的格式。
    return { kind: 'error', reason: 'unrecognized' };
};

/**
 * 把粘贴文本解析成频点与 preamp。
 *
 * 整段没有解析出任何频点时不抛错，返回空 points（界面显示「没有解析到频点」），
 * 行级错误留给界面逐条展示 —— 调参的人需要知道是哪一行坏了，而不是一个笼统的失败。
 */
export const parseAutoEqText = (text: string): AutoEqParseResult => {
    const points: AutoEqPoint[] = [];
    const errors: AutoEqLineError[] = [];
    let preampDb: number | null = null;
    let parametricHits = 0;
    let csvHits = 0;
    let graphicHits = 0;

    text.split(/\r?\n/).forEach((rawLine, index) => {
        const matched = matchLine(rawLine);
        if (!matched) return;
        if (matched.kind === 'preamp') {
            preampDb = matched.preampDb;
            parametricHits += 1;
            return;
        }
        if (matched.kind === 'error') {
            errors.push({ line: index + 1, text: rawLine.trim().slice(0, 80), reason: matched.reason });
            return;
        }
        if (PARAMETRIC_FC_RE.test(rawLine) && PARAMETRIC_GAIN_RE.test(rawLine)) parametricHits += 1;
        else if (/[:：]/.test(rawLine)) graphicHits += 1;
        else csvHits += 1;
        points.push(...matched.points);
    });

    // 同一频率出现多次时取平均（不同来源段落偶尔重复频点）。
    const byFrequency = new Map<number, { sum: number; count: number }>();
    for (const point of points) {
        const entry = byFrequency.get(point.frequency) ?? { sum: 0, count: 0 };
        entry.sum += point.gainDb;
        entry.count += 1;
        byFrequency.set(point.frequency, entry);
    }
    const merged: AutoEqPoint[] = [...byFrequency.entries()]
        .map(([frequency, { sum, count }]) => ({ frequency, gainDb: sum / count }))
        .sort((left, right) => left.frequency - right.frequency);

    const format: AutoEqFormat = (() => {
        const hits = [
            ['parametric', parametricHits] as const,
            ['csv', csvHits] as const,
            ['graphic', graphicHits] as const,
        ].sort((left, right) => right[1] - left[1]);
        if (hits[0][1] === 0) return 'mixed';
        if (hits[1][1] > 0 && hits[1][1] === hits[0][1]) return 'mixed';
        return hits[0][0] as AutoEqFormat;
    })();

    return { points: merged, preampDb, errors, format };
};

/**
 * 把任意密度的频点拟合到十段目标频点上：**对数域线性插值**。
 *
 * 方法与误差取舍：
 *  - AutoEq 的结果常见 30/31 个 1/3 倍频程频点，比十段密得多。选插值而不是最近点，
 *    是因为最近点会把曲线切成台阶（相邻源频点差 2 dB 时，某个十段会被整段抬 2 dB），
 *    而插值把误差摊到相邻两段，曲线更接近原意；
 *  - 用 log10(频率) 做线性插值而不是频率域：人的音高感知与 EQ 滤波器的 Q 都是
 *    对数刻度，频率域直线插值会让中高频段系统性偏移；
 *  - 目标频点落在源频点范围之外时（源最低 40 Hz / 最高 13 kHz 之类）取最近端点的值
 *    外推夹紧 —— 十段 EQ 的 31 Hz / 16 kHz 两端是 shelf，端点值是它的合理近似；
 *  - 已知损失：源曲线里窄于 1/3 倍频程的峰谷（例如 6 kHz 附近的单一共振峰）会被
 *    十段的带宽平均掉，这是十段图形 EQ 的固有限制，不是映射能补回来的。
 */
export const mapAutoEqPointsToBands = (
    points: readonly AutoEqPoint[],
    bandFrequencies: readonly number[] = AUTOEQ_TARGET_BAND_HZ,
): number[] => {
    if (points.length === 0) return bandFrequencies.map(() => 0);
    const sorted = [...points].sort((left, right) => left.frequency - right.frequency);
    const logFrequency = (hz: number): number => Math.log10(Math.max(hz, 1));
    const sourceX = sorted.map(point => logFrequency(point.frequency));

    return bandFrequencies.map(bandHz => {
        const x = logFrequency(bandHz);
        // 端点夹紧：低于最低源频点用最低点，高于最高源频点用最高点。
        if (x <= sourceX[0]) return sorted[0].gainDb;
        if (x >= sourceX[sourceX.length - 1]) return sorted[sorted.length - 1].gainDb;
        const upper = sourceX.findIndex(sourceX => sourceX >= x);
        if (sourceX[upper] === x) return sorted[upper].gainDb;
        const lower = upper - 1;
        const ratio = (x - sourceX[lower]) / (sourceX[upper] - sourceX[lower]);
        return sorted[lower].gainDb + (sorted[upper].gainDb - sorted[lower].gainDb) * ratio;
    });
};

/**
 * preamp 的去处。
 *
 * 本项目前置 EQ 有总增益概念（frontEq.globalGainDb，范围 -24 ~ +12 dB），所以 AutoEq
 * 的 Preamp 直接落到那里，十段保持「纯形状」。范围放不下时把超出部分折进各段
 * （例如 preamp -30 dB：总增益吃 -24，剩下 -6 dB 由每段补上），并提示用户。
 */
export const AUTOEQ_GLOBAL_GAIN_MIN = -24;
export const AUTOEQ_GLOBAL_GAIN_MAX = 12;

export type AutoEqPreampPlan = {
    /** 落到 frontEq.globalGainDb 的部分（已夹紧）。 */
    globalGainDb: number;
    /** 每段要额外叠加的 dB（范围放不下时的余量；正常为 0）。 */
    perBandDb: number;
    /** 是否发生了折算（界面据此提示）。 */
    folded: boolean;
};

export const planAutoEqPreamp = (preampDb: number | null): AutoEqPreampPlan => {
    if (preampDb === null) return { globalGainDb: 0, perBandDb: 0, folded: false };
    const clamped = Math.min(AUTOEQ_GLOBAL_GAIN_MAX, Math.max(AUTOEQ_GLOBAL_GAIN_MIN, preampDb));
    const remainder = preampDb - clamped;
    return {
        globalGainDb: clamped,
        perBandDb: remainder,
        folded: remainder !== 0,
    };
};
