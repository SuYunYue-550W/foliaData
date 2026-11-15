// 端点配置：默认零配置、持久化容错、局域网地址规范化。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getJamEndpointConfig, saveJamEndpointConfig, normalizeLanUrl,
    describeJamEndpoint, PUBLIC_RELAY_URLS,
} from '../../../src/services/jam/jamEndpoint';

const memory = new Map<string, string>();
const fakeStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); },
    clear: () => memory.clear(),
};

beforeEach(() => {
    memory.clear();
    vi.stubGlobal('window', { localStorage: fakeStorage, dispatchEvent: () => undefined });
    vi.stubGlobal('Event', class { constructor(public type: string) {} });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('default endpoint', () => {
    it('defaults to public with no configuration at all', () => {
        expect(getJamEndpointConfig()).toEqual({ mode: 'public', lanUrl: '' });
    });

    it('falls back to public on corrupted stored data', () => {
        memory.set('folia_jam_endpoint_v1', '{not json');
        expect(getJamEndpointConfig().mode).toBe('public');
        memory.set('folia_jam_endpoint_v1', JSON.stringify({ mode: 'bogus', lanUrl: 42 }));
        expect(getJamEndpointConfig()).toEqual({ mode: 'public', lanUrl: '' });
    });

    it('public relay list has working WSS endpoints only', () => {
        expect(PUBLIC_RELAY_URLS.length).toBeGreaterThanOrEqual(2);
        for (const url of PUBLIC_RELAY_URLS) expect(url).toMatch(/^wss:\/\//);
    });
});

describe('persistence', () => {
    it('round-trips lan mode', () => {
        saveJamEndpointConfig({ mode: 'lan', lanUrl: 'ws://192.168.1.8:45331' });
        expect(getJamEndpointConfig()).toEqual({ mode: 'lan', lanUrl: 'ws://192.168.1.8:45331' });
    });

    it('round-trips selfhost mode', () => {
        saveJamEndpointConfig({ mode: 'selfhost', lanUrl: '' });
        expect(getJamEndpointConfig().mode).toBe('selfhost');
    });

    it('describeJamEndpoint reflects the mode', () => {
        expect(describeJamEndpoint({ mode: 'public', lanUrl: '' })).toBe('public relay');
        expect(describeJamEndpoint({ mode: 'lan', lanUrl: 'ws://192.168.1.8:1' })).toBe('ws://192.168.1.8:1');
        expect(describeJamEndpoint({ mode: 'selfhost', lanUrl: '' })).toBe('sync-server');
    });
});

describe('normalizeLanUrl', () => {
    it('adds ws:// when the scheme is missing', () => {
        expect(normalizeLanUrl('192.168.1.8:45331')).toBe('ws://192.168.1.8:45331');
    });
    it('converts http(s) to ws(s)', () => {
        expect(normalizeLanUrl('http://192.168.1.8:45331/')).toBe('ws://192.168.1.8:45331');
        expect(normalizeLanUrl('https://host.example/path')).toBe('wss://host.example/path');
    });
    it('keeps ws/wss as-is and strips trailing slashes', () => {
        expect(normalizeLanUrl('ws://192.168.1.8:45331/')).toBe('ws://192.168.1.8:45331');
        expect(normalizeLanUrl('wss://relay.example/')).toBe('wss://relay.example');
    });
    it('returns empty for blank input', () => {
        expect(normalizeLanUrl('   ')).toBe('');
    });
});
