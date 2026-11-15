import type { SongResult } from '../types';
import type { ArchivePlay } from './listeningArchive/types';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';
import { isSongUnavailable } from './onlineMusic/songAvailability';
import { getLocalSongs } from './db';
import { buildLocalQueue } from './playbackAdapters';
import { loadArchivePlays } from './listeningArchive/repository';
import { noteWholeQueueWrite } from './wholeQueueWrites';
import { setPlayQueue, usePlaybackStore } from '../stores/usePlaybackStore';
import { setStatusMessage } from '../stores/useStatusMessageStore';

// src/services/radioStation.ts
// 本地智能电台：以当前播放的歌为种子，从「听歌档案 + 曲库」里挑出续播队列。
//
// 选曲的优先级（逐档收紧，逐档补齐到 20 首）：
//   1. 听歌档案里与种子相关的常听曲目 —— 与种子同歌手、或同专辑，按播放次数排。
//      档案数据只读（listeningArchive/repository 的 loadArchivePlays），不改它的文件。
//   2. 曲库（本地曲库 + 当前队列）里与种子同专辑、同歌手的歌。
//   3. 曲库里其余的歌，乱序补齐 —— 档案为空的新用户自然落在这里，
//      而 1/2 两档空掉时 2 仍在，退化成「同歌手/同专辑随机」，正是兜底要求的那条。
//
// 调性 / BPM 相近这一档刻意没做：曲库侧没有逐歌的调性数据，分析器（beatThis /
// htdemucs）只对播放过的歌有缓存，为一个电台去全库跑模型不成比例。档案常听 +
// 同歌手在实际听感上已经是更稳的「像这首歌」。
//
// 纯函数部分（选曲、去重、排序）不碰任何 store，测试在 test/unit/services/radioStation.test.ts。

/** 电台一支的长度。 */
export const RADIO_STATION_COUNT = 20;

const normalizeName = (name: string): string => name.trim().toLowerCase();

const seedArtistNames = (song: SongResult): Set<string> => (
    new Set(song.artists.map(artist => normalizeName(artist.name)).filter(name => name !== ''))
);

const sharesArtist = (song: SongResult, seedArtists: Set<string>): boolean => (
    song.artists.some(artist => seedArtists.has(normalizeName(artist.name)))
);

/** 档案行聚合出来的「常听歌」：按播放次数从多到少。 */
export interface RadioArchiveSong {
    /** 档案行里的歌曲 id，拿它回曲库里认领。 */
    songId: string;
    /** 归一后的歌名（songKey 的一部分），曲库匹配不上 id 时兜底比对。 */
    title: string;
    plays: number;
    artists: string[];
    albumName: string | null;
}

/**
 * 从档案行里聚合出候选歌。与种子相关的行才算：同歌手、或同专辑。
 * 档案按听过的次数说话，所以同一首歌听一百次排在一百次不同的歌前面。
 */
export const collectArchiveCandidates = (
    plays: ArchivePlay[],
    seed: SongResult,
): RadioArchiveSong[] => {
    const seedArtists = seedArtistNames(seed);
    const seedAlbum = seed.album?.name ? normalizeName(seed.album.name) : null;
    const byId = new Map<string, RadioArchiveSong>();

    for (const play of plays) {
        if (!play.counted) continue;
        const playArtists = play.artists.map(normalizeName);
        const artistRelated = playArtists.some(name => seedArtists.has(name));
        const albumRelated = seedAlbum !== null && play.albumName !== null
            && normalizeName(play.albumName) === seedAlbum;
        if (!artistRelated && !albumRelated) continue;

        const existing = byId.get(play.songId);
        if (existing) {
            existing.plays += 1;
            continue;
        }
        byId.set(play.songId, {
            songId: play.songId,
            title: play.title,
            plays: 1,
            artists: play.artists,
            albumName: play.albumName,
        });
    }

    return [...byId.values()].sort((a, b) => {
        if (a.plays !== b.plays) return b.plays - a.plays;
        return a.songId < b.songId ? -1 : a.songId > b.songId ? 1 : 0;
    });
};

export interface BuildSeedRadioQueueParams {
    /** 种子歌：电台绕着它转。 */
    seed: SongResult;
    /** 候选池：曲库（本地曲库 + 在线可达的）与当前队列并起来的歌。 */
    pool: SongResult[];
    /** 听歌档案的原始行；空数组 = 新用户，走兜底。 */
    archivePlays: ArchivePlay[];
    /** 要多少首；默认 RADIO_STATION_COUNT。 */
    count?: number;
    /** 额外要排除的键（种子自己的键会自动排除，不必传）。 */
    excludeKeys?: ReadonlySet<string>;
    /** 注入随机源，测试可复现；缺省 Math.random。 */
    random?: () => number;
    /** 注入可播性判定，缺省 isSongUnavailable。 */
    isPlayable?: (song: SongResult) => boolean;
}

