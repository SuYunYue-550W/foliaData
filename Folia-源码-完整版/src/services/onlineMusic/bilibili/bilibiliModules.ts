import type { ProviderPage } from '../../../types/onlineMusic';
import { requestBilibili } from './bilibiliTransport';
import { biliRecord, normalizeBilibiliLive, normalizeBilibiliSong } from './bilibiliNormalize';

// src/services/onlineMusic/bilibili/bilibiliModules.ts
// 七个模块的数据获取。接口实测见 transport 顶部注释。
// 这里只认 B站原始数据的形状，转成 UnifiedSong 后交给 omni，UI 不碰平台字段。

export type BilibiliModuleId = 'recommend' | 'popular' | 'anime' | 'film' | 'live' | 'favorites' | 'history';

export interface BilibiliPageOptions {
    page?: number;
    pageSize?: number;
    /** 分区/收藏夹 id；直播模块用它作 parent_area_id。 */
    areaId?: number;
    mediaId?: string;
}

const asPage = (items: ReturnType<typeof normalizeBilibiliSong>[], offset: number, hasMore: boolean): ProviderPage<any> => ({
    items,
    hasMore,
    nextOffset: offset + items.length,
});

/** 推荐：游标式翻页，fresh_idx 递增。 */
export const getBilibiliRecommend = async (options: BilibiliPageOptions = {}): Promise<ProviderPage<any>> => {
    const freshIdx = Math.max(1, options.page ?? 1);
    const { data } = await requestBilibili<any>('recommend', { fresh_idx: freshIdx, ps: options.pageSize ?? 12 });
    const items = (Array.isArray(data?.item) ? data.item : []).map(normalizeBilibiliSong);
    // 推荐是 fresh_idx 游标式翻页：下一页的游标是 idx+1，不是条目数。
    // 之前恒传 0，上层按 nextOffset 续拉会一直拿回第一页。
    return asPage(items, freshIdx + 1, items.length > 0);
};

/** 热门：页码式。 */
export const getBilibiliPopular = async (options: BilibiliPageOptions = {}): Promise<ProviderPage<any>> => {
    const pn = Math.max(1, options.page ?? 1);
    const { data } = await requestBilibili<any>('popular', { pn, ps: options.pageSize ?? 20 });
    const items = (Array.isArray(data?.list) ? data.list : []).map(normalizeBilibiliSong);
    return asPage(items, (pn - 1) * (options.pageSize ?? 20), !data?.no_more && items.length > 0);
};

/** 分区视频：动画 rid=1、影视 rid=181（音乐 rid=3 备查）。 */
export const getBilibiliRegion = async (rid: number, options: BilibiliPageOptions = {}): Promise<ProviderPage<any>> => {
    const pn = Math.max(1, options.page ?? 1);
    const { data } = await requestBilibili<any>('video-newlist', { rid, pn, ps: options.pageSize ?? 20 });
    const items = (Array.isArray(data?.archives) ? data.archives : []).map(normalizeBilibiliSong);
    const pageInfo = biliRecord(data?.page);
    return asPage(items, (pn - 1) * (options.pageSize ?? 20), items.length > 0 && (pageInfo.count == null || pn * (options.pageSize ?? 20) < Number(pageInfo.count)));
};

/** 直播：先取分区列表，再取房间；房间用 normalizeBilibiliLive。 */
export const getBilibiliLive = async (options: BilibiliPageOptions = {}): Promise<ProviderPage<any>> => {
    const page = Math.max(1, options.page ?? 1);
    const { data } = await requestBilibili<any>('live-rooms', {
        parent_area_id: options.areaId ?? 1,
        page,
        page_size: options.pageSize ?? 20,
    });
    const items = (Array.isArray(data?.list) ? data.list : []).map(normalizeBilibiliLive);
    return asPage(items, (page - 1) * (options.pageSize ?? 20), items.length > 0 && Number(data?.count || 0) > page * (options.pageSize ?? 20));
};

export const getBilibiliLiveAreas = async (): Promise<{ id: number; name: string }[]> => {
    const { data } = await requestBilibili<any>('live-areas');
    const areas = Array.isArray(data) ? data : [];
    return areas.flatMap((area: any) => (Array.isArray(area?.list) ? area.list : []))
        .map((item: any) => ({ id: Number(item.id), name: String(item.name || '') }))
        .filter((item: { id: number }) => Number.isFinite(item.id) && item.id > 0);
};

/** 收藏：先取收藏夹列表，mediaId 指定时取该夹视频。必须登录。 */
export const getBilibiliFavorites = async (options: BilibiliPageOptions = {}): Promise<ProviderPage<any>> => {
    const nav = await requestBilibili<any>('login-status');
    const mid = biliRecord(nav.data).mid;
    if (!mid) throw new Error('bilibili favorites: 需要登录');
    if (options.mediaId) {
        const pn = Math.max(1, options.page ?? 1);
        const { data } = await requestBilibili<any>('fav-resources', { media_id: options.mediaId, pn, ps: options.pageSize ?? 20 });
        const items = (Array.isArray(data?.medias) ? data.medias : []).map(normalizeBilibiliSong);
        return asPage(items, (pn - 1) * (options.pageSize ?? 20), Boolean(data?.has_more));
    }
    const { data } = await requestBilibili<any>('fav-folders', { up_mid: mid });
    const folders = (Array.isArray(data) ? data : []).map((folder: any) => ({
        id: String(folder.id),
        title: String(folder.title || ''),
        count: Number(folder.media_count) || 0,
    }));
    // 收藏夹列表不是歌曲页：返回空 items，UI 用 providerData 里的目录绘制。
    return { items: [], hasMore: false, nextOffset: 0, collections: folders } as ProviderPage<any> & { collections: unknown[] };
};

/** 历史记录：游标式。必须登录。 */
export const getBilibiliHistory = async (options: BilibiliPageOptions = {}): Promise<ProviderPage<any>> => {
    const max = options.page && options.page > 1 ? options.page : 0;
    const { data } = await requestBilibili<any>('history', { max, ps: options.pageSize ?? 20 });
    const items = (Array.isArray(data?.list) ? data.list : [])
        .filter((item: any) => Boolean(item?.bvid))
        .map(normalizeBilibiliSong);
    return asPage(items, max, items.length > 0);
};

export const getBilibiliModule = (module: BilibiliModuleId, options: BilibiliPageOptions = {}): Promise<ProviderPage<any>> => {
    switch (module) {
        case 'recommend': return getBilibiliRecommend(options);
        case 'popular': return getBilibiliPopular(options);
        case 'anime': return getBilibiliRegion(1, options);
        case 'film': return getBilibiliRegion(181, options);
        case 'live': return getBilibiliLive(options);
        case 'favorites': return getBilibiliFavorites(options);
        case 'history': return getBilibiliHistory(options);
        default: throw new Error(`bilibili module ${module}`);
    }
};
