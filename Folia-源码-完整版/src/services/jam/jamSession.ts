// src/services/jam/jamSession.ts
// 「一起听」的会话层：把 jamClient（传输）与 jamGateway（播放控制）粘起来。
//
// 角色与方向：
//   host  — 读本地播放状态 → 差分出事件 → publish 给服务器。房主是唯一发布者。
//   guest — 轮询拉事件 → 经网关应用。客机**没有任何发布路径**（防回环的根本）：
//           客机加入后本地的播放控制不广播；客机手动切歌/暂停导致的偏差由
//           「自动回跳」收敛 —— 下一次对齐检查发现歌不对/进度漂移就拉回房主
//           状态并提示「跟随房主中」（见 maybeNoticeFollow）。
//
// 主机离房：服务端解散房间（jamCore.shouldDissolveRoom 的取舍），客机在下一轮
// 轮询看到 closed，UI 显示房间已解散。

import type { SongResult } from '../../types';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { planFullResync, resolveAlignSeek, type JamConnectionState, type JamPollResult } from './jamClient';
import { createJamTransport, isJamAvailable, type JamTransport } from './jamTransport';
import i18n from '../../i18n/config';
import { getJamGateway } from './jamGateway';
import { anchorFromSnapshot, estimatePosition, isFollowingSnapshot, planApplyEvents, queueFingerprint, type JamEvent, type JamSnapshot } from './jamProtocol';
import { useJamStore } from './jamStore';

/** 客机本地进度与房主的偏差超过这个秒数才回跳（容差 1 秒 + 一点网络余量）。 */
const DRIFT_RESYNC_SECONDS = 1.5;
/** 房主差分巡检周期。播放/暂停/切歌另有订阅即时补发，巡检兜底 seek 与队列。 */
const HOST_TICK_MS = 1000;
/** 快照最多隔这么多毫秒就随 publish 带一份（重连对齐靠它）。 */
const SNAPSHOT_MAX_AGE_MS = 10_000;
/** 「跟随房主中」提示的节流窗口。 */
const FOLLOW_NOTICE_MS = 5000;

let client: JamTransport | null = null;
let roomCode: string | null = null;
let role: 'host' | 'guest' | null = null;
let lastSeq = 0;
let applyingRemote = false;
let lastSnapshot: JamSnapshot | null = null;

// 房主侧差分记忆。
let lastSentSongKey: string | null = null;
let lastSentPlaying: boolean | null = null;
let lastSentQueueHash: string | null = null;
let lastSentPositionAt = 0;
let lastSentPosition = 0;
let lastSnapshotSentAt = 0;
let hostTimer: ReturnType<typeof setInterval> | null = null;
// 客机侧提示节流。
let lastFollowNoticeAt = 0;

const store = () => useJamStore.getState();

const setConnection = (state: JamConnectionState) => {
    store().setConnection(state);
};

/** 房主当前播放快照。网关没注册（还没进播放桥）时返回 null，差分循环跳过该轮。 */
const buildHostSnapshot = (): JamSnapshot | null => {
    const gateway = getJamGateway();
    if (!gateway) return null;
    return gateway.snapshot();
};

const publishNow = async (events: JamEvent[], forceSnapshot = false): Promise<void> => {
    if (!client || !roomCode || role !== 'host') return;
    const now = Date.now();
    const snapshot = buildHostSnapshot();
    const shouldSendSnapshot = Boolean(
        snapshot
        && (forceSnapshot || now - lastSnapshotSentAt >= SNAPSHOT_MAX_AGE_MS),
    ) ? snapshot ?? undefined : undefined;
    if (shouldSendSnapshot) lastSnapshotSentAt = now;
    try {
        await client.publish(roomCode, events, shouldSendSnapshot);
    } catch (error) {
        // 发布失败不打断差分循环：下一轮差分会把没发出去的变化再发一次。
        store().setError(error instanceof Error ? error.message : String(error));
    }
};

