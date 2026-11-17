// src/services/onlineMusic/ytm/android/ytmAndroidLibrary.ts
//
// YouTube Music 账号「资料库」类 operation 在 Android 上的实现。
//
// 与桌面端 electron/ytm/ytmApiBridge.cjs 的 webLibraryPage / playlistPageOf 同构：
// 都走登录后的 youtubei.js 会话读网页 browse 数据，再折成 ytmTransport.ts 的 wire 形状。
// 原生 Kotlin 一行都不用改 —— 会话与 cookie 都在 WebView 侧（ytmAndroidBridge.ts）。
//
// 这里只做读类；写类（song_like / list_save / playlist_edit）留在后续。

import type { YtmParams, YtmWireCollection } from '../ytmTransport';
import {
    entityId, fail, loadLibrary, pageToken, playlistPageOf, signedSession,
} from './ytmAndroidBridge';

/** 账号资料库的两个页签，与桌面 webPages.cjs 的常量一致。 */
const PLAYLISTS_TAB = 'FEmusic_liked_playlists';
const ALBUMS_TAB = 'FEmusic_liked_albums';

/** 「我喜欢的音乐」，桌面端也是这个 id。 */
const LIKED_SONGS = 'LM';

/**
 * 一页账号资料库网格。用登录会话的 actions.execute 读 browse，
 * 与同文件里 album / public_playlist handler 的调用范式一致。
 */
const libraryPage = async (browseId: string, params: YtmParams, type: 'playlist' | 'album'): Promise<unknown> => {
    const token = pageToken(params.continuation);
    if (params.continuation !== undefined && !token) fail('invalid-response', 'Invalid page token');
    const yt = await signedSession();
    const page: any = await yt.actions.execute('/browse', {
        ...(token ? { continuation: token } : { browseId }), client: 'YTMUSIC', parse: true,
    });
    const { YTNodes } = await loadLibrary();
    // 网格有两种容器：Grid（歌单页签）或 MusicShelf（部分版本）。都取第一行。
    const rows: unknown[] = [
        ...(page.contents_memo?.getType(YTNodes.Grid)?.[0]?.contents ?? []),
        ...(page.contents_memo?.getType(YTNodes.MusicShelf)?.[0]?.contents ?? []),
        ...(page.on_response_received_actions?.[0]?.contents ?? []),
    ];
    const items = rows.filter(Boolean).map(row => collectionFromRow(row))
        .filter((item): item is YtmWireCollection => item !== null && item.type === type);
    const continuation: unknown = page.contents_memo?.getType(YTNodes.Grid)?.[0]?.continuation
        ?? page.contents_memo?.getType(YTNodes.MusicShelf)?.[0]?.continuation
        ?? page.on_response_received_actions?.[0]?.continuation?.payload?.token;
    return {
        items,
        ...(typeof continuation === 'string' && continuation ? { continuation } : {}),
    };
};

/** 网格里的一行折成 collection；认不出就返回 null（与桌面 webPages.collectionFromRow 同纪律）。 */
const collectionFromRow = (row: any): YtmWireCollection | null => {
    const renderer = row?.musicTwoRowItemRenderer ?? row?.musicResponsiveListItemRenderer;
    if (!renderer) return null;
    const id: unknown = renderer.navigationEndpoint?.browseEndpoint?.browseId;
    const name: unknown = renderer.title?.runs?.[0]?.text ?? renderer.title?.simpleText;
    if (typeof id !== 'string' || typeof name !== 'string') return null;
    const type = id.startsWith('MPRE') ? 'album' : id.startsWith('VL') || id.startsWith('PL') ? 'playlist' : null;
    if (!type) return null;
    const thumbnail: unknown = renderer.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url;
    return {
        id, name, type,
        ...(typeof thumbnail === 'string' ? { thumbnail } : {}),
    } as YtmWireCollection;
};

export const androidLibraryHandlers = {
    /** 账号的歌单页签。 */
    async user_playlists(params: YtmParams) {
        return libraryPage(PLAYLISTS_TAB, params, 'playlist');
    },

    /** 账号的专辑页签。 */
    async user_albums(params: YtmParams) {
        return libraryPage(ALBUMS_TAB, params, 'album');
    },

    /**
     * 账号自己的歌单（含「我喜欢的音乐」LM）。
     * 与桌面 playlist 一致：第一页用 browseId，后续页用 continuation。
     */
    async playlist(params: YtmParams) {
        const token = pageToken(params.continuation);
        if (params.continuation !== undefined && !token) fail('invalid-response', 'Invalid page token');
        const raw = params.id ?? LIKED_SONGS;
        const id = raw === LIKED_SONGS ? LIKED_SONGS : entityId(raw);
        if (!id) fail('invalid-response', 'Invalid playlist id');
        const [yt, { YTNodes }] = await Promise.all([signedSession(), loadLibrary()]);
        const page: any = await yt.actions.execute('/browse', {
            ...(token ? { continuation: token } : { browseId: id === LIKED_SONGS ? LIKED_SONGS : `VL${id}` }),
            client: 'YTMUSIC', parse: true,
        });
        return playlistPageOf(page, Boolean(token), YTNodes);
    },
};
