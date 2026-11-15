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
    await Promise.all([
        saveToCache('last_song', sanitizedSong),
        saveToCache('last_queue', sanitizedQueue),
    ]);
};

// Forgets the saved song and queue, so the next launch restores nothing: the player was emptied.
export const forgetPlaybackCache = async () => {
    // 播放器被清空时，上一次「听到哪儿」也不该留着：否则下次启动会恢复一首
    // 已经不在队列里的歌的位置（那个 key 由 playbackPositionCache 单独管）。
    clearSavedPlaybackPosition();
    await Promise.all([
        removeFromCache('last_song'),
        removeFromCache('last_queue'),
    ]);
};