/** 房主差分巡检：把本地播放状态与上次已发送的差异变成事件。 */
const hostTick = (): void => {
    if (role !== 'host') return;
    const gateway = getJamGateway();
    if (!gateway) return;
    const snapshot = gateway.snapshot();
    if (!snapshot) return;
    const now = Date.now();
    const events: JamEvent[] = [];

    const songKey = snapshot.song ? getPlaybackSongKey(snapshot.song) : null;
    if (songKey !== lastSentSongKey) {
        // 切歌事件带上整条队列：客机一次拿到「这首歌 + 队列上下文」。
        events.push({ kind: 'song', ts: now, song: snapshot.song ?? undefined, queue: snapshot.queue });
        lastSentSongKey = songKey;
        lastSentQueueHash = queueFingerprint(snapshot.queue);
        lastSentPlaying = null; // 播放状态跟着新歌走，由下面的 diff 补一个 play/pause
        lastSentPositionAt = now;
        lastSentPosition = snapshot.position;
    } else {
        const queueHash = queueFingerprint(snapshot.queue);
        if (queueHash !== lastSentQueueHash) {
            events.push({ kind: 'queue', ts: now, queue: snapshot.queue });
            lastSentQueueHash = queueHash;
        }
    }

    if (snapshot.playing !== lastSentPlaying) {
        events.push({
            kind: snapshot.playing ? 'play' : 'pause',
            ts: now,
            position: snapshot.position,
        });
        lastSentPlaying = snapshot.playing;
        lastSentPositionAt = now;
        lastSentPosition = snapshot.position;
    } else if (snapshot.playing) {
        // seek 检测：外推位置与真实位置差超过 0.8s 视为拖动（容差小一点，seek 要准）。
        const projected = estimatePosition({ position: lastSentPosition, ts: lastSentPositionAt, playing: true }, now);
        if (Math.abs(projected - snapshot.position) > 0.8) {
            events.push({ kind: 'seek', ts: now, position: snapshot.position });
            lastSentPositionAt = now;
            lastSentPosition = snapshot.position;
        }
    }

    if (events.length) void publishNow(events);
};

/** 房主开始广播。 */
const startHost = (): void => {
    if (hostTimer) clearInterval(hostTimer);
    // 首轮把当前快照全量发出去（进房的人马上有东西可跟）。
    lastSentSongKey = null;
    lastSentPlaying = null;
    lastSentQueueHash = null;
    lastSnapshotSentAt = 0;
    hostTimer = setInterval(hostTick, HOST_TICK_MS);
    hostTick();
};

const stopHost = (): void => {
    if (hostTimer) clearInterval(hostTimer);
    hostTimer = null;
};

/** 「跟随房主中」提示：节流后写状态条。 */
const maybeNoticeFollow = (): void => {
    const now = Date.now();
    if (now - lastFollowNoticeAt < FOLLOW_NOTICE_MS) return;
    lastFollowNoticeAt = now;
    store().markFollowNotice();
    // 动态取状态条：它是全局能力，直接写即可。
    void import('../../stores/useStatusMessageStore').then(({ setStatusMessage }) => {
        setStatusMessage({ type: 'info', text: i18n.t('jam.followingHost') });
    }).catch(() => undefined);
};

/** 客机应用一轮轮询结果。 */
const applyPollForGuest = (result: JamPollResult): void => {
    const gateway = getJamGateway();
    if (!gateway) return;
    lastSeq = Math.max(lastSeq, result.seq);
    store().setMemberCount(result.members.length);
    if (result.snapshot) lastSnapshot = result.snapshot;

    const now = Date.now();
    // 重连对齐：强制整体吃快照。
    const plan = result.forceSnapshot && result.snapshot
        ? planFullResync(result.snapshot, now)
        : planApplyEvents(result.events, result.snapshot, now);

    const hasWork = plan.snapshot !== null || plan.playSong !== null || plan.resume || plan.pause || plan.queue !== null || plan.seekTo !== null;
    if (!hasWork) {
        // 空闲轮询仍要做进度对齐检查（容差外自动回跳）。
        const localPosition = gateway.snapshot()?.position ?? 0;
        const alignTo = resolveAlignSeek(result.snapshot, localPosition, now, DRIFT_RESYNC_SECONDS);
        if (alignTo !== null) gateway.seek(alignTo);
        return;
    }

    applyingRemote = true; // 应用闸：客机没有发布路径，这道标记是防回环保险（见 jamProtocol.canPublish）
    try {
        if (plan.playSong) {
            gateway.playSong(plan.playSong, plan.queue ?? (result.snapshot?.queue ?? []));
            maybeNoticeFollow();
        } else if (plan.queue) {
            gateway.applyQueue(plan.queue);
        }
        if (plan.seekTo !== null && !plan.playSong) gateway.seek(plan.seekTo);
        if (plan.resume) gateway.resume();
        else if (plan.pause) gateway.pause();
        // 应用完再校一次进度：playSong 是异步起播，位置可能要补一次 seek。
        if (plan.playSong && plan.seekTo !== null) gateway.seek(plan.seekTo);
    } finally {
        applyingRemote = false;
    }
};

