// src/services/jam/jamGateway.ts
// 播放网关：Jam 会话层与真实播放控制之间唯一的接口。
//
// Jam 不能自己去碰 audioRef / playSong —— 那些都活在播放桥的 hook 里。会话层
// （host 发事件、guest 应用事件）只调这份网关；真正接到播放器的注册发生在
// useAppPlaybackBridges（useJamBridge），那里才有 playSong / resumePlayback /
// pausePlayback / audioRef 这些能力。

import type { SongResult } from '../../types';
import type { JamSnapshot } from './jamProtocol';

export type JamGateway = {
    /** 播指定的歌并铺队列（切歌事件、快照对齐）。 */
    playSong: (song: SongResult, queue: SongResult[]) => void;
    resume: () => void;
    pause: () => void;
    /** 跳到指定位置（秒）。 */
    seek: (positionSeconds: number) => void;
    /** 只换队列不动当前歌（队列变化事件）。 */
    applyQueue: (queue: SongResult[]) => void;
    /** 读当前播放快照（房主差分、客机对齐检查共用）。 */
    snapshot: () => JamSnapshot | null;
};

let gateway: JamGateway | null = null;

export const setJamGateway = (next: JamGateway | null): void => {
    gateway = next;
};

export const getJamGateway = (): JamGateway | null => gateway;
