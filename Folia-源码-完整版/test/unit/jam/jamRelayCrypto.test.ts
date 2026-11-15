// 公共中继上的隔离与加密：频道名不含房间码、密文不可读、篡改/串房被丢弃。
import { describe, expect, it } from 'vitest';
import {
    deriveRoomChannel, sealRelayFrame, openRelayFrame, type JamRelayFrame,
} from '../../../src/services/jam/jamRelayCrypto';

const frame = (overrides: Partial<JamRelayFrame> = {}): JamRelayFrame => ({
    from: 'host-1', seq: 1, host: 'host-1', kind: 'state', ts: 1700000000000,
    events: [{ kind: 'play', ts: 1700000000000, position: 12.5 }],
    snapshot: { song: null, playing: true, position: 12.5, queue: [], ts: 1700000000000 },
    members: [{ clientId: 'host-1', name: 'host' }],
    ...overrides,
});

describe('room channel derivation', () => {
    it('never contains the room code and is deterministic', async () => {
        const channel = await deriveRoomChannel('ABC234');
        expect(channel).toMatch(/^folia\/jam\/v1\/[0-9a-f]{32}$/);
        expect(channel).not.toContain('ABC234');
        expect(await deriveRoomChannel('ABC234')).toBe(channel);
        expect(await deriveRoomChannel('ABC235')).not.toBe(channel);
    });

    it('normalizes case and surrounding whitespace', async () => {
        expect(await deriveRoomChannel(' abc234 ')).toBe(await deriveRoomChannel('ABC234'));
    });
});

describe('AES-GCM sealed frames', () => {
    it('round-trips a full state frame', async () => {
        const sealed = await sealRelayFrame('ABC234', frame());
        expect(sealed).not.toContain('host-1');
        expect(sealed).not.toContain('play');
        const opened = await openRelayFrame('ABC234', sealed);
        expect(opened).toEqual(frame());
    });

    it('produces a different ciphertext every time (random IV)', async () => {
        const a = await sealRelayFrame('ABC234', frame());
        const b = await sealRelayFrame('ABC234', frame());
        expect(a).not.toBe(b);
    });

    it('cannot be opened with a different room code', async () => {
        const sealed = await sealRelayFrame('ABC234', frame());
        expect(await openRelayFrame('ABC235', sealed)).toBeNull();
    });

    it('rejects tampered ciphertext', async () => {
        const sealed = await sealRelayFrame('ABC234', frame());
        const [iv, data] = sealed.split(':');
        const tampered = `${iv}:${data.slice(0, -4)}AAAA`;
        expect(await openRelayFrame('ABC234', tampered)).toBeNull();
    });

    it('rejects malformed payloads instead of throwing', async () => {
        for (const bad of ['', 'not-a-frame', 'a:b:c', 'aaaa', '%%%:%%%']) {
            expect(await openRelayFrame('ABC234', bad)).toBeNull();
        }
    });

    it('rejects a decodable but structurally invalid frame', async () => {
        // 用正确的密钥加密一个缺少字段的对象，验证结构校验而非仅靠认证。
        const { sealRelayFrame: seal } = await import('../../../src/services/jam/jamRelayCrypto');
        const sealed = await seal('ABC234', { hello: 'world' } as unknown as JamRelayFrame);
        expect(await openRelayFrame('ABC234', sealed)).toBeNull();
    });
});