/** 房主处理轮询结果：只更新成员数与快照缓存，不应用任何事件。 */
const applyPollForHost = (result: JamPollResult): void => {
    lastSeq = Math.max(lastSeq, result.seq);
    store().setMemberCount(result.members.length);
    if (result.snapshot) lastSnapshot = result.snapshot;
};

const teardownClient = (): void => {
    client?.stop();
    client = null;
};

export const isJamSessionActive = (): boolean => role !== null;

export const isJamApplyingRemote = (): boolean => applyingRemote;

/** 创建房间（房主）。 */
export const createJamRoom = async (): Promise<void> => {
    if (!isJamAvailable()) {
        store().setError('jam_not_configured');
        return;
    }
    const transport = createJamTransport(handlePoll, setConnection);
    try {
        store().setError(null);
        setConnection('connecting');
        const created = await transport.createRoom();
        client = transport;
        roomCode = created.code;
        role = 'host';
        lastSeq = created.seq;
        store().setRole('host');
        store().setRoomCode(created.code);
        transport.start(created.code, 'host', created.seq);
        startHost();
    } catch (error) {
        transport.stop();
        store().setError(error instanceof Error ? error.message : String(error));
        setConnection('idle');
    }
};

/** 用短码加入房间（客机）。加入成功立即吃一次全量快照对齐。 */
export const joinJamRoom = async (code: string): Promise<boolean> => {
    if (!isJamAvailable()) {
        store().setError('jam_not_configured');
        return false;
    }
    const transport = createJamTransport(handlePoll, setConnection);
    try {
        store().setError(null);
        setConnection('connecting');
        const joined = await transport.joinRoom(code);
        client = transport;
        roomCode = code;
        role = 'guest';
        lastSeq = joined.seq;
        store().setRole('guest');
        store().setRoomCode(code);
        store().setMemberCount(joined.members.length);
        lastSnapshot = joined.snapshot;
        if (joined.snapshot) {
            // 加入即对齐：直接应用服务端全量快照。
            const gateway = getJamGateway();
            if (gateway) {
                const plan = planFullResync(joined.snapshot, Date.now());
                applyingRemote = true;
                try {
                    if (plan.playSong) gateway.playSong(plan.playSong, plan.queue ?? []);
                    if (plan.seekTo !== null) gateway.seek(plan.seekTo);
                    if (plan.resume) gateway.resume();
                    else if (plan.pause) gateway.pause();
                } finally {
                    applyingRemote = false;
                }
            }
        }
        transport.start(code, 'guest', joined.seq);
        return true;
    } catch (error) {
        transport.stop();
        const message = error instanceof Error ? error.message : String(error);
        store().setError(message === 'room_not_found' ? 'room_not_found' : message);
        setConnection('idle');
        return false;
    }
};

/** 退出（房主退出即解散房间 —— 服务端处理，见 jamCore 注释）。 */
export const leaveJamRoom = async (): Promise<void> => {
    stopHost();
    const code = roomCode;
    const transport = client;
    roomCode = null;
    role = null;
    lastSnapshot = null;
    lastSeq = 0;
    applyingRemote = false;
    store().setRole(null);
    store().setRoomCode(null);
    store().setMemberCount(0);
    setConnection('idle');
    if (transport && code) await transport.leaveRoom(code);
    teardownClient();
};

const handlePoll = (result: JamPollResult): void => {
    if (result.closed) {
        // 房主离房（服务端解散）或房间失效：清理本地会话，UI 显示已结束。
        stopHost();
        roomCode = null;
        role = null;
        lastSnapshot = null;
        teardownClient();
        store().setRole(null);
        store().setRoomCode(null);
        store().setMemberCount(0);
        setConnection('closed');
        return;
    }
    if (role === 'host') applyPollForHost(result);
    else if (role === 'guest') applyPollForGuest(result);
};

export const getJamRoomCode = (): string | null => roomCode;
export const getJamRole = (): 'host' | 'guest' | null => role;
export const getJamLastSnapshot = (): JamSnapshot | null => lastSnapshot;
