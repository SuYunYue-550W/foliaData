import { LocalPlaylist, LocalSong } from '../types';
import type { PlaylistEntry, PlaylistExternalRef } from '../types';
import { getFromCache, getLocalSongs, saveToCache } from './db';
import { normalizeEntryOrder, normalizeExternalRefs } from '../utils/localPlaylistEntries';
import type { PlaylistEntries } from '../utils/localPlaylistEntries';

const LOCAL_PLAYLISTS_CACHE_KEY = 'local_playlists';
const FAVORITE_PLAYLIST_NAME = 'Liked Songs';
const UNNAMED_PLAYLIST_NAME = 'Untitled Playlist';

const createPlaylistId = () => `local_playlist_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

type LegacyPlaylistSongRef = string | Pick<LocalSong, 'id'> | null | undefined;
type LegacyLocalPlaylist = Partial<LocalPlaylist> & {
    songs?: LegacyPlaylistSongRef[];
    tracks?: LegacyPlaylistSongRef[];
    trackIds?: string[];
};

const dedupeSongIds = (songIds: string[]) => {
    const seen = new Set<string>();
    const deduped: string[] = [];

    songIds.forEach(songId => {
        if (!songId || seen.has(songId)) {
            return;
        }

        seen.add(songId);
        deduped.push(songId);
    });

    return deduped;
};

const DUPLICATE_IMPORT_ROOT_SUFFIX = /\s\(\d+\)$/;

const getRootFolderName = (song: LocalSong): string => {
    const pathLike = song.filePath || song.folderName || '';
    return pathLike.split('/')[0] || '';
};

const getDuplicateImportRootBase = (rootFolderName: string): string => (
    rootFolderName.replace(DUPLICATE_IMPORT_ROOT_SUFFIX, '')
);

const getRelativePathWithoutRoot = (song: LocalSong): string | null => {
    if (!song.filePath) {
        return null;
    }

    const rootFolderName = getRootFolderName(song);
    return rootFolderName && song.filePath.startsWith(`${rootFolderName}/`)
        ? song.filePath.slice(rootFolderName.length + 1)
        : song.filePath;
};

const getDuplicateImportSongKey = (song: LocalSong): string | null => {
    const relativePath = getRelativePathWithoutRoot(song);
    if (!relativePath || typeof song.fileSize !== 'number' || typeof song.fileLastModified !== 'number') {
        return null;
    }

    return `${getDuplicateImportRootBase(getRootFolderName(song))}::${relativePath}::${song.fileSize}::${song.fileLastModified}`;
};

const isPreferredDuplicateImportCanonical = (candidate: LocalSong, current: LocalSong): boolean => {
    const candidateRoot = getRootFolderName(candidate);
    const currentRoot = getRootFolderName(current);
    const candidateLooksDuplicated = DUPLICATE_IMPORT_ROOT_SUFFIX.test(candidateRoot);
    const currentLooksDuplicated = DUPLICATE_IMPORT_ROOT_SUFFIX.test(currentRoot);

    if (candidateLooksDuplicated !== currentLooksDuplicated) {
        return !candidateLooksDuplicated;
    }

    if ((candidate.addedAt || 0) !== (current.addedAt || 0)) {
        return (candidate.addedAt || 0) < (current.addedAt || 0);
    }

    return candidate.id.localeCompare(current.id) < 0;
};

const buildDuplicateImportCanonicalSongIds = (songs: LocalSong[]): Map<string, string> => {
    const canonicalSongs = new Map<string, LocalSong>();

    songs.forEach(song => {
        const duplicateKey = getDuplicateImportSongKey(song);
        if (!duplicateKey) {
            return;
        }

        const currentCanonical = canonicalSongs.get(duplicateKey);
        if (!currentCanonical || isPreferredDuplicateImportCanonical(song, currentCanonical)) {
            canonicalSongs.set(duplicateKey, song);
        }
    });

    return new Map(Array.from(canonicalSongs.entries()).map(([duplicateKey, song]) => [duplicateKey, song.id]));
};

/**
 * 歌单里存的是"重复导入组"的 canonical id（见 repairPlaylistSongIds），而正在播放的可能是同一文件
 * 的另一份副本。判断收藏和写入收藏都必须先换算到同一把尺子，否则写进去的 id 和读出来的对不上。
 */
export const buildCanonicalLocalSongIdIndex = (songs: LocalSong[]): Map<string, string> => {
    const canonicalByDuplicateKey = buildDuplicateImportCanonicalSongIds(songs);
    const index = new Map<string, string>();

    songs.forEach(song => {
        const duplicateKey = getDuplicateImportSongKey(song);
        const canonicalSongId = duplicateKey ? canonicalByDuplicateKey.get(duplicateKey) : undefined;
        if (canonicalSongId && canonicalSongId !== song.id) {
            index.set(song.id, canonicalSongId);
        }
    });

    return index;
};

export const resolveCanonicalLocalSongId = (songId: string, songs: LocalSong[]): string => {
    const song = songs.find(candidate => candidate.id === songId);
    if (!song) {
        return songId;
    }

    const duplicateKey = getDuplicateImportSongKey(song);
    if (!duplicateKey) {
        return songId;
    }

    return buildDuplicateImportCanonicalSongIds(songs).get(duplicateKey) || songId;
};

const repairPlaylistSongIds = (
    songIds: string[],
    validSongById: Map<string, LocalSong>,
    duplicateCanonicalSongIds: Map<string, string>
): { songIds: string[]; changed: boolean; } => {
    const seen = new Set<string>();
    const repairedSongIds: string[] = [];
    let changed = false;

    songIds.forEach(songId => {
        const song = validSongById.get(songId);
        if (!song) {
            changed = true;
            return;
        }

        const duplicateKey = getDuplicateImportSongKey(song);
        const canonicalSongId = duplicateKey ? duplicateCanonicalSongIds.get(duplicateKey) || songId : songId;
        if (canonicalSongId !== songId) {
            changed = true;
        }

        if (seen.has(canonicalSongId)) {
            changed = true;
            return;
        }

        seen.add(canonicalSongId);
        repairedSongIds.push(canonicalSongId);
    });

    return { songIds: repairedSongIds, changed };
};

/**
 * 读盘修复跨源字段。songIds 的本地修复照旧（丢失效 id、canonical 化重复导入），但外部引用不依赖
 * 本地曲库，必须原样留住；entryOrder 的本地项按同一 canonical 规则改写、外部项只要 key 还在
 * externalRefs 里就保留。于是「在线 / 外部条目 + 队列顺序」都不会在 repair 流程里消失。
 */
const repairPlaylistEntries = (
    playlist: LocalPlaylist,
    validSongById: Map<string, LocalSong>,
    duplicateCanonicalSongIds: Map<string, string>,
    repairedSongIds: string[],
): { externalRefs?: PlaylistExternalRef[]; entryOrder?: PlaylistEntry[]; changed: boolean } => {
    if (!playlist.externalRefs?.length && !playlist.entryOrder?.length) {
        return { changed: false };
    }

    const externalRefs = normalizeExternalRefs(playlist.externalRefs);
    const externalKeys = new Set(externalRefs.map(ref => ref.key));
    const repairedSongIdSet = new Set(repairedSongIds);
    const entryOrder: PlaylistEntry[] = [];
    let changed = false;

    (playlist.entryOrder || []).forEach(entry => {
        if (entry.kind === 'external') {
            if (externalKeys.has(entry.key)) {
                entryOrder.push(entry);
            } else {
                changed = true;
            }
            return;
        }

        const song = validSongById.get(entry.songId);
        const duplicateKey = song ? getDuplicateImportSongKey(song) : null;
        const canonicalId = duplicateKey
            ? (duplicateCanonicalSongIds.get(duplicateKey) || entry.songId)
            : entry.songId;
        if (song && repairedSongIdSet.has(canonicalId)) {
            if (canonicalId !== entry.songId) {
                changed = true;
                entryOrder.push({ kind: 'local', songId: canonicalId });
            } else {
                entryOrder.push(entry);
            }
        } else {
            changed = true;
        }
    });

    if (externalRefs.length !== (playlist.externalRefs?.length ?? 0)) changed = true;
    if (entryOrder.length !== (playlist.entryOrder?.length ?? 0)) changed = true;

    const hasExternalEntry = entryOrder.some(entry => entry.kind === 'external');
    if (!hasExternalEntry && externalRefs.length) changed = true;

    return {
        ...(hasExternalEntry && externalRefs.length ? { externalRefs } : {}),
        ...(entryOrder.length ? { entryOrder } : {}),
        changed,
    };
};

const repairPlaylist = (
    playlist: LocalPlaylist,
    validSongById: Map<string, LocalSong>,
    duplicateCanonicalSongIds: Map<string, string>,
): { playlist: LocalPlaylist; changed: boolean } => {
    const base = repairPlaylistSongIds(playlist.songIds, validSongById, duplicateCanonicalSongIds);
    const entries = repairPlaylistEntries(playlist, validSongById, duplicateCanonicalSongIds, base.songIds);
    if (!base.changed && !entries.changed) {
        return { playlist, changed: false };
    }

    const next: LocalPlaylist = { ...playlist, songIds: base.songIds };
    if (entries.externalRefs?.length) {
        next.externalRefs = entries.externalRefs;
    } else {
        delete next.externalRefs;
    }
    if (entries.entryOrder?.length) {
        next.entryOrder = entries.entryOrder;
    } else {
        delete next.entryOrder;
    }
    return { playlist: next, changed: true };
};

const normalizeSongIdRef = (value: LegacyPlaylistSongRef): string | null => {
    if (typeof value === 'string') {
        return value;
    }

    if (value && typeof value === 'object' && typeof value.id === 'string') {
        return value.id;
    }

    return null;
};

// Reads legacy playlist payloads and converts them into the current song-id-only shape.
const resolvePlaylistSongIds = (playlist: LegacyLocalPlaylist): string[] => {
    const candidateCollections: LegacyPlaylistSongRef[][] = [];

    if (Array.isArray(playlist.songIds)) {
        candidateCollections.push(playlist.songIds as LegacyPlaylistSongRef[]);
    }

    if (Array.isArray(playlist.trackIds)) {
        candidateCollections.push(playlist.trackIds);
    }

    if (Array.isArray(playlist.songs)) {
        candidateCollections.push(playlist.songs);
    }

    if (Array.isArray(playlist.tracks)) {
        candidateCollections.push(playlist.tracks);
    }

    for (const collection of candidateCollections) {
        const normalized = dedupeSongIds(
            collection
                .map(normalizeSongIdRef)
                .filter((songId): songId is string => Boolean(songId))
        );

        if (normalized.length > 0) {
            return normalized;
        }
    }

    return [];
};

// 跨源歌单的 externalRefs / entryOrder 也在这里过一遍校验并保留：persistPlaylists 写盘、
// getLocalPlaylists 读盘都走它，漏掉任一个都会把在线 / 外部条目在保存或读取时弄丢。
// 旧歌单没有这两个字段，normalize* 返回空数组，于是产物与从前逐字段一致。
const normalizePlaylist = (playlist: LegacyLocalPlaylist): LocalPlaylist => {
    const normalized: LocalPlaylist = {
        id: typeof playlist.id === 'string' && playlist.id ? playlist.id : createPlaylistId(),
        name: typeof playlist.name === 'string' && playlist.name
            ? playlist.name
            : (playlist.isFavorite ? FAVORITE_PLAYLIST_NAME : UNNAMED_PLAYLIST_NAME),
        songIds: resolvePlaylistSongIds(playlist),
        createdAt: typeof playlist.createdAt === 'number' ? playlist.createdAt : Date.now(),
        updatedAt: typeof playlist.updatedAt === 'number' ? playlist.updatedAt : Date.now(),
        isFavorite: Boolean(playlist.isFavorite),
    };

    const externalRefs = normalizeExternalRefs(playlist.externalRefs);
    const entryOrder = normalizeEntryOrder(playlist.entryOrder);
    if (externalRefs.length) normalized.externalRefs = externalRefs;
    if (entryOrder.length) normalized.entryOrder = entryOrder;

    return normalized;
};

const playlistNeedsNormalization = (playlist: LegacyLocalPlaylist): boolean => {
    if (!Array.isArray(playlist.songIds)) {
        return true;
    }

    if (Array.isArray(playlist.songs) || Array.isArray(playlist.tracks) || Array.isArray(playlist.trackIds)) {
        return true;
    }

    const normalizedSongIds = resolvePlaylistSongIds(playlist);
    if (normalizedSongIds.length !== playlist.songIds.length) {
        return true;
    }

    if (normalizedSongIds.some((songId, index) => songId !== playlist.songIds?.[index])) {
        return true;
    }

    // 畸形 / 非数组的跨源字段在 normalizePlaylist 里会被清掉，落盘一次免得每次读都再修。
    if (playlist.externalRefs !== undefined) {
        const raw = playlist.externalRefs as unknown;
        const rawLength = Array.isArray(raw) ? raw.length : 0;
        if (normalizeExternalRefs(raw).length !== rawLength) {
            return true;
        }
    }

    if (playlist.entryOrder !== undefined) {
        const raw = playlist.entryOrder as unknown;
        const rawLength = Array.isArray(raw) ? raw.length : 0;
        if (normalizeEntryOrder(raw).length !== rawLength) {
            return true;
        }
    }

    return typeof playlist.createdAt !== 'number' || typeof playlist.updatedAt !== 'number';
};

const persistPlaylists = async (playlists: LocalPlaylist[]) => {
    await saveToCache(LOCAL_PLAYLISTS_CACHE_KEY, playlists.map(normalizePlaylist));
};

export const getLocalPlaylists = async (): Promise<LocalPlaylist[]> => {
    const cached = await getFromCache<LegacyLocalPlaylist[]>(LOCAL_PLAYLISTS_CACHE_KEY);
    const cachedPlaylists = Array.isArray(cached) ? cached : [];
    const localSongs = await getLocalSongs();
    const validSongById = new Map(localSongs.map(song => [song.id, song]));
    const duplicateCanonicalSongIds = buildDuplicateImportCanonicalSongIds(localSongs);
    let shouldPersist = cachedPlaylists.some(playlistNeedsNormalization);
    const playlists = cachedPlaylists.map(normalizePlaylist).map(playlist => {
        const repaired = repairPlaylist(playlist, validSongById, duplicateCanonicalSongIds);
        if (repaired.changed) {
            shouldPersist = true;
        }
        return repaired.playlist;
    });

    const favoritePlaylist = playlists.find(playlist => playlist.isFavorite);
    if (!favoritePlaylist) {
        const nextPlaylists: LocalPlaylist[] = [
            {
                id: createPlaylistId(),
                name: FAVORITE_PLAYLIST_NAME,
                songIds: [],
                createdAt: Date.now(),
                updatedAt: Date.now(),
                isFavorite: true,
            },
            ...playlists,
        ];
        await persistPlaylists(nextPlaylists);
        return nextPlaylists;
    }

    if (shouldPersist) {
        await persistPlaylists(playlists);
    }

    return playlists;
};

export const saveLocalPlaylists = async (playlists: LocalPlaylist[]): Promise<LocalPlaylist[]> => {
    const normalized = playlists.map(normalizePlaylist);
    await persistPlaylists(normalized);
    return normalized;
};

export const createLocalPlaylist = async (name: string, songs: LocalSong[] = []): Promise<LocalPlaylist> => {
    const playlists = await getLocalPlaylists();
    const now = Date.now();
    const playlist: LocalPlaylist = {
        id: createPlaylistId(),
        name: name.trim(),
        songIds: dedupeSongIds(songs.map(song => song.id)),
        createdAt: now,
        updatedAt: now,
    };

    await persistPlaylists([...playlists, playlist]);
    return playlist;
};

/**
 * 跨源队列另存为歌单：songIds 只放去重后的本地 id（语义与旧歌单一致），外部条目引用与队列的
 * 有序位置单独存。纯本地队列仍走 createLocalPlaylist，不给旧数据凭空加上这两个字段。
 */
export const createLocalPlaylistFromQueue = async (name: string, entries: PlaylistEntries): Promise<LocalPlaylist> => {
    const playlists = await getLocalPlaylists();
    const now = Date.now();
    const playlist: LocalPlaylist = {
        id: createPlaylistId(),
        name: name.trim(),
        songIds: dedupeSongIds(entries.songIds),
        createdAt: now,
        updatedAt: now,
        externalRefs: entries.externalRefs,
        entryOrder: entries.entryOrder,
    };

    await persistPlaylists([...playlists, playlist]);
    return playlist;
};

export const updateLocalPlaylist = async (
    playlistId: string,
    updater: (playlist: LocalPlaylist) => LocalPlaylist
): Promise<LocalPlaylist | null> => {
    const playlists = await getLocalPlaylists();
    let updatedPlaylist: LocalPlaylist | null = null;

    const nextPlaylists = playlists.map(playlist => {
        if (playlist.id !== playlistId) {
            return playlist;
        }

        updatedPlaylist = normalizePlaylist({
            ...updater(playlist),
            updatedAt: Date.now(),
        });
        return updatedPlaylist;
    });

    if (!updatedPlaylist) {
        return null;
    }

    await persistPlaylists(nextPlaylists);
    return updatedPlaylist;
};

export const deleteLocalPlaylist = async (playlistId: string): Promise<void> => {
    const playlists = await getLocalPlaylists();
    const target = playlists.find(playlist => playlist.id === playlistId);
    if (!target || target.isFavorite) {
        return;
    }

    await persistPlaylists(playlists.filter(playlist => playlist.id !== playlistId));
};

export const canDeleteLocalPlaylist = (playlist: LocalPlaylist | null | undefined): boolean => {
    return Boolean(playlist && !playlist.isFavorite);
};

const addSongIdsToLocalPlaylist = async (playlistId: string, songIds: string[]): Promise<LocalPlaylist | null> => (
    updateLocalPlaylist(playlistId, playlist => ({
        ...playlist,
        songIds: dedupeSongIds([...playlist.songIds, ...songIds]),
    }))
);

export const addSongsToLocalPlaylist = async (playlistId: string, songs: LocalSong[]): Promise<LocalPlaylist | null> => (
    addSongIdsToLocalPlaylist(playlistId, songs.map(song => song.id))
);

export const removeSongsFromLocalPlaylist = async (playlistId: string, songIds: string[]): Promise<LocalPlaylist | null> => {
    const removingIds = new Set(songIds);
    return updateLocalPlaylist(playlistId, playlist => ({
        ...playlist,
        songIds: playlist.songIds.filter(songId => !removingIds.has(songId)),
    }));
};

export const reorderLocalPlaylistSongs = async (
    playlistId: string,
    songIds: string[]
): Promise<LocalPlaylist | null> => updateLocalPlaylist(playlistId, playlist => ({
    ...playlist,
    songIds: dedupeSongIds(songIds),
}));

export const getFavoriteLocalPlaylist = async (): Promise<LocalPlaylist> => {
    const playlists = await getLocalPlaylists();
    const favoritePlaylist = playlists.find(playlist => playlist.isFavorite);

    if (!favoritePlaylist) {
        const created = await createLocalPlaylist(FAVORITE_PLAYLIST_NAME);
        return {
            ...created,
            isFavorite: true,
        };
    }

    return favoritePlaylist;
};

export const setLocalSongFavorite = async (song: LocalSong, shouldFavorite: boolean): Promise<LocalPlaylist | null> => {
    const favoritePlaylist = await getFavoriteLocalPlaylist();
    const canonicalSongId = resolveCanonicalLocalSongId(song.id, await getLocalSongs());

    if (shouldFavorite) {
        return addSongIdsToLocalPlaylist(favoritePlaylist.id, [canonicalSongId]);
    }

    return removeSongsFromLocalPlaylist(favoritePlaylist.id, [canonicalSongId]);
};
