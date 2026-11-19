import type { Artist, UnifiedSong } from '../../../types';
import type { JsonValue, ProviderCollection } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';

// src/services/onlineMusic/bilibili/bilibiliNormalize.ts
// B站视频 → UnifiedSong 的归一化。B站没有"音乐曲库"，音乐是视频音轨：
// - 视频用 bvid 作 id，cid 放进 providerData（取流要 cid）。
// - "艺人"是 UP 主；专辑用«视频»代替，封面用视频封面。
// - 直播间没有 bvid，用 room:<roomid> 作 id，providerData.live=true 标记。

export type BiliRecord = Record<string, any>;
export const biliRecord = (value: unknown): BiliRecord => (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);
const text = (value: unknown) => value == null ? '' : String(value);
const picture = (value: unknown) => {
    const url = text(value);
    // 搜索接口给的是 // 开头的协议相对地址，补成 https。
    return url.startsWith('//') ? `https:${url}` : url;
};
const digits = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
};

/** 搜索结果里的标题带 <em class="keyword"> 高亮标签，去掉后才好显示。 */
export const cleanBiliTitle = (value: unknown): string => text(value)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();

const artistsOf = (owner: unknown, fallback?: string): Artist[] => {
    const o = biliRecord(owner);
    const name = text(o.name || fallback);
    if (!name) return [];
    return [{ id: text(o.mid), name, catalogRef: o.mid ? { providerId: 'bilibili', kind: 'artist', id: text(o.mid) } : undefined }];
};

/** 普通视频（搜索/推荐/热门/分区/收藏/历史里的一项）。 */
export const normalizeBilibiliSong = (raw: unknown): UnifiedSong => {
    const item = biliRecord(raw);
    if (item.sourceRef?.kind === 'online' && item.sourceRef.providerId === 'bilibili') return item as UnifiedSong;
    const bvid = text(item.bvid);
    if (!bvid) throw new OnlineProviderError('invalid-response', 'Bilibili video has no bvid', 'bilibili');
    const data: Record<string, JsonValue> = {};
    if (item.cid != null) data.cid = digits(item.cid);
    if (item.aid != null) data.aid = digits(item.aid);
    if (item.stat) {
        const stat = biliRecord(item.stat);
        if (stat.view != null) data.view = digits(stat.view);
        if (stat.danmaku != null) data.danmaku = digits(stat.danmaku);
    }
    return {
        id: bvid,
        name: cleanBiliTitle(item.title),
        artists: artistsOf(item.owner || item.author, text(item.owner?.name || item.author)),
        album: {
            id: bvid,
            name: text(item.tname || '哔哩哔哩视频'),
            coverUrl: picture(item.pic),
        },
        durationMs: (() => {
            const d = item.duration;
            if (typeof d === 'string' && d.includes(':')) {
                const parts = d.split(':').map(Number);
                return parts.reduce((acc, part) => acc * 60 + (Number.isFinite(part) ? part : 0), 0) * 1000;
            }
            return digits(d) * 1000;
        })(),
        sourceRef: { kind: 'online', providerId: 'bilibili', mediaId: bvid, providerData: data },
    };
};

/** 直播间：没有 bvid/cid，id 用 room: 前缀，取流走 live-playurl。 */
export const normalizeBilibiliLive = (raw: unknown): UnifiedSong => {
    const item = biliRecord(raw);
    const roomId = digits(item.roomid ?? item.room_id);
    if (!roomId) throw new OnlineProviderError('invalid-response', 'Bilibili live room has no roomid', 'bilibili');
    return {
        id: `room:${roomId}`,
        name: text(item.title || item.uname || `直播间 ${roomId}`),
        artists: artistsOf({ mid: item.uid, name: item.uname }),
        album: { id: `room:${roomId}`, name: '哔哩哔哩直播', coverUrl: picture(item.user_cover || item.cover) },
        durationMs: 0,
        sourceRef: {
            kind: 'online',
            providerId: 'bilibili',
            mediaId: `room:${roomId}`,
            providerData: { live: true, roomId },
        },
    };
};

export const isBilibiliLiveSong = (song: UnifiedSong): boolean => (
    song.sourceRef?.kind === 'online'
    && song.sourceRef.providerId === 'bilibili'
    && song.sourceRef.providerData?.live === true
);

export const normalizeBilibiliCollection = (raw: unknown, type = 'playlist'): ProviderCollection => {
    const item = biliRecord(raw);
    if (item.providerId === 'bilibili') return item as ProviderCollection;
    const id = text(item.id ?? item.media_id);
    if (!id) throw new OnlineProviderError('invalid-response', 'Bilibili collection has no id', 'bilibili');
    return {
        providerId: 'bilibili',
        id,
        type,
        name: text(item.title || item.name),
        coverUrl: picture(item.cover),
        description: text(item.desc),
        trackCount: digits(item.media_count ?? item.count),
    };
};
