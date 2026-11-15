import { describe, expect, it } from 'vitest';
import type { SongResult } from '../../../src/types';
import {
    anchorFromSnapshot,
    canPublish,
    estimatePosition,
    isFollowingSnapshot,
    planApplyEvents,
    queueFingerprint,
    shouldResync,
    type JamServerEvent,
    type JamSnapshot,
} from '../../../src/services/jam/jamProtocol';

const song = (mediaId: string): SongResult => ({
    id: mediaId,
    name: `song-${mediaId}`,
    artists: [],
    album: { id: 'album', name: 'album' },
    durationMs: 200_000,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId },
} as unknown as SongResult);

describe('jamProtocol 进度推算', () => {
    it('在播时从时间戳 + 位置线性外推', () => {
        const anchor = { position: 10, ts: 1_000, playing: true };
        expect(estimatePosition(anchor, 4_000)).toBeCloseTo(13, 5);
    });

    it('暂停时冻结在位置上', () => {
        const anchor = { position: 10, ts: 1_000, playing: false };
        expect(estimatePosition(anchor, 60_000)).toBe(10);
    });

    it('外推不会因为时钟轻微回拨变负', () => {
        const anchor = { position: 10, ts: 5_000, playing: true };
        expect(estimatePosition(anchor, 4_000)).toBe(10);
    });

    it('shouldResync 按容差判断', () => {
        const anchor = { position: 10, ts: 0, playing: true };
        expect(shouldResync(anchor, 11.5, 1_000, 1)).toBe(false); // 偏差 0.5s
        expect(shouldResync(anchor, 13, 1_000, 1)).toBe(true); // 偏差 2s
    });

    it('anchorFromSnapshot 保留播放状态', () => {
        const snapshot: JamSnapshot = { song: song('1'), playing: false, position: 7, queue: [], ts: 42 };
        expect(anchorFromSnapshot(snapshot)).toEqual({ position: 7, ts: 42, playing: false });
    });
});

describe('jamProtocol 事件应用计划', () => {
    it('song 事件计划播歌、清零进度并默认播放', () => {
        const now = Date.now();
        const events: JamServerEvent[] = [{ seq: 1, kind: 'song', ts: now, song: song('9'), queue: [song('9'), song('10')] }];
        const plan = planApplyEvents(events, null, now);
        expect(plan.playSong?.id).toBe('9');
        expect(plan.queue).toHaveLength(2);
        expect(plan.resume).toBe(true);
        expect(plan.seekTo).toBe(0);
        expect(plan.pause).toBe(false);
    });

    it('play / pause / seek 依次落在当前歌上', () => {
        const now = Date.now();
        const plan = planApplyEvents([
            { seq: 1, kind: 'seek', ts: now, position: 30 },
            { seq: 2, kind: 'pause', ts: now },
        ], null, now);
        expect(plan.pause).toBe(true);
        expect(plan.resume).toBe(false);
        expect(plan.seekTo).toBe(30);
        expect(plan.playSong).toBeNull();
    });

    it('queue 事件只换队列不动歌', () => {
        const now = Date.now();
        const plan = planApplyEvents([{ seq: 1, kind: 'queue', ts: now, queue: [song('2')] }], null, now);
        expect(plan.queue).toHaveLength(1);
        expect(plan.playSong).toBeNull();
        expect(plan.seekTo).toBeNull();
    });

    it('服务端快照只随 snapshot 事件整体应用（空闲轮询不重播）', () => {
        const now = Date.now();
        const snapshot: JamSnapshot = { song: song('5'), playing: true, position: 3, queue: [song('5')], ts: now };
        const idle = planApplyEvents([], snapshot, now);
        expect(idle.snapshot).toBeNull();
        expect(idle.playSong).toBeNull();

        const withEvent = planApplyEvents([{ seq: 2, kind: 'snapshot', ts: now }], snapshot, now + 2_000);
        expect(withEvent.snapshot).toBe(snapshot);
        expect(withEvent.playSong?.id).toBe('5');
        expect(withEvent.resume).toBe(true);
        expect(withEvent.seekTo).toBeCloseTo(5, 5); // 3s + 2s 外推
    });
});

describe('jamProtocol 重连对齐', () => {
    it('重连后强制快照的计划以服务端快照为准并外推到当前时刻', () => {
        const now = Date.now();
        const snapshot: JamSnapshot = { song: song('7'), playing: true, position: 100, queue: [], ts: now - 4_000 };
        const plan = planApplyEvents([], snapshot, now);
        expect(plan.snapshot).toBeNull(); // 空事件列表不带 snapshot 事件，不会误重播
        // 强制路径由会话层用 planFullResync（内部走 snapshot 通道），直接验证推算：
        expect(estimatePosition(anchorFromSnapshot(snapshot), now)).toBeCloseTo(104, 5);
    });
});

describe('jamProtocol 防回环', () => {
    it('只有房主且不在应用远端事件时才可发布', () => {
        expect(canPublish('host', false)).toBe(true);
        expect(canPublish('host', true)).toBe(false);
        expect(canPublish('guest', false)).toBe(false);
        expect(canPublish(null, false)).toBe(false);
    });
});

describe('jamProtocol 客机跟随判断', () => {
    const hostSnapshot: JamSnapshot = { song: song('1'), playing: true, position: 0, queue: [], ts: 0 };

    it('同一首歌算跟随', () => {
        expect(isFollowingSnapshot(hostSnapshot, song('1'))).toBe(true);
    });

    it('客机手动切歌后与房主不同即为跟丢', () => {
        expect(isFollowingSnapshot(hostSnapshot, song('2'))).toBe(false);
    });

    it('没有快照时视为跟随（不误报）', () => {
        expect(isFollowingSnapshot(null, song('1'))).toBe(true);
    });
});

describe('jamProtocol 队列指纹', () => {
    it('队列顺序与内容变化都反映在指纹上', () => {
        expect(queueFingerprint([song('1'), song('2')])).not.toBe(queueFingerprint([song('2'), song('1')]));
        expect(queueFingerprint([song('1')])).toBe(queueFingerprint([song('1')]));
    });
});
