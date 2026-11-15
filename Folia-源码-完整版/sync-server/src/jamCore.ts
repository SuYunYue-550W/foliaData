/*
 * Jam 房间（一起听）的纯逻辑层：不含 Hono、不含数据库，可以在单测里直接跑。
 *
 * 为什么是 DB 中转 + 客户端轮询而不是 WS 房间：
 *   这个服务端有两种部署形态 —— Cloudflare Workers（隔离实例、没有跨请求内存、
 *   WS 要 Durable Objects 才能跨客户端广播）和 Node 多进程 cluster（每个 worker
 *   一个进程，内存房间表会把同一房间的成员拆到不同进程上）。两种形态下
 *   「进程内 WS 房间」都不可靠，唯一两边都成立的载体是数据库本身。
 *   于是房间状态（成员、事件流、最新快照）全部落库，客户端 1s 轮询拉增量，
 *   延迟可接受（一起听本来就是「误差 1 秒内可接受」的场景）。
 */

/** 成员多久没有心跳就算掉线。轮询周期 1~2s，30s 足够宽容。 */
export const MEMBER_STALE_MS = 30_000;
/** 事件流只留最近这么多条：新加入/重连靠快照对齐，事件只是增量。 */
export const MAX_EVENTS_PER_ROOM = 200;
/** 房间没有活动多久后整体清掉。 */
export const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;
/** 短码长度与字符集（去掉易混的 0/O/1/I）。 */
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** 6 位短码是否合法（客户端输入与服务端入参共用一份判断）。 */
export const isValidRoomCode = (value: unknown): value is string => (
    typeof value === 'string'
    && value.length === ROOM_CODE_LENGTH
    && /^[2-9A-HJKMNP-Z]+$/.test(value)
);

/** 从字符集里随机取 n 位组成短码。 */
export const generateRoomCode = (random: (bound: number) => number = Math.random): string => {
    let code = '';
    for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
        code += ROOM_CODE_ALPHABET[Math.floor(random(ROOM_CODE_ALPHABET.length))];
    }
    return code;
};

export type JamEventKind = 'play' | 'pause' | 'seek' | 'song' | 'queue' | 'snapshot';

export type JamEvent = {
    kind: JamEventKind;
    /** 房主发出事件时的墙钟（毫秒）。进度推算用 ts + position。 */
    ts: number;
    /** seek / play / pause / snapshot 附带的位置（秒）。 */
    position?: number;
    /** song / queue / snapshot 附带的载荷。 */
    song?: unknown;
    queue?: unknown[];
};

export type JamSnapshot = {
    song?: unknown;
    playing?: boolean;
    position?: number;
    queue?: unknown[];
    /** 快照对应的墙钟（毫秒）。 */
    ts: number;
};

/**
 * 进度推算：事件时间戳 + 位置，不做时钟同步。
 *
 * 在播就从 ts 推到现在；暂停就停在 position。误差来自单程延迟（一般 <1s），
 * 满足「误差 1 秒内可接受」。
 */
export const estimatePosition = (
    anchor: { position: number; ts: number; playing: boolean },
    now: number,
): number => (
    anchor.playing
        ? anchor.position + Math.max(0, now - anchor.ts) / 1000
        : anchor.position
);

/** 客机本地进度与房主推算进度的偏差是否大到需要对齐。 */
export const shouldResync = (
    anchor: { position: number; ts: number; playing: boolean },
    localPosition: number,
    now: number,
    toleranceSeconds = 1,
): boolean => (
    Math.abs(estimatePosition(anchor, now) - localPosition) > toleranceSeconds
);

/** 只留下 seq 大于 since 的事件（服务端按 seq 单调追加）。 */
export const filterEventsSince = <T extends { seq: number }>(events: T[], since: number): T[] => (
    events.filter(event => event.seq > since)
);

/**
 * 房主离开（或房主心跳超时被清）后房间如何处理：**解散**。
 *
 * 两个候选里选了解散 —— 转交需要成员选举与信任模型（把房主的播放权交给谁、
 * 旧房主回来算谁），短码房间本来就是「房主开、大家跟」，房主一走房间就没有
 * 意义；解散 + 客机收到 closed 提示是最简单也最不会出脑裂的行为。
 */
export const shouldDissolveRoom = (leavingClientId: string, hostId: string): boolean => (
    leavingClientId === hostId
);

/** 给一轮 publish 之后的清理定参数：过事件、过成员、过房间。 */
export const pruneCutoffs = (now: number) => ({
    memberCutoff: now - MEMBER_STALE_MS,
    eventCutoff: now - ROOM_IDLE_MS,
    roomCutoff: now - ROOM_IDLE_MS,
});
