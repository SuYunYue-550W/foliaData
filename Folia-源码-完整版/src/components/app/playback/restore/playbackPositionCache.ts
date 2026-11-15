import { getFromCache, removeFromCache, saveToCache } from '../../../../services/db';
import { getPlaybackSongKey } from '../../../../utils/appPlaybackGuards';
import type { SongResult } from '../../../../types';

// src/components/app/playback/restore/playbackPositionCache.ts
//
// 断点续播只存「听到哪儿」，单独一个 key，不塞进 last_song / last_queue：
// 那两份是音乐库快照，会在切歌、队列编辑时频繁重写，位置跟着它们写既浪费又容易
// 写进「下一首歌」的快照里。
//
// 只在**会话恢复**时读（useSessionRestoreController）。用户主动重新点同一首歌不会
// 读到这份位置，因为它不经过恢复流程 —— 主动点播就该从头开始。

const STORAGE_KEY = 'last_playback_position';
const WRITE_INTERVAL_MS = 5000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type StoredPosition = {
    songKey: string;
    positionSec: number;
    savedAt: number;
};

let pending: StoredPosition | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastWriteAt = 0;

const writeNow = (entry: StoredPosition): void => {
    void saveToCache(STORAGE_KEY, entry).catch((error) => {
        console.warn('[Resume] Failed to save playback position:', error);
    });
    lastWriteAt = Date.now();
};

/** 节流写：5 秒内最多落一次盘；页面隐藏 / 退出由 flush 立即落。 */
export const savePlaybackPosition = (song: SongResult | null, positionSec: number): void => {
    if (!song || typeof positionSec !== 'number' || !Number.isFinite(positionSec) || positionSec < 0) return;
    pending = {
        songKey: getPlaybackSongKey(song),
        positionSec,
        savedAt: Date.now(),
    };
    const elapsed = Date.now() - lastWriteAt;
    if (elapsed >= WRITE_INTERVAL_MS) {
        flushPlaybackPosition();
        return;
    }
    if (flushTimer === null) {
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flushPlaybackPosition();
        }, WRITE_INTERVAL_MS - elapsed);
    }
};

export const flushPlaybackPosition = (): void => {
    if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (!pending) return;
    const entry = pending;
    pending = null;
    writeNow(entry);
};

/** 只认同一首歌：换过歌、或从别处起播，都不会吃到旧位置。 */
export const readSavedPlaybackPosition = async (song: SongResult): Promise<number | null> => {
    let saved: StoredPosition | null = null;
    try {
        saved = await getFromCache<StoredPosition>(STORAGE_KEY);
    } catch {
        return null;
    }
    if (!saved || saved.songKey !== getPlaybackSongKey(song)) return null;
    if (!Number.isFinite(saved.positionSec) || saved.positionSec <= 0) return null;
    // 几个月没打开的应用不该突然从 2:30 开始。没有 savedAt 的旧数据先放过。
    if (saved.savedAt && Date.now() - saved.savedAt > MAX_AGE_MS) return null;
    return saved.positionSec;
};

/** 播放器被清空时忘掉位置，免得下次恢复一首已经不存在的「上次听到哪儿」。 */
export const clearSavedPlaybackPosition = (): void => {
    pending = null;
    if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    void removeFromCache(STORAGE_KEY).catch(() => undefined);
};
