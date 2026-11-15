import {
    heatCells,
    rankEntries,
    timelineBuckets,
    totals,
} from './aggregate';
import type {
    ArchiveBucket,
    ArchiveHeatCell,
    ArchivePlay,
    ArchiveRankEntry,
} from './types';

// src/services/listeningArchive/wrapped.ts
// 听歌报告（Wrapped）的汇总：输入一段时间，输出回顾卡片要的那几组数。
//
// 全部是纯函数、只读：过滤、排行、热力峰值、每周柱状、环比全部复用 aggregate.ts 里
// 那一份口径（rankEntries / heatCells / timelineBuckets / totals），这里不做任何新的
// 统计口径，也不碰落库。对比上一周期时用同一套函数在上一段区间上重算一遍。

/** 报告看哪一段时间：本月 / 本年 / 全部。 */
export type WrappedPeriod = 'month' | 'year' | 'all';

/** 一段报告区间的边界；`previousFrom` 为 null 表示没有可对比的上一周期（全部）。 */
export type WrappedRange = {
    from: number;
    to: number;
    previousFrom: number | null;
    /** 上一周期的结束时刻；与 previousFrom 成对出现。 */
    previousTo: number | null;
};

/** 本月 1 日 / 本年 1 月 1 日的本地零点；`all` 从 0（有记录以来）看起。 */
export const wrappedRangeOf = (period: WrappedPeriod, now: number = Date.now()): WrappedRange => {
    const date = new Date(now);
    if (period === 'all') return { from: 0, to: now, previousFrom: null, previousTo: null };
    if (period === 'year') {
        const from = new Date(date.getFullYear(), 0, 1).getTime();
        return { from, to: now, previousFrom: new Date(date.getFullYear() - 1, 0, 1).getTime(), previousTo: from };
    }
    const from = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
    return { from, to: now, previousFrom: new Date(date.getFullYear(), date.getMonth() - 1, 1).getTime(), previousTo: from };
};

/** 榜单最多展示前几名。 */
export const WRAPPED_TOP_COUNT = 10;

/** 最常听时段：热力图里秒数最多的那一格；一格都没有（全 0）时返回 null。 */
export const wrappedPeakCell = (cells: ArchiveHeatCell[]): ArchiveHeatCell | null => {
    let peak: ArchiveHeatCell | null = null;
    cells.forEach(cell => {
        if (cell.seconds <= 0) return;
        if (peak === null || cell.seconds > peak.seconds) peak = cell;
    });
    return peak;
};

/** 报告卡片的全部内容。`hasData` 为 false 时其余字段都是空值，界面直接显示空态。 */
export type WrappedReport = {
    period: WrappedPeriod;
    from: number;
    to: number;
    hasData: boolean;
    /** 只算 counted 的次数；秒数是实测总时长；歌曲数按 songKey 去重。 */
    totals: { plays: number; seconds: number; songs: number };
    topSongs: ArchiveRankEntry[];
    topArtists: ArchiveRankEntry[];
    topAlbums: ArchiveRankEntry[];
    /** 最常听时段（热力图峰值）；没有任何听歌时长时为 null。 */
    peak: { weekday: number; hour: number; seconds: number } | null;
    /** 每周播放柱状：铺满区间的周桶（含空桶）。 */
    weeklyBars: ArchiveBucket[];
    /** 与上一周期比：null = 没有上一周期可对比。 */
    comparison: { plays: number; seconds: number } | null;
};

/** 排行复用 aggregate 的口径；榜单按次数排（次数并列按时长，与排行页默认一致）。 */
const topOf = (plays: ArchivePlay[], kind: 'song' | 'artist' | 'album'): ArchiveRankEntry[] => (
    rankEntries(plays, kind, 'plays').slice(0, WRAPPED_TOP_COUNT)
);

/** 与排行榜页同一个过滤口径：按结束时刻落入区间才算这一段的。 */
const playsInRange = (plays: ArchivePlay[], from: number, to: number): ArchivePlay[] => (
    plays.filter(play => play.endedAt >= from && play.startedAt <= to)
);

/**
 * 汇总一份报告。空区间也返回完整形状（hasData = false），界面不需要另行判空；
 * 计算成本集中在榜单与热力上，普通档案量（几千行）一次同步算完没有压力。
 */
export const buildWrappedReport = (
    plays: ArchivePlay[],
    period: WrappedPeriod,
    now: number = Date.now(),
): WrappedReport => {
    const { from, to, previousFrom, previousTo } = wrappedRangeOf(period, now);
    const inRange = playsInRange(plays, from, to);
    const hasData = inRange.some(play => play.listenedSeconds > 0 || play.counted);
    // 与上一周期的对比在空数据时也给出来：上一周期同样为空就是 {0, 0}，形状对界面保持一致。
    const comparison: WrappedReport['comparison'] = previousFrom === null || previousTo === null
        ? null
        : (() => {
            const previous = totals(playsInRange(plays, previousFrom, previousTo));
            return { plays: previous.plays, seconds: previous.seconds };
        })();

    if (!hasData) {
        return {
            period,
            from,
            to,
            hasData: false,
            totals: { plays: 0, seconds: 0, songs: 0 },
            topSongs: [],
            topArtists: [],
            topAlbums: [],
            peak: null,
            weeklyBars: [],
            comparison,
        };
    }

    const peakCell = wrappedPeakCell(heatCells(inRange, from, to));
    return {
        period,
        from,
        to,
        hasData,
        totals: totals(inRange),
        topSongs: topOf(inRange, 'song'),
        topArtists: topOf(inRange, 'artist'),
        topAlbums: topOf(inRange, 'album'),
        peak: peakCell ? { weekday: peakCell.weekday, hour: peakCell.hour, seconds: peakCell.seconds } : null,
        weeklyBars: timelineBuckets(inRange, 'week', from, to),
        comparison,
    };
};
