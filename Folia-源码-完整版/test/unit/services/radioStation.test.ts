import { describe, expect, it } from 'vitest';
import type { SongResult } from '@/types';
import type { ArchivePlay } from '@/services/listeningArchive/types';
import { buildSeedRadioQueue, collectArchiveCandidates, RADIO_STATION_COUNT } from '@/services/radioStation';

// test/unit/services/radioStation.test.ts
// 电台选曲的纯逻辑：优先级、去重、排除种子与不可播的歌、新用户兜底。

const song = (id: string, overrides: Partial<SongResult> = {}): SongResult => ({
    id,
    name: `歌 ${id}`,
    artists: [{ id: 0, name: '歌手甲' }],
    album: { id: 0, name: '专辑一' },
    durationMs: 200_000,
    sourceRef: { kind: 'local', mediaId: id },
    ...overrides,
});

const seed = song('seed', { name: '种子', artists: [{ id: 0, name: '歌手甲' }], album: { id: 0, name: '专辑一' } });

const archivePlay = (id: string, songId: string, overrides: Partial<ArchivePlay> = {}): ArchivePlay => ({
    id,
    songKey: `local:${songId}`,
    songId,
    providerId: 'local',
    title: `歌 ${songId}`,
    artists: ['歌手甲'],
    albumName: '专辑一',
    coverUrl: null,
    startedAt: 0,
    endedAt: 1,
    listenedSeconds: 120,
    totalSeconds: 200,
    counted: true,
    completed: true,
    segments: [],
    ...overrides,
});

describe('collectArchiveCandidates', () => {
    it('只聚合与种子相关的行（同歌手或同专辑），并按次数排序', () => {
        const plays = [
            archivePlay('a1', 's1'),                                   // 同歌手
            archivePlay('a2', 's1'),                                   // 同一首第二次
            archivePlay('a3', 's2', { artists: ['歌手乙'], albumName: null }), // 无关
            archivePlay('a4', 's3', { artists: ['歌手乙'], albumName: '专辑一' }), // 同专辑
            archivePlay('a5', 's4', { counted: false }),               // 不计次
        ];
        const candidates = collectArchiveCandidates(plays, seed);
        expect(candidates.map(candidate => candidate.songId)).toEqual(['s1', 's3']);
        expect(candidates[0].plays).toBe(2);
    });
});

describe('buildSeedRadioQueue', () => {
    it('排除种子自己、重复的歌与不可播的歌', () => {
        const pool = [
            seed,                                   // 种子本身
            song('dup'),                            // 同 key 重复
            song('dup'),                            // 又一个重复
            song('dead', { privilege: undefined }), // 正常，能进
            song('gone'),                           // 标记不可播
        ];
        const queue = buildSeedRadioQueue({
            seed,
            pool,
            archivePlays: [],
            isPlayable: candidate => candidate.id !== 'gone',
        });
        expect(queue.map(item => item.id)).not.toContain('seed');
        expect(queue.filter(item => item.id === 'dup')).toHaveLength(1);
        expect(queue.map(item => item.id)).not.toContain('gone');
    });

    it('档案常听的优先于普通曲库歌', () => {
        const pool = [song('fresh'), song('heard')];
        const queue = buildSeedRadioQueue({
            seed,
            pool,
            archivePlays: [archivePlay('a1', 'heard'), archivePlay('a2', 'heard')],
        });
        expect(queue[0].id).toBe('heard');
    });

    it('档案没有数据时退化为同专辑/同歌手优先，其余乱序补齐', () => {
        const pool = [
            song('other-artist', { artists: [{ id: 1, name: '歌手乙' }], album: { id: 1, name: '专辑二' } }),
            song('same-album', { artists: [{ id: 1, name: '歌手乙' }] }),
            song('same-artist', { album: { id: 1, name: '专辑二' } }),
        ];
        const queue = buildSeedRadioQueue({ seed, pool, archivePlays: [], random: () => 0.5 });
        expect(queue.map(item => item.id)).toEqual(['same-album', 'same-artist', 'other-artist']);
    });

    it('补齐到 20 首并全部去重', () => {
        const pool = Array.from({ length: 50 }, (_, index) => song(`s${index}`));
        const queue = buildSeedRadioQueue({ seed, pool, archivePlays: [] });
        expect(queue).toHaveLength(RADIO_STATION_COUNT);
        expect(new Set(queue.map(item => item.id)).size).toBe(RADIO_STATION_COUNT);
    });

    it('excludeKeys 里的歌不会被选中', () => {
        const pool = [song('s1'), song('s2')];
        const queue = buildSeedRadioQueue({
            seed,
            pool,
            archivePlays: [],
            excludeKeys: new Set(['local:s1']),
        });
        expect(queue.map(item => item.id)).toEqual(['s2']);
    });
});
