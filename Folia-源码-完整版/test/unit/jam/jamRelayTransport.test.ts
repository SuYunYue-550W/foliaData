// 房间码与端点→实现的选择：不涉及真实网络，锁死「默认零部署可用」这个契约。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    generateRelayRoomCode, isValidRelayRoomCode, hasJamLanHostBridge,
} from '../../../src/services/jam/jamRelayTransport';
import { createJamTransport, isJamAvailable } from '../../../src/services/jam/jamTransport';
import { JamRoomClient } from '../../../src/services/jam/jamClient';
import { RelayJamTransport } from '../../../src/services/jam/jamRelayTransport';

const memory = new Map<string, string>();
const fakeWindow: Record<string, unknown> = {
    localStorage: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => { memory.set(key, value); },
    },
    dispatchEvent: () => undefined,
};

beforeEach(() => {
    memory.clear();
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('Event', class { constructor(public type: string) {} });
});
afterEach(() => { vi.unstubAllGlobals(); });

const setMode = (mode: string, lanUrl = '') => {
    memory.set('folia_jam_endpoint_v1', JSON.stringify({ mode, lanUrl }));
};

describe('relay room code', () => {
    it('generates 6 chars from the unambiguous alphabet', () => {
        for (let i = 0; i < 50; i += 1) {
            const code = generateRelayRoomCode();
            expect(code).toHaveLength(6);
            expect(code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
        }
    });

    it('is deterministic with an injected random source', () => {
        expect(generateRelayRoomCode(() => 0)).toBe('222222');
        expect(generateRelayRoomCode(() => 0.999999)).toBe('ZZZZZZ');
    });

    it('validates case-insensitively and rejects confusing characters', () => {
        expect(isValidRelayRoomCode('abc234')).toBe(true);
        expect(isValidRelayRoomCode(' ABC234 ')).toBe(true);
        expect(isValidRelayRoomCode('ABC23')).toBe(false);
        expect(isValidRelayRoomCode('ABC2345')).toBe(false);
        expect(isValidRelayRoomCode('0OO111')).toBe(false); // 0/O/1/I 不在字符集
    });
});

describe('endpoint → transport selection', () => {
    const noop = () => undefined;

    it('public mode (the default) is available with zero configuration', () => {
        setMode('public');
        expect(isJamAvailable()).toBe(true);
        expect(createJamTransport(noop, noop)).toBeInstanceOf(RelayJamTransport);
    });

    it('lan mode with a filled address is available', () => {
        setMode('lan', 'ws://192.168.1.8:45331');
        expect(isJamAvailable()).toBe(true);
        expect(createJamTransport(noop, noop)).toBeInstanceOf(RelayJamTransport);
    });

    it('lan mode on a phone without an address is unavailable', () => {
        setMode('lan', '');
        expect(hasJamLanHostBridge()).toBe(false);
        expect(isJamAvailable()).toBe(false);
    });

    it('lan mode on desktop is available even without an address (service auto-starts)', () => {
        setMode('lan', '');
        fakeWindow.electron = { jamLanStart: async () => ({ addresses: [], port: 45331 }) };
        expect(hasJamLanHostBridge()).toBe(true);
        expect(isJamAvailable()).toBe(true);
        delete fakeWindow.electron;
    });

    it('selfhost mode keeps the original HTTP client', () => {
        setMode('selfhost');
        expect(createJamTransport(noop, noop)).toBeInstanceOf(JamRoomClient);
    });
});
