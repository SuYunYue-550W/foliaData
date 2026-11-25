import { removeFromCache, saveToCache } from '../../../services/db';
import type { SongResult, UnifiedSong } from '../../../types';
import { clearSavedPlaybackPosition } from './restore/playbackPositionCache';
import { isStagePlaybackSong, normalizePlaybackSongSource } from '../../../utils/appPlaybackGuards';

// src/components/app/playback/persistPlaybackCache.ts

const sanitizePlaybackSong = (song: SongResult): SongResult => {
    const unified = normalizePlaybackSongSource(song) as UnifiedSong & { localData?: { id?: string } };
    const localSongId = unified.localRef?.songId || unified.localData?.id;
    if (!localSongId) return unified;
    const { localData: _legacyLocalData, ...snapshot } = unified;
    return { ...snapshot, isLocal: true, localRef: { songId: localSongId } } as UnifiedSong;
};

// Persists local playback as a lightweight songId reference while excluding Stage snapshots.
export const persistPlaybackCache = async (song: SongResult | null, queue: SongResult[]) => {
    if (!song || isStagePlaybackSong(song)) {
        return;
    }

    const sanitizedSong = sanitizePlaybackSong(song);
    const sanitizedQueue = queue
        .filter(queuedSong => !isStagePlaybackSong(queuedSong))
        .map(sanitizePlaybackSong);
    return serialize(async () => {
        await Promise.all([
            saveToCache('last_song', sanitizedSong),
            saveToCache('last_queue', sanitizedQueue),
        ]);
    });
};

// 切歌时有多处会 fire-and-forget 地写这两项。两次写并发时 last_song 和
// last_queue 落盘顺序不定，可能存成「歌 B + 队列 A」，下次启动恢复出歌不在队列里的
// 错配。用一条 Promise 链把两种写串行化，后一次总在前一次之后落盘。
let writeChain: Promise<void> = Promise.resolve();
const serialize = (work: () => Promise<void>): Promise<void> => {
    const next = writeChain.then(work, work);
    writeChain = next.catch(() => {});
    return next;
};

// Forgets the saved song and queue, so the next launch restores nothing: the player was emptied.
export const forgetPlaybackCache = async () => {
    // 播放器被清空时，上一次「听到哪儿」也不该留着：否则下次启动会恢复一首
    // 已经不在队列里的歌的位置（那个 key 由 playbackPositionCache 单独管）。
    clearSavedPlaybackPosition();
    // 这里不进串行链：清空是终止状态，直接同步发起删除，避免把调用方的可观察时序
    // 推迟一个微任务（现有测试和清空语义都依赖「调用即发起」）。
    await Promise.all([
        removeFromCache('last_song'),
        removeFromCache('last_queue'),
    ]);
};
