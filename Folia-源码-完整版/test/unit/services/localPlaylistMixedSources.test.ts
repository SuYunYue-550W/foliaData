import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createLocalPlaylist,
    createLocalPlaylistFromQueue,
    getLocalPlaylists,
    saveLocalPlaylists,
} from '@/services/localPlaylistService';
import { getFromCache, getLocalSongs, saveToCache } from '@/services/db';
import {
    buildPlaylistEntriesFromQueue,
    resolvePlaylistExternalSong,
} from '@/utils/localPlaylistEntries';
import {
    resolveLocalGridViewTracks,
    type LocalGridViewCollectionDescriptor,
} from '@/components/app/home/gridViewCollectionAdapters';
import { canSaveQueueAsLocalPlaylist } from '@/utils/queueReorder';
import { getPlaybackSongKey } from '@/utils/appPlaybackGuards';
import type { LocalPlaylist, LocalSong, SongResult } from '@/types';

// test/unit/services/localPlaylistMixedSources.test.ts
// 跨源队列另存为本地歌单：纯本地队列行为不变、混合队列读回条目与顺序一致、外部条目 repair 不丢、
// 空队列仍拒绝。db 用内存 Map 打桩，create* 与 getLocalPlaylists 之间能真正往返。

vi.mock('@/services/db', () => ({
    getFromCache: vi.fn(),
    getLocalSongs: vi.fn(),
    saveToCache: vi.fn(),
}));

const onlineSong = (mediaId: string, providerId = 'netease'): SongResult => ({
    id: mediaId,
    name: `Online ${mediaId}`,
    artists: [{ id: 0, name: 'Artist' }],
    album: { id: 0, name: 'Album', coverUrl: 'https://example.com/cover.jpg' },
    durationMs: 180000,
    sourceRef: { kind: 'online', providerId, mediaId },
} as SongResult);

const localQueueSong = (songId: string): SongResult => ({
    id: 0,
    name: `Local ${songId}`,
    artists: [],
    album: { id: 0, name: 'Album' },
    durationMs: 180000,
    isLocal: true,
    localRef: { songId },
    sourceRef: { kind: 'local', mediaId: songId },
} as unknown as SongResult);

const makeLocalSongRecord = (id: string): LocalSong => ({
    id,
    fileName: `${id}.mp3`,
    filePath: `/music/${id}.mp3`,
    title: `Local ${id}`,
    titleOrigin: 'import',
    importedMetadata: { title: `Local ${id}`, titleSource: 'filename', artistNames: [], albumName: 'Album' },
    duration: 180000,
    fileSize: 1024,
    mimeType: 'audio/mpeg',
    addedAt: 1,
});

const LOCAL_SONGS = [makeLocalSongRecord('L1'), makeLocalSongRecord('L2')];

const externalRef = (mediaId: string) => ({
    key: `online:netease:${mediaId}`,
    sourceRef: { kind: 'online' as const, providerId: 'netease', mediaId },
    song: onlineSong(mediaId),
});

let cacheState: Map<string, unknown>;

beforeEach(() => {
    vi.mocked(getFromCache).mockReset();
    vi.mocked(getLocalSongs).mockReset();
    vi.mocked(saveToCache).mockReset();
    cacheState = new Map();
    vi.mocked(getFromCache).mockImplementation(async key => (cacheState.get(key) ?? null) as never);
    vi.mocked(saveToCache).mockImplementation(async (key, data) => { cacheState.set(key, data); });
    vi.mocked(getLocalSongs).mockResolvedValue(LOCAL_SONGS);
});

