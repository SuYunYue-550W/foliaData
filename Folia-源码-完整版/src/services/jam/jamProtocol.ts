// src/services/jam/jamProtocol.ts
// 「一起听」房间的协议核心：事件类型、编解码校验、进度推算、重连对齐判断。
//
// 全部纯函数、不碰网络和 store，单测直接覆盖（见 test/unit/jam/jamProtocol.test.ts）。
//
// 协议要点（与 sync-server/src/jamCore.ts 同一份语义）：
//   - 房主是唯一发布者：play / pause / seek / 切歌 / 队列变化都是房主产生的事件，
//     客机只应用、从不发布 —— 这是防回环的根本（客机没有任何 publish 路径）。
//   - 进度 = 事件时间戳 + 位置推算，不做时钟同步，误差 1 秒内可接受。
//   - 重连对齐不靠补事件：服务端每次轮询响应都带最新全量快照，发现失配就整体应用。

import type { SongResult } from '../../types';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';

export type JamEventKind = 'play' | 'pause' | 'seek' | 'song' | 'queue' | 'snapshot';

export type JamEvent = {
    kind: JamEventKind;
    /** 房主发出事件时的墙钟（毫秒）。 */
    ts: number;
    /** play / pause / seek / snapshot 携带的位置（秒）。 */
    position?: number;
    song?: SongResult;
    queue?: SongResult[];
};

/** 服务端事件行：协议事件 + 服务端分配的单调 seq。 */
export type JamServerEvent = JamEvent & { seq: number };

export type JamSnapshot = {
    song: SongResult | null;
    playing: boolean;
    /** 快照锚点的播放位置（秒）。 */
    position: number;
    queue: SongResult[];
    ts: number;
};

export type JamMember = { clientId: string; name: string };

/** 进度锚点：推算播放位置用的最小三元组。 */
export type JamPositionAnchor = { position: number; ts: number; playing: boolean };

/**
 * 进度推算：从锚点（事件时间戳 + 位置）外推到 now。
 * 在播线性外推；暂停冻结在 position。延迟造成的误差一般在 1 秒内。
 */
export const estimatePosition = (anchor: JamPositionAnchor, now: number): number => (
    anchor.playing
        ? anchor.position + Math.max(0, now - anchor.ts) / 1000
        : anchor.position
);

/** 客机本地进度与房主推算进度的偏差是否超出容差（默认 1 秒）。 */
export const shouldResync = (
    anchor: JamPositionAnchor,
    localPosition: number,
    now: number,
    toleranceSeconds = 1,
): boolean => (
    Math.abs(estimatePosition(anchor, now) - localPosition) > toleranceSeconds
);

/** 用快照构造进度锚点。 */
export const anchorFromSnapshot = (snapshot: JamSnapshot): JamPositionAnchor => (
    { position: snapshot.position, ts: snapshot.ts, playing: snapshot.playing }
);

/**
 * 一轮增量事件该怎么应用：
 *   - song 事件优先级最高（后面的事件都基于新歌）；
 *   - seek / play / pause 依次落到当前歌上；
 *   - snapshot 事件（或需要整体对齐时）直接整体应用。
 * 返回一个「应用计划」，由会话层执行，便于单测覆盖决策逻辑。
 */
export type JamApplyPlan = {
    /** 要整体应用的快照（重连对齐 / snapshot 事件）。 */
    snapshot: JamSnapshot | null;
    /** 要播的歌（song 事件或 snapshot 里的歌）。 */
    playSong: SongResult | null;
    /** 播这首歌时一并铺的队列。 */
    queue: SongResult[] | null;
    /** 应用完之后要不要落在播放状态（play 事件 / snapshot.playing）。 */
    resume: boolean;
    pause: boolean;
    /** 最终应落到的位置（秒）；null 表示不动进度条。 */
    seekTo: number | null;
};

export const planApplyEvents = (
    events: JamServerEvent[],
    snapshot: JamSnapshot | null,
    now: number,
): JamApplyPlan => {
    const plan: JamApplyPlan = { snapshot: null, playSong: null, queue: null, resume: false, pause: false, seekTo: null };
    let hasSong = false;
    for (const event of events) {
        switch (event.kind) {
            case 'song':
                if (event.song) {
                    plan.playSong = event.song;
                    plan.queue = event.queue ?? null;
                    hasSong = true;
                    plan.resume = true;
                    plan.seekTo = 0;
                }
                break;
            case 'play':
                plan.resume = true;
                plan.pause = false;
                if (typeof event.position === 'number') plan.seekTo = event.position;
                break;
            case 'pause':
                plan.pause = true;
                plan.resume = false;
                break;
            case 'seek':
                if (typeof event.position === 'number') plan.seekTo = event.position;
                break;
            case 'queue':
                if (Array.isArray(event.queue)) plan.queue = event.queue;
                break;
            case 'snapshot':
                // snapshot 事件等价于「应用服务端快照」，统一走末尾的 snapshot 路径。
                if (snapshot) plan.snapshot = snapshot;
                break;
            default:
                break;
        }
    }
    // 有明确的 snapshot 事件（或调用方整体重对齐）时才以快照为准：
    // 服务端每次轮询都带快照，若无条件采用会每秒把客机重播一遍。
    if (snapshot && plan.snapshot) {
        plan.snapshot = snapshot;
        if (snapshot.song) {
            plan.playSong = snapshot.song;
            plan.queue = snapshot.queue;
            hasSong = true;
        }
        plan.resume = snapshot.playing;
        plan.pause = !snapshot.playing;
        plan.seekTo = estimatePosition(anchorFromSnapshot(snapshot), now);
    }
    // 有 song 事件但没有快照时，歌与队列以事件为准，位置从 0 开始由 play/seek 修正。
    if (hasSong && plan.seekTo === null) plan.seekTo = 0;
    return plan;
};

/** 客机手动改了本地状态之后，与房主快照是否已经「跟丢了」（歌不同即为丢）。 */
export const isFollowingSnapshot = (snapshot: JamSnapshot | null, localSong: SongResult | null): boolean => {
    if (!snapshot) return true;
    if (!snapshot.song || !localSong) return !snapshot.song && !localSong;
    return getPlaybackSongKey(snapshot.song) === getPlaybackSongKey(localSong);
};

/** 队列指纹：队列变化检测用，不追求内容级，只要变化可见。 */
export const queueFingerprint = (queue: SongResult[]): string => (
    queue.map(song => getPlaybackSongKey(song)).join('|')
);

/*
 * 防回环的两道闸（会话层执行，这里给出纯判断）：
 *   1. 角色闸：只有 host 才允许发布（见 jamClient.publish 的守卫）。
 *   2. 应用闸：客机应用房主事件期间置 applyingRemote，客机自己的状态变化
 *      （由应用触发的 play/pause/切歌）一律不再进入发布路径 —— 客机本来也没有
 *      发布路径，这道闸是给「未来若加入双向能力」时的回环保险。
 */
export const canPublish = (role: 'host' | 'guest' | null, applyingRemote: boolean): boolean => (
    role === 'host' && !applyingRemote
);
