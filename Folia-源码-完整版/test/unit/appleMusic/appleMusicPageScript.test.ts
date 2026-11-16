// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appleMusicPageHandleRequest } from '@/services/onlineMusic/appleMusic/pageScript';

// test/unit/appleMusic/appleMusicPageScript.test.ts
// 页面运行时是「一段要被整个带进 music.apple.com 的自包含函数」：这里既测它的行为
// （拿一个假的 MusicKit 问话），也测它的硬性约束 —— toString() 之后拿 new Function 重建，
// 在一个只有 window 的环境里照样能跑（import/闭包任何一处泄漏都会当场暴露）。

const digestHex = async (text: string): Promise<string> => {
    const bytes = new TextEncoder().encode(text);
    const numbers = Array.from(bytes, byte => byte % 251);
    return numbers.map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const apiAnswer = (status: number, body: unknown) => ({ status, data: body });

const musicKitOf = (extra: Record<string, unknown> = {}) => {
    const mk: Record<string, unknown> = {
        isAuthorized: true,
        storefrontId: 'us',
        storefrontCountryCode: 'us',
        nowPlayingItem: null,
        queue: null,
        isPlaying: false,
        previewOnly: false,
        playbackState: 0,
        repeatMode: 0,
        currentPlaybackTime: 0,
        musicUserToken: 'opaque-user-token',
        getInstance: () => mk,
        ...extra,
    };
    return mk;
};

const withMusicKit = (mk: Record<string, unknown>) => {
    (window as unknown as Record<string, unknown>).MusicKit = { getInstance: () => mk };
};

const call = vi.fn(async (path: string, query: Record<string, unknown>) => apiAnswer(200, { path, query }));

describe('the Apple Music page runtime', () => {
    beforeEach(() => {
        call.mockClear();
        for (const name of Object.getOwnPropertyNames(window)) {
            if (name.startsWith('__folia')) delete (window as unknown as Record<string, unknown>)[name];
        }
        // jsdom 的 window.crypto 只有 getter：用 defineProperty 覆盖成一个可控制的桩。
        Object.defineProperty(window, 'crypto', {
            configurable: true,
            value: { subtle: { digest: async (_scheme: string, bytes: Uint8Array) => {
                const numbers = Array.from(new Uint8Array(bytes));
                return new Uint8Array(numbers.map(byte => (byte * 7) % 251));
            } } },
        });
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        delete (window as unknown as Record<string, unknown>).MusicKit;
        delete (window as unknown as Record<string, unknown>).crypto;
    });
    it('answers not-ready when the page has no MusicKit yet', async () => {
        delete (window as unknown as Record<string, unknown>).MusicKit;
        const answer = await appleMusicPageHandleRequest({ operation: 'search', params: { query: 'x', limit: 5, offset: 0 } });
        expect(answer).toEqual({ ok: false, error: 'not-ready' });
    });

    it('reads the signed-in account as a stable hash with its nickname, never the token', async () => {
        const mk = musicKitOf();
        mk.api = { music: call };
        call.mockResolvedValueOnce(apiAnswer(200, { data: [{ id: 'us' }] }))
            .mockResolvedValueOnce(apiAnswer(200, { data: [{ id: 'profile-1', attributes: { name: 'Listener', artwork: { url: 'https://example.apple.com/a.jpg' } } }] }));
        withMusicKit(mk);
        const answer = await appleMusicPageHandleRequest({ operation: 'accountStatus', params: {} });
        expect(answer.ok).toBe(true);
        const data = (answer as { data: { id: string; nickname: string; storefront: string; avatarUrl: string } }).data;
        expect(data.nickname).toBe('Listener');
        expect(data.storefront).toBe('us');
        expect(data.avatarUrl).toBe('https://example.apple.com/a.jpg');
        // 身份是摘要，不是原始档案 id：泄漏面与桌面版一致。
        expect(data.id).not.toBe('profile-1');
        expect(JSON.stringify(data)).not.toContain('opaque-user-token');
    });

    it('maps a search page into the trimmed wire shape', async () => {
        const mk = musicKitOf();
        mk.api = { music: call };
        call.mockResolvedValueOnce(apiAnswer(200, { data: [{ id: 'us' }] }))
            .mockResolvedValueOnce(apiAnswer(200, { results: { songs: {
                data: [{ id: '144001', type: 'songs', attributes: {
                    name: 'Example', artistName: 'Artist', albumName: 'Album', durationInMillis: 1000,
                    isrc: 'ISRC-1', artwork: { url: 'https://example.apple.com/c.jpg' },
                    playParams: { id: '144001', kind: 'song', catalogId: '144001' },
                }, relationships: {} }],
                next: 'https://api.music.apple.com/v1/catalog/us/search?offset=1',
            } } }));
        withMusicKit(mk);
        const answer = await appleMusicPageHandleRequest({ operation: 'search', params: { query: 'example', limit: 25, offset: 0 } });
        expect(answer.ok).toBe(true);
        const data = (answer as { data: { items: Array<Record<string, unknown>>; hasMore: boolean; nextOffset: number } }).data;
        expect(data.items).toHaveLength(1);
        expect(data.items[0]).toEqual({
            id: '144001', type: 'songs',
            attributes: expect.objectContaining({
                playbackAvailable: true,
                name: 'Example', artistName: 'Artist', albumName: 'Album',
                durationInMillis: 1000, trackCount: null,
                artwork: { url: 'https://example.apple.com/c.jpg' }, isrc: 'ISRC-1',
                playParams: { id: '144001', kind: 'song', catalogId: '144001', isLibrary: false },
            }),
        });
        expect(data.hasMore).toBe(true);
        expect(data.nextOffset).toBe(1);
    });

    it('refuses a start while the storefront cannot be read, with the page words only', async () => {
        const mk = musicKitOf();
        mk.api = { music: call };
        call.mockResolvedValueOnce(apiAnswer(403, { errors: [{}] }));
        withMusicKit(mk);
        const answer = await appleMusicPageHandleRequest({ operation: 'accountStatus', params: {} });
        expect(answer).toEqual({ ok: false, error: 'auth-required' });
    });

    it('keeps its source self-contained: the stringified function rebuilds and runs with only a window', async () => {
        // 安卓侧靠 toString() 把这段带进原生 WebView；这里把序列化产物在只有 window 的
        // 空环境里重建一次，任何模块作用域泄漏都会以 ReferenceError 当场暴露。
        const source = appleMusicPageHandleRequest.toString();
        expect(source).not.toMatch(/^import\b/);
        expect(source).not.toContain('require(');
        const rebuilt = new Function(`"use strict"; return (${source});`)() as typeof appleMusicPageHandleRequest;
        delete (window as unknown as Record<string, unknown>).MusicKit;
        const answer = await rebuilt({ operation: 'accountStatus', params: {} });
        expect(answer).toEqual({ ok: false, error: 'not-ready' });
    });
});
