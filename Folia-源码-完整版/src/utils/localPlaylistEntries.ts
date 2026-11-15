import type { PlaylistEntry, PlaylistExternalRef, SongResult } from '../types';
import { getPlaybackSongKey, getPlaybackSourceRef } from './appPlaybackGuards';

// src/utils/localPlaylistEntries.ts
// 跨源播放队列 ↔ 本地歌单条目的序列化。songIds 依旧只放本地歌曲 id（旧数据语义不变），
// 在线 / Navidrome / 舞台条目另存为 externalRefs，并用 entryOrder 记录队列的完整顺序。
// 这些函数都是纯函数：不碰 db、不重建依赖 services 的 LocalSong，方便在服务层与读取侧共用。

export type PlaylistEntries = {
    songIds: string[];
    externalRefs: PlaylistExternalRef[];
    entryOrder: PlaylistEntry[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isPlaybackSourceRef = (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    return (value.kind === 'online' || value.kind === 'local' || value.kind === 'navidrome' || value.kind === 'stage')
        && typeof value.mediaId === 'string';
};

/** 校验并按 key 去重缓存里的外部引用；旧歌单没有这个字段 → []。 */
export const normalizeExternalRefs = (raw: unknown): PlaylistExternalRef[] => {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const refs: PlaylistExternalRef[] = [];

    raw.forEach(item => {
        if (!isRecord(item)) return;
        const { key, sourceRef, song } = item;
        if (typeof key !== 'string' || !key || !isPlaybackSourceRef(sourceRef) || !isRecord(song)) return;
        if (seen.has(key)) return;
        seen.add(key);
        refs.push({
            key,
            sourceRef: sourceRef as PlaylistExternalRef['sourceRef'],
            song: song as unknown as SongResult,
        });
    });

    return refs;
};

/** 只做结构校验：合法条目原样保留，缺字段 / 未知 kind 的丢掉；旧歌单没有这个字段 → []。 */
export const normalizeEntryOrder = (raw: unknown): PlaylistEntry[] => {
    if (!Array.isArray(raw)) return [];
    const entries: PlaylistEntry[] = [];

    raw.forEach(item => {
        if (!isRecord(item)) return;
        if (item.kind === 'local' && typeof item.songId === 'string' && item.songId) {
            entries.push({ kind: 'local', songId: item.songId });
        } else if (item.kind === 'external' && typeof item.key === 'string' && item.key) {
            entries.push({ kind: 'external', key: item.key });
        }
    });

    return entries;
};

/**
 * 把一条播放队列拆成歌单存储字段，顺序与重复项都保留：
 * - 本地歌（sourceRef.kind === 'local'）用 mediaId 作为本地歌曲 id，进 songIds 与 local 条目；
 * - 其余按播放键去重进 externalRefs，用 key 指回；
 * - entryOrder 逐项记录，交错顺序与队列一致。
 */
export const buildPlaylistEntriesFromQueue = (queue: readonly SongResult[]): PlaylistEntries => {
    const songIds: string[] = [];
    const externalRefs: PlaylistExternalRef[] = [];
    const externalKeys = new Set<string>();
    const entryOrder: PlaylistEntry[] = [];

    queue.forEach(song => {
        const sourceRef = getPlaybackSourceRef(song);
        if (sourceRef.kind === 'local') {
            const songId = sourceRef.mediaId;
            songIds.push(songId);
            entryOrder.push({ kind: 'local', songId });
            return;
        }

        const key = getPlaybackSongKey(song);
        if (!externalKeys.has(key)) {
            externalKeys.add(key);
            externalRefs.push({ key, sourceRef, song: { ...song, sourceRef } });
        }
        entryOrder.push({ kind: 'external', key });
    });

    return { songIds, externalRefs, entryOrder };
};

/** 从持久化的外部引用重建一条可播放的 SongResult（始终带上 sourceRef）。 */
export const resolvePlaylistExternalSong = (ref: PlaylistExternalRef): SongResult => (
    { ...ref.song, sourceRef: ref.sourceRef }
);
