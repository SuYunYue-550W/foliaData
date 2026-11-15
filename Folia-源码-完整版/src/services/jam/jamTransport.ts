// src/services/jam/jamTransport.ts
// 「一起听」传输层统一入口。会话层（jamSession）只认 JamTransport 接口，
// 具体走公共中继 / 局域网直连 / 自建 sync-server 由这里按端点配置决定。
//
// 这样改的好处：原有 HTTP 路径（JamRoomClient）一行没动，免部署能力是并列的新实现，
// 自建服务器的用户完全不受影响；会话层的差分/对齐/防回环逻辑也原样复用。

import { JamRoomClient, isSyncJamConfigured, type JamConnectionState, type JamPollResult } from './jamClient';
import { getJamEndpointConfig, normalizeLanUrl } from './jamEndpoint';
import { RelayJamTransport, hasJamLanHostBridge } from './jamRelayTransport';
import type { JamEvent, JamMember, JamSnapshot } from './jamProtocol';

export type JamTransport = {
    createRoom(): Promise<{ code: string; seq: number }>;
    joinRoom(code: string): Promise<{ seq: number; snapshot: JamSnapshot | null; members: JamMember[] }>;
    leaveRoom(code: string): Promise<void>;
    publish(roomCode: string, events: JamEvent[], snapshot?: JamSnapshot): Promise<void>;
    start(roomCode: string, role: 'host' | 'guest', startSeq: number): void;
    stop(): void;
};

export type JamTransportFactory = (
    onPoll: (result: JamPollResult) => void,
    onStateChange: (state: JamConnectionState) => void,
) => JamTransport;

/**
 * 是否可用。public 零配置恒可用；lan 模式下桌面端能自动起服务（无需填地址），
 * 手机端则要填电脑地址；selfhost 沿用 sync 配置判定。
 */
export const isJamAvailable = (): boolean => {
    const config = getJamEndpointConfig();
    if (config.mode === 'public') return true;
    if (config.mode === 'lan') return hasJamLanHostBridge() || Boolean(normalizeLanUrl(config.lanUrl));
    // selfhost：与 jamClient 原逻辑一致，交给 HTTP 客户端自己的地址/令牌校验。
    return isSyncJamConfigured();
};

/** 传给会话层的工厂：按当前端点选择实现。 */
export const createJamTransport: JamTransportFactory = (onPoll, onStateChange) => {
    const config = getJamEndpointConfig();
    if (config.mode === 'selfhost') return new JamRoomClient(onPoll, onStateChange);
    return new RelayJamTransport({ onPoll, onStateChange });
};
