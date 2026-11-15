import { describe, expect, it } from 'vitest';
import {
    buildWrappedReport,
    wrappedPeakCell,
    wrappedRangeOf,
    WRAPPED_TOP_COUNT,
} from '../../../src/services/listeningArchive/wrapped';
import { splitSegments } from '../../../src/services/listeningArchive/rules';
import type { ArchiveHeatCell, ArchivePlay } from '../../../src/services/listeningArchive/types';

// test/unit/listeningArchive/wrapped.test.ts
// 回顾报告的汇总：区间换算、总量、Top 排序与截断、热力峰值、每周柱状、上一周期对比、空数据。
// 时刻一律按本地时间构造，跑在哪个时区结论都一样。

const at = (year: number, month: number, day: number, hour = 0, minute = 0): number => (
    new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
);

/** 造一行播放：默认同一天、听了 60 秒且计次。 */
const makePlay = (overrides: Partial<ArchivePlay> & { id: string }): ArchivePlay => {
    const startedAt = overrides.startedAt ?? at(2024, 3, 5, 10);
    const endedAt = overrides.endedAt ?? startedAt + 60_000;
    const listenedSeconds = overrides.listenedSeconds ?? 60;
    const totalSeconds = overrides.totalSeconds ?? 200;
    return {
        songKey: 'song\u0001artist',
        songId: 'song-1',
        providerId: 'local',
        title: 'Song',
        artists: ['Artist'],
        albumName: null,
        coverUrl: null,
        startedAt,
        endedAt,
        listenedSeconds,
        totalSeconds,
        counted: true,
        completed: false,
        ...overrides,
        segments: overrides.segments ?? splitSegments(startedAt, endedAt, listenedSeconds),
    } as ArchivePlay;
};

describe('wrappedRangeOf', () => {
    it('本月从 1 日零点起，上一周期是上一个自然月', () => {
        const range = wrappedRangeOf('month', at(2024, 3, 15, 12));
        expect(range.from).toBe(at(2024, 3, 1));
        expect(range.previousFrom).toBe(at(2024, 2, 1));
        expect(range.previousTo).toBe(at(2024, 3, 1));
    });

    it('本年从 1 月 1 日起，上一周期是上一年', () => {
        const range = wrappedRangeOf('year', at(2024, 6, 1, 12));
        expect(range.from).toBe(at(2024, 1, 1));
        expect(range.previousFrom).toBe(at(2023, 1, 1));
    });

    it('全部从 0 看起，没有上一周期', () => {
        const now = at(2024, 6, 1, 12);
        const range = wrappedRangeOf('all', now);
        expect(range.from).toBe(0);
        expect(range.previousFrom).toBeNull();
    });
});

describe('buildWrappedReport 总量与榜单', () => {
    it('总量只算区间内的行；次数只算 counted，秒数是实测总时长', () => {
        const now = at(2024, 3, 20, 12);
        const plays = [
            makePlay({ id: '1', startedAt: at(2024, 3, 2, 9), listenedSeconds: 120 }),
            makePlay({ id: '2', startedAt: at(2024, 3, 3, 9), listenedSeconds: 30, counted: false }),
            // 区间外（上个月）的行不计入本周期。
            makePlay({ id: '3', startedAt: at(2024, 2, 10, 9), listenedSeconds: 300 }),
        ];
        const report = buildWrappedReport(plays, 'month', now);
        expect(report.hasData).toBe(true);
        expect(report.totals).toEqual({ plays: 1, seconds: 150, songs: 1 });
    });

    it('Top 榜按次数排序、并列按时长，并截断到前 10', () => {
        const now = at(2024, 3, 20, 12);
        const plays: ArchivePlay[] = [];
        // b 听 3 次、c 听 2 次但每次更久、a 听 2 次时长与 c 相同 → b, a, c（并列按时长，再按键定序）。
        for (let i = 0; i < 3; i += 1) plays.push(makePlay({ id: `b${i}`, songKey: 'b', title: 'B', startedAt: at(2024, 3, 1 + i, 9) }));
        for (let i = 0; i < 2; i += 1) plays.push(makePlay({ id: `a${i}`, songKey: 'a', title: 'A', startedAt: at(2024, 3, 1 + i, 9), listenedSeconds: 200 }));
        for (let i = 0; i < 2; i += 1) plays.push(makePlay({ id: `c${i}`, songKey: 'c', title: 'C', startedAt: at(2024, 3, 1 + i, 9), listenedSeconds: 100 }));
        // 凑满 11 首不同的歌，验证截断。
        for (let n = 0; n < 11; n += 1) {
            plays.push(makePlay({ id: `f${n}`, songKey: `f${n}`, title: `F${n}`, startedAt: at(2024, 3, 2, 9), listenedSeconds: 30, counted: false }));
        }
        const report = buildWrappedReport(plays, 'month', now);
        expect(report.topSongs).toHaveLength(WRAPPED_TOP_COUNT);
        expect(report.topSongs.slice(0, 3).map(entry => entry.key)).toEqual(['b', 'a', 'c']);
        expect(report.topSongs[0]).toMatchObject({ title: 'B', plays: 3, seconds: 180 });
    });

    it('歌手榜把合唱歌手各计一次；专辑榜跳过没有专辑的行', () => {
        const now = at(2024, 3, 20, 12);
        const plays = [
            makePlay({ id: '1', songKey: 'x', title: 'X', artists: ['甲', '乙'], albumName: 'Album', startedAt: at(2024, 3, 2, 9) }),
            makePlay({ id: '2', songKey: 'y', title: 'Y', artists: ['甲'], albumName: null, startedAt: at(2024, 3, 3, 9) }),
        ];
        const report = buildWrappedReport(plays, 'month', now);
        expect(report.topArtists[0]).toMatchObject({ title: '甲', plays: 2 });
        expect(report.topAlbums).toHaveLength(1);
        expect(report.topAlbums[0]).toMatchObject({ title: 'Album' });
    });
});

