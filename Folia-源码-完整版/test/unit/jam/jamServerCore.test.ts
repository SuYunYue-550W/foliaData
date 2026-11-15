import { describe, expect, it } from 'vitest';
import {
    filterEventsSince,
    generateRoomCode,
    isValidRoomCode,
    pruneCutoffs,
    shouldDissolveRoom,
    MEMBER_STALE_MS,
    ROOM_IDLE_MS,
} from '../../../sync-server/src/jamCore';

// 服务端房间转发的纯逻辑（sync-server/src/jamCore.ts）：
// 短码、事件过滤、房主离房解散、清理周期。路由层（jam.ts）只是把这些决定落库。

describe('jamCore 短码', () => {
    it('生成 6 位、字符集内、无易混字符', () => {
        for (let i = 0; i < 200; i += 1) {
            expect(isValidRoomCode(generateRoomCode())).toBe(true);
        }
    });

    it('拒绝 0/O/1/I 与错位短码', () => {
        expect(isValidRoomCode('ABC10O')).toBe(false);
        expect(isValidRoomCode('ABC23')).toBe(false);
        expect(isValidRoomCode('ABC2345')).toBe(false);
        expect(isValidRoomCode('abc234')).toBe(false);
        expect(isValidRoomCode(123456)).toBe(false);
        expect(isValidRoomCode('ABC234')).toBe(true);
    });
});

describe('jamCore 事件流', () => {
    it('filterEventsSince 只返回 seq 大于 since 的事件（增量拉取）', () => {
        const events = [{ seq: 1 }, { seq: 2 }, { seq: 5 }];
        expect(filterEventsSince(events, 1)).toEqual([{ seq: 2 }, { seq: 5 }]);
        expect(filterEventsSince(events, 5)).toEqual([]);
        expect(filterEventsSince(events, 0)).toHaveLength(3);
    });
});

describe('jamCore 房主离房处理', () => {
    it('房主离开 → 解散（简单可靠：短码房间无房主即无意义，转交需要选举/信任模型）', () => {
        expect(shouldDissolveRoom('host-1', 'host-1')).toBe(true);
    });

    it('成员离开 → 只删成员行，房间保留', () => {
        expect(shouldDissolveRoom('guest-9', 'host-1')).toBe(false);
    });
});

describe('jamCore 清理周期', () => {
    it('成员心跳超过 30s 判掉线，房间闲置 2h 回收', () => {
        const now = 1_000_000;
        const cutoffs = pruneCutoffs(now);
        expect(cutoffs.memberCutoff).toBe(now - MEMBER_STALE_MS);
        expect(cutoffs.roomCutoff).toBe(now - ROOM_IDLE_MS);
        expect(MEMBER_STALE_MS).toBe(30_000);
        expect(ROOM_IDLE_MS).toBe(2 * 60 * 60 * 1000);
    });
});