/**
 * 生成电台队列：已按优先级排好序、去过重、排除种子与不可播的歌。
 * 不改写传入的任何数组，也不碰 store —— 写队列是调用方（命令面板）的事。
 */
export const buildSeedRadioQueue = ({
    seed,
    pool,
    archivePlays,
    count = RADIO_STATION_COUNT,
    excludeKeys,
    random = Math.random,
    isPlayable = song => !isSongUnavailable(song),
}: BuildSeedRadioQueueParams): SongResult[] => {
    const taken = new Set<string>([getPlaybackSongKey(seed), ...(excludeKeys ?? [])]);
    const picked: SongResult[] = [];
    const take = (song: SongResult): boolean => {
        const key = getPlaybackSongKey(song);
        if (taken.has(key)) return false;
        taken.add(key);
        picked.push(song);
        return true;
    };

    const usable = pool.filter(song => song && isPlayable(song));
    const seedArtists = seedArtistNames(seed);
    const seedAlbum = seed.album?.name ? normalizeName(seed.album.name) : null;

    // ---- 档案档：常听且与种子相关，按次数排 ----
    // 曲库里按 id 认领；同一首歌换了源（本地换在线）id 对不上时，
    // 退而按归一歌名 + 歌手指认 —— 档案的 songKey 就是这么归一的。
    const archiveCandidates = collectArchiveCandidates(archivePlays, seed);
    const claimedArchiveIds = new Set<string>();
    for (const candidate of archiveCandidates) {
        if (picked.length >= count) break;
        const match = usable.find(song => {
            if (claimedArchiveIds.has(String(song.id))) return false;
            if (String(song.id) === candidate.songId) return true;
            return normalizeName(song.name) === normalizeName(candidate.title)
                && sharesArtist(song, new Set(candidate.artists.map(normalizeName)));
        });
        if (match) {
            claimedArchiveIds.add(String(match.id));
            take(match);
        }
    }

    // ---- 曲库档：同专辑优先于同歌手，各自内部乱序（电台不该每次一样）----
    const sameAlbum = usable.filter(song => seedAlbum !== null
        && song.album?.name && normalizeName(song.album.name) === seedAlbum);
    const sameArtist = usable.filter(song => sharesArtist(song, seedArtists));
    const others = usable.filter(song => !sameAlbum.includes(song) && !sameArtist.includes(song));

    const shuffled = <T,>(items: T[]): T[] => {
        const copy = [...items];
        for (let i = copy.length - 1; i > 0; i -= 1) {
            const j = Math.floor(random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
    };

    for (const song of shuffled(sameAlbum)) {
        if (picked.length >= count) break;
        take(song);
    }
    for (const song of shuffled(sameArtist)) {
        if (picked.length >= count) break;
        take(song);
    }
    for (const song of shuffled(others)) {
        if (picked.length >= count) break;
        take(song);
    }

    return picked;
};

// ---------------------------------------------------------------------------
// 共享 runner：命令面板的「playback-seed-radio」与播放页队列页签的「电台」按钮
// 走同一条路。抽出来是为了让按钮不必经 command palette 的 context 才能触发，
// 两处的行为（候选池、写队列、提示）也永远一致。
// ---------------------------------------------------------------------------

export type SeedRadioTexts = {
    noSeed: string;
    empty: string;
    added: (count: number) => string;
};

/**
 * 以当前播放的歌为种子开电台：选 20 首续到当前队列后面。
 *
 * 候选池 = 当前队列 + 本地曲库（在线队列里的歌也是合法候选）。
 * 返回 true 表示已续入；false 表示没有种子或挑不出歌（状态条已给出对应提示）。
 */
export const startSeedRadio = async (texts: SeedRadioTexts): Promise<boolean> => {
    const { currentSong, playQueue } = usePlaybackStore.getState();
    const seed = currentSong;
    if (!seed) {
        setStatusMessage({ type: 'info', text: texts.noSeed, nonce: Date.now(), durationMs: 2000 });
        return false;
    }
    const localSongs = await getLocalSongs().catch(() => []);
    const pool = [...playQueue, ...buildLocalQueue(localSongs)];
    const archivePlays = await loadArchivePlays().catch(() => []);
    const radioSongs = buildSeedRadioQueue({ seed, pool, archivePlays });
    if (radioSongs.length === 0) {
        setStatusMessage({ type: 'info', text: texts.empty, nonce: Date.now(), durationMs: 2000 });
        return false;
    }
    noteWholeQueueWrite();
    setPlayQueue([...playQueue, ...radioSongs]);
    setStatusMessage({ type: 'success', text: texts.added(radioSongs.length), nonce: Date.now(), durationMs: 2000 });
    return true;
};
