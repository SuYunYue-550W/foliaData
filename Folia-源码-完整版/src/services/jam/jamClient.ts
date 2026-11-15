// src/services/jam/jamClient.ts
// 「一起听」房间的传输层之一：对自建 sync-server /api/jam 的 HTTP 客户端 + 轮询循环。
//
// 复用「连接与集成」页里已配置的自建 sync server（getSyncConfig 的地址与 token）。
// 这是 selfhost 端点的实现；public / lan 两个免部署端点在 jamRelayTransport.ts。
// 端点选择与「是否可用」的统一判定见 jamTransport.ts（UI 请从那里取 isJamAvailable）。
//
// 断线重连策略：轮询失败进入 reconnecting 状态并持续重试；恢复后**不补事件**，
// 直接吃响应里的最新全量快照整体对齐（见 jamProtocol.planApplyEvents），这是
// 「请求一次全量状态对齐」要求的最可靠实现 —— 事件流有封顶裁剪，补事件不可靠。

import { getSyncConfig } from '../sync/syncConfig';
import {
    anchorFromSnapshot,
    estimatePosition,
    planApplyEvents,
    type JamApplyPlan,
    type JamEvent,
    type JamMember,
    type JamServerEvent,
    type JamSnapshot,
} from './jamProtocol';

export const JAM_POLL_MS = 1000;
export const JAM_HOST_POLL_MS = 2000;

export type JamConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export type JamPollResult = {
    closed: boolean;
    seq: number;
    events: JamServerEvent[];
    members: JamMember[];
    snapshot: JamSnapshot | null;
    /** 重连恢复后的第一轮：增量被丢弃，会话层应以快照整体对齐。 */
    forceSnapshot?: boolean;
};

const CLIENT_ID_KEY = 'folia_jam_client_id';

/** 本机在 Jam 房间里的稳定身份（不涉隐私，仅用于服务端去重/房主判定）。 */
export const getClientId = (): string => {
    if (typeof localStorage === 'undefined') return 'ssr';
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
        id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `c${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
};

const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, '');

/** 自建 sync server 是否已配置。只用于 selfhost 端点的可用性判定。 */
export const isSyncJamConfigured = (): boolean => {
    const config = getSyncConfig();
    return Boolean(config.enabled && normalizeBaseUrl(config.workerBaseUrl) && config.authToken);
};

export class JamRoomClient {
    private controller: AbortController | null = null;
    private stopped = true;

    constructor(
        /** 应用回调：每次轮询拿到增量就交给会话层（应用事件 / 刷成员数）。 */
        private readonly onPoll: (result: JamPollResult) => void,
        private readonly onStateChange: (state: JamConnectionState) => void,
    ) {}

    stop(): void {
        this.stopped = true;
        this.controller?.abort();
        this.controller = null;
    }

    /** 起轮询循环。room 必须是已经 create/join 成功的房间。 */
    start(roomCode: string, role: 'host' | 'guest', startSeq: number): void {
        this.stop();
        this.stopped = false;
        void this.loop(roomCode, role, startSeq);
    }

    private async loop(roomCode: string, role: 'host' | 'guest', startSeq: number): Promise<void> {
        let since = startSeq;
        let needsFullResync = false; // 断过线就置位，恢复后用快照整体对齐
        this.onStateChange('connecting');
        while (!this.stopped) {
            try {
                const result = await this.poll(roomCode, since);
                if (this.stopped) return;
                this.onStateChange('connected');
                if (result.closed) {
                    this.onStateChange('closed');
                    this.onPoll(result);
                    return;
                }
                if (needsFullResync) {
                    // 重连对齐：把增量丢弃、直接以服务端快照整体应用。
                    since = result.seq;
                    needsFullResync = false;
                    this.onPoll({ ...result, events: [], forceSnapshot: true });
                } else {
                    since = Math.max(since, result.seq);
                    this.onPoll(result);
                }
            } catch {
                if (this.stopped) return;
                this.onStateChange('reconnecting');
                needsFullResync = true;
            }
            await this.sleep(role === 'host' ? JAM_HOST_POLL_MS : JAM_POLL_MS);
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private async request(path: string, body: unknown): Promise<any> {
        const config = getSyncConfig();
        const base = normalizeBaseUrl(config.workerBaseUrl);
        if (!base || !config.authToken) throw new Error('jam_not_configured');
        this.controller = new AbortController();
        try {
            const response = await fetch(`${base}/api/jam${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.authToken}` },
                body: JSON.stringify(body),
                signal: this.controller.signal,
            });
            if (!response.ok) {
                const detail = await response.json().catch(() => null);
                throw new Error(detail?.error || `jam_http_${response.status}`);
            }
            return await response.json();
        } finally {
            this.controller = null;
        }
    }

    async createRoom(): Promise<{ code: string; seq: number }> {
        const data = await this.request('/rooms', { clientId: getClientId() });
        return { code: data.code, seq: data.seq ?? 0 };
    }

    async joinRoom(code: string): Promise<{ seq: number; snapshot: JamSnapshot | null; members: JamMember[] }> {
        const data = await this.request(`/rooms/${encodeURIComponent(code)}/join`, {
            clientId: getClientId(),
            name: 'guest',
        });
        return { seq: data.seq ?? 0, snapshot: data.snapshot ?? null, members: data.members ?? [] };
    }

    async leaveRoom(code: string): Promise<void> {
        try {
            await this.request(`/rooms/${encodeURIComponent(code)}/leave`, { clientId: getClientId() });
        } catch {
            // 离开失败不必提示：服务端的心跳清理最终会收回房间/成员。
        }
    }

    /** 房主发布事件与（可选）快照。非房主调用会被服务端 403 拒绝；客机在会话层根本没有发布路径（防回环）。 */
    async publish(roomCode: string, events: JamEvent[], snapshot?: JamSnapshot): Promise<void> {
        await this.request(`/rooms/${encodeURIComponent(roomCode)}/publish`, {
            clientId: getClientId(),
            events,
            snapshot,
        });
    }

    private async poll(roomCode: string, since: number): Promise<JamPollResult> {
        const data = await this.request(`/rooms/${encodeURIComponent(roomCode)}/events`, {
            clientId: getClientId(),
            since,
        });
        return {
            closed: data.closed === true,
            seq: typeof data.seq === 'number' ? data.seq : since,
            events: Array.isArray(data.events) ? data.events : [],
            members: Array.isArray(data.members) ? data.members : [],
            snapshot: data.snapshot ?? null,
        };
    }
}

/**
 * 客机进度对齐：给定房主快照与本地位置，算出应当落到的位置（秒）。
 * 返回 null 表示偏差在容差内、不必动。
 */
export const resolveAlignSeek = (
    snapshot: JamSnapshot | null,
    localPosition: number,
    now: number,
    toleranceSeconds = 1.5,
): number | null => {
    if (!snapshot || !snapshot.playing) return null;
    const expected = estimatePosition(anchorFromSnapshot(snapshot), now);
    return Math.abs(expected - localPosition) > toleranceSeconds ? expected : null;
};

/** 给会话层用的应用计划快捷入口（重连首拉 / 快照事件）。 */
export const planFullResync = (snapshot: JamSnapshot, now: number): JamApplyPlan => (
    planApplyEvents([], snapshot, now)
);