describe('buildWrappedReport 峰值、每周柱状与对比', () => {
    it('峰值取热力图里秒数最多的那一格；每周柱状铺满区间', () => {
        const now = at(2024, 3, 20, 12);
        // 3 月 6 日（周三，W10）15 点听 200 秒、3 月 12 日（周二，W11）15 点听 60 秒。
        const plays = [
            makePlay({ id: '1', startedAt: at(2024, 3, 6, 15), listenedSeconds: 200 }),
            makePlay({ id: '2', startedAt: at(2024, 3, 12, 15), listenedSeconds: 60 }),
        ];
        const report = buildWrappedReport(plays, 'month', now);
        expect(report.peak).toMatchObject({ weekday: 2, hour: 15 });
        // 3 月 1 日是周五，所属周从 2 月 26 日（周一）起；到 20 日共铺 4 个周桶。
        expect(report.weeklyBars.length).toBe(4);
        const withSeconds = report.weeklyBars.filter(bucket => bucket.seconds > 0);
        expect(withSeconds).toHaveLength(2);
    });

    it('与上一周期对比：只在有上一周期时给值，上一周期为空给 0', () => {
        const now = at(2024, 3, 20, 12);
        const plays = [makePlay({ id: '1', startedAt: at(2024, 3, 5, 9), listenedSeconds: 120 })];
        const report = buildWrappedReport(plays, 'month', now);
        expect(report.comparison).toEqual({ plays: 0, seconds: 0 });

        const previous = [makePlay({ id: '2', startedAt: at(2024, 2, 10, 9), listenedSeconds: 240 })];
        const reportWithHistory = buildWrappedReport([...plays, ...previous], 'month', now);
        expect(reportWithHistory.comparison).toEqual({ plays: 1, seconds: 240 });

        const allTime = buildWrappedReport(plays, 'all', now);
        expect(allTime.comparison).toBeNull();
    });
});

describe('buildWrappedReport 空数据', () => {
    it('区间里没有任何行时返回完整形状的空报告，不抛错', () => {
        const now = at(2024, 3, 20, 12);
        const report = buildWrappedReport([], 'month', now);
        expect(report.hasData).toBe(false);
        expect(report.totals).toEqual({ plays: 0, seconds: 0, songs: 0 });
        expect(report.topSongs).toEqual([]);
        expect(report.topArtists).toEqual([]);
        expect(report.topAlbums).toEqual([]);
        expect(report.peak).toBeNull();
        expect(report.weeklyBars).toEqual([]);
        expect(report.comparison).toEqual({ plays: 0, seconds: 0 });
    });

    it('只有时长为 0 的行也算空数据', () => {
        const now = at(2024, 3, 20, 12);
        const plays = [makePlay({ id: '1', startedAt: at(2024, 3, 5, 9), listenedSeconds: 0, counted: false })];
        expect(buildWrappedReport(plays, 'month', now).hasData).toBe(false);
    });
});

describe('wrappedPeakCell', () => {
    it('全 0 返回 null，并列取先出现的', () => {
        const cells: ArchiveHeatCell[] = Array.from({ length: 168 }, (_, index) => ({
            weekday: Math.floor(index / 24),
            hour: index % 24,
            seconds: 0,
        }));
        expect(wrappedPeakCell(cells)).toBeNull();
        cells[3 * 24 + 8].seconds = 100;
        cells[1 * 24 + 20].seconds = 100;
        expect(wrappedPeakCell(cells)).toMatchObject({ weekday: 1, hour: 20 });
    });
});