describe('cross-source queue saved as a local playlist', () => {
    it('keeps a pure-local playlist unchanged, with no external fields', async () => {
        const queue = [localQueueSong('L1'), localQueueSong('L2')];
        // 纯本地队列不产生外部引用，控制器会走旧的 createLocalPlaylist。
        expect(buildPlaylistEntriesFromQueue(queue).externalRefs).toEqual([]);

        await createLocalPlaylist('Only local', LOCAL_SONGS);

        const playlist = (await getLocalPlaylists()).find(item => item.name === 'Only local')!;
        expect(playlist.songIds).toEqual(['L1', 'L2']);
        expect(playlist.externalRefs).toBeUndefined();
        expect(playlist.entryOrder).toBeUndefined();
    });

    it('persists a mixed queue and reads back external entries in the original order', async () => {
        const queue = [
            onlineSong('101'),
            localQueueSong('L1'),
            onlineSong('102'),
            localQueueSong('L2'),
        ];
        const entries = buildPlaylistEntriesFromQueue(queue);
        await createLocalPlaylistFromQueue('Mix', entries);

        const playlist = (await getLocalPlaylists()).find(item => item.name === 'Mix')!;
        expect(playlist.songIds).toEqual(['L1', 'L2']);
        expect(playlist.externalRefs?.map(ref => ref.key)).toEqual([
            'online:netease:101',
            'online:netease:102',
        ]);
        expect(playlist.entryOrder).toEqual([
            { kind: 'external', key: 'online:netease:101' },
            { kind: 'local', songId: 'L1' },
            { kind: 'external', key: 'online:netease:102' },
            { kind: 'local', songId: 'L2' },
        ]);

        // 外部条目带着完整 sourceRef 与展示元数据，能重建为可播放的 SongResult。
        expect(playlist.externalRefs?.[0].sourceRef).toMatchObject({
            kind: 'online', providerId: 'netease', mediaId: '101',
        });
        expect(resolvePlaylistExternalSong(playlist.externalRefs![0]).name).toBe('Online 101');

        // 读取侧按 entryOrder 交错还原：本地曲目仍走 buildLocalQueue，外部曲目用引用重建，
        // 最终的播放键序列与原队列逐项一致。
        const descriptor: LocalGridViewCollectionDescriptor = {
            source: 'local',
            id: playlist.id,
            name: playlist.name,
            type: 'playlist',
            songIds: playlist.songIds,
            externalRefs: playlist.externalRefs,
            entryOrder: playlist.entryOrder,
            playlistId: playlist.id,
        };
        const tracks = resolveLocalGridViewTracks(descriptor, LOCAL_SONGS);
        expect(tracks.map(getPlaybackSongKey)).toEqual(queue.map(getPlaybackSongKey));
    });

    it('keeps external entries through the getLocalPlaylists repair, dropping only invalid local ids', async () => {
        const mixedPlaylist: LocalPlaylist = {
            id: 'mixed-1',
            name: 'Repaired mix',
            songIds: ['L1', 'GONE'],
            externalRefs: [externalRef('101')],
            entryOrder: [
                { kind: 'external', key: 'online:netease:101' },
                { kind: 'local', songId: 'L1' },
                { kind: 'local', songId: 'GONE' },
                { kind: 'external', key: 'online:netease:101' },
            ],
            createdAt: 1,
            updatedAt: 1,
        };
        cacheState.set('local_playlists', [mixedPlaylist]);

        const playlist = (await getLocalPlaylists()).find(item => item.id === 'mixed-1')!;

        expect(playlist.songIds).toEqual(['L1']); // 失效本地 id 被丢弃
        expect(playlist.externalRefs?.map(ref => ref.key)).toEqual(['online:netease:101']);
        expect(playlist.entryOrder).toEqual([
            { kind: 'external', key: 'online:netease:101' },
            { kind: 'local', songId: 'L1' },
            { kind: 'external', key: 'online:netease:101' },
        ]); // 失效本地项被丢，两个外部项（含重复）保序保留
    });

    it('does not drop external fields in a saveLocalPlaylists / getLocalPlaylists round-trip', async () => {
        const mixedPlaylist: LocalPlaylist = {
            id: 'mixed-2',
            name: 'Saved mix',
            songIds: ['L1'],
            externalRefs: [externalRef('102')],
            entryOrder: [
                { kind: 'local', songId: 'L1' },
                { kind: 'external', key: 'online:netease:102' },
            ],
            createdAt: 1,
            updatedAt: 1,
        };

        await saveLocalPlaylists([mixedPlaylist]);

        const playlist = (await getLocalPlaylists()).find(item => item.id === 'mixed-2')!;
        expect(playlist.externalRefs?.map(ref => ref.key)).toEqual(['online:netease:102']);
        expect(playlist.entryOrder).toEqual([
            { kind: 'local', songId: 'L1' },
            { kind: 'external', key: 'online:netease:102' },
        ]);
    });

    it('rejects an empty queue', () => {
        expect(canSaveQueueAsLocalPlaylist(null, [])).toBe(false);
        expect(canSaveQueueAsLocalPlaylist(onlineSong('101'), [])).toBe(false);
        expect(buildPlaylistEntriesFromQueue([])).toEqual({ songIds: [], externalRefs: [], entryOrder: [] });
    });
});
