// 免部署房间状态机的端到端联动：两个 RelayJamTransport 通过内存汇合点通信，
// 验证「房主建房 → 客机加入拿到快照 → 房主发事件 → 客机应用 → 房主退出解散」。
// 不连真实网络，但走的是与线上完全相同的加密帧与角色判定路径。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayJamTransport, type JamChannel } from '../../../src/services/jam/jamRelayTransport';
import type { JamPollResult } from '../../../src/services/jam/jamClient';
import type { JamSnapshot } from '../../../src/services/jam/jamProtocol';

/** 一个进程内的汇合点：所有订阅同频道的 channel 互相转发 payload。 */
class InMemoryHub {
    private listeners = new Map<string, Set<(payload: string) => void>>();
    private closed = new Set<JamChannel>();

    channel(onClosedCheck: () => boolean): JamChannel {
        const subscribed: Array<{ name: string; fn: (payload: string) => void }> = [];
        const self: JamChannel = {
            connect: async (name, fn) => { subscribed.push({ name, fn }); this.listeners.set(name, (this.listeners.get(name) ?? new Set()).add(fn)); },
            publish: (name, payload) => {
                // 真实 broker 在收到 PUBLISH 的瞬间就决定了投递目标；发送方随后
                // 断开不会撤回已发出的帧。这里在发布时快照听众列表。
                const targets = [...(this.listeners.get(name) ?? [])];
                setTimeout(() => {
                    if (onClosedCheck()) return;
                    for (const listener of targets) listener(payload);
                }, 0);
            },
            close: () => {
                this.closed.add(self);
                for (const { name, fn } of subscribed) this.listeners.get(name)?.delete(fn);
            },
            isOpen: true,
        };
        return self;
    }
}

const snapshot = (position: number): JamSnapshot => ({
    song: null, playing: true, position, queue: [], ts: Date.now(),
});

const flush = () => new Promise(resolve => setTimeout(resolve, 20));

describe('relay room end-to-end', () => {
    beforeEach(() => { vi.unstubAllGlobals(); });

    it('host create → guest join → publish → guest applies → host leave dissolves', async () => {
        vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => undefined } });
        const hub = new InMemoryHub();
        const hostPolls: JamPollResult[] = [];
        const guestPolls: JamPollResult[] = [];
        const host = new RelayJamTransport({
            onPoll: r => hostPolls.push(r), onStateChange: () => undefined,
            channel: hub.channel(() => false), clientId: 'host-aaa',
        });
        const created = await host.createRoom();
        expect(created.code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
        await host.publish(created.code, [], snapshot(10));
        host.start(created.code, 'host', 0);

        const guest = new RelayJamTransport({
            onPoll: r => guestPolls.push(r), onStateChange: () => undefined,
            channel: hub.channel(() => false), clientId: 'guest-bbb',
        });
        const joined = await guest.joinRoom(created.code);
        expect(joined.snapshot).not.toBeNull();
        await flush();

        // 房主发一个 play 事件，客机应收到并带上学到的房主身份。
        await host.publish(created.code, [{ kind: 'play', ts: Date.now(), position: 12 }], snapshot(12));
        await flush();
        const withEvent = guestPolls.find(r => r.events.some(e => e.kind === 'play'));
        expect(withEvent).toBeDefined();
        expect(withEvent?.snapshot?.position).toBe(12);

        await host.leaveRoom(created.code);
        await flush();
        expect(guestPolls.some(r => r.closed)).toBe(true);

        guest.stop();
        vi.unstubAllGlobals();
    });

    it('a guest with the wrong room code never receives host frames', async () => {
        vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => undefined } });
        const hub = new InMemoryHub();
        const host = new RelayJamTransport({ onPoll: () => undefined, onStateChange: () => undefined, channel: hub.channel(() => false), clientId: 'host-ccc' });
        const created = await host.createRoom();
        host.start(created.code, 'host', 0);
        await host.publish(created.code, [], snapshot(1));

        const guestPolls: JamPollResult[] = [];
        const wrongCode = created.code === 'ZZZZZZ' ? 'YYYYYY' : 'ZZZZZZ';
        const guest = new RelayJamTransport({ onPoll: r => guestPolls.push(r), onStateChange: () => undefined, channel: hub.channel(() => false), clientId: 'guest-ddd' });
        await guest.joinRoom(wrongCode).catch(() => undefined);
        await flush();
        expect(guestPolls.filter(r => r.snapshot !== null)).toHaveLength(0);
        guest.stop();
        host.stop();
        vi.unstubAllGlobals();
    });

    it('rejects an invalid short code', async () => {
        vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => undefined } });
        const transport = new RelayJamTransport({ onPoll: () => undefined, onStateChange: () => undefined, channel: new InMemoryHub().channel(() => false) });
        await expect(transport.joinRoom('abc')).rejects.toThrow('room_not_found');
        vi.unstubAllGlobals();
    });
});
