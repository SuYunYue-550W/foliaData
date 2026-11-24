import { describe, expect, it, vi } from 'vitest';
import { cookieValue, createBilibiliApiBridge, safeRedirect } from '../../../electron/bilibili/bilibiliApiBridge.cjs';

// test/unit/electron/bilibiliApiBridge.test.ts
//
// B站登录态在主进程落地的关键行为：从 Set-Cookie 取 SESSDATA、加密落盘、
// 不跟随跨站重定向、不把凭据写进错误回包。

const headersOf = (cookies: string[]) => ({
    getSetCookie: () => cookies,
    get: (name: string) => (name.toLowerCase() === 'set-cookie' ? cookies.join(', ') : null),
});

const fakeSafeStorage = () => {
    const sealed = new Map<string, string>();
    return {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'kdewallet',
        encryptString: (text: string) => Buffer.from(`sealed:${text}`),
        decryptString: (buf: Buffer) => {
            const text = buf.toString('utf8');
            if (!text.startsWith('sealed:')) throw new Error('bad seal');
            return Buffer.from(text.slice(7));
        },
        _sealed: sealed,
    };
};

const makeStore = () => {
    const data = new Map<string, unknown>();
    return {
        get: (key: string) => data.get(key),
        set: (key: string, value: unknown) => { data.set(key, value); },
        delete: (key: string) => { data.delete(key); },
        _data: data,
    };
};

const pollResponse = (code: number, cookies: string[] = []) => ({
    status: 200,
    headers: headersOf(cookies),
    json: async () => ({ code, message: code === 0 ? 'OK' : 'waiting', url: 'https://bilibili.com' }),
});

describe('B站 API bridge', () => {
    it('parses SESSDATA from Set-Cookie (including the getSetCookie path)', () => {
        expect(cookieValue(headersOf(['SESSDATA=abc%2B123; Path=/; HttpOnly', 'buvid3=XYZ; Path=/']), 'SESSDATA')).toBe('abc+123');
        expect(cookieValue(headersOf(['SESSDATA=abc; Path=/']), 'buvid3')).toBeNull();
    });

    it('rejects redirects to non-bilibili hosts so credentials cannot leak', () => {
        expect(safeRedirect('https://passport.bilibili.com/x')).toBe(true);
        expect(safeRedirect('https://evil.example.com/steal')).toBe(false);
        expect(safeRedirect('http://api.bilibili.com/x')).toBe(false);
        expect(safeRedirect('not a url')).toBe(false);
    });

    it('stores SESSDATA encrypted on successful poll and reports it to the renderer', async () => {
        const store = makeStore();
        const safeStorage = fakeSafeStorage();
        const fetchImpl = vi.fn().mockResolvedValue(pollResponse(0, ['SESSDATA=s3cr3t; Path=/; HttpOnly', 'buvid3=BV; Path=/']));
        const bridge = createBilibiliApiBridge({ store, safeStorage, fetchImpl, warn: vi.fn() });

        const reply = await bridge.request('qr-poll', { qrcode_key: 'KEY' });
        expect(reply.ok).toBe(true);
        expect(reply.data).toMatchObject({ code: 0, sessdata: 's3cr3t', sessdataStored: true });

        // 落盘的是密文，不是明文。
        const persisted = String(store._data.get('BILIBILI_SESSION_V2'));
        expect(persisted).not.toContain('s3cr3t');
        // 存的是 encryptString(...).toString('base64')，解出来才是 sealed: 前缀。
        expect(Buffer.from(persisted, 'base64').toString('utf8').startsWith('sealed:')).toBe(true);

        const restored = await bridge.request('get-session');
        expect(restored.data).toMatchObject({ sessdata: 's3cr3t', buvid3: 'BV' });
    });

    it('does not persist a plaintext session when OS encryption is unavailable', async () => {
        const store = makeStore();
        const safeStorage = { ...fakeSafeStorage(), isEncryptionAvailable: () => false };
        const warn = vi.fn();
        const fetchImpl = vi.fn().mockResolvedValue(pollResponse(0, ['SESSDATA=s3cr3t; Path=/']));
        const bridge = createBilibiliApiBridge({ store, safeStorage, fetchImpl, warn });

        const reply = await bridge.request('qr-poll', { qrcode_key: 'KEY' });
        expect(reply.ok).toBe(true);
        // 本次会话内存里还有，但不落盘 —— 敏感凭据不能以明文持久化。
        expect(store._data.has('BILIBILI_SESSION_V2')).toBe(false);
        expect((await bridge.request('get-session')).data.sessdata).toBe('s3cr3t');
        expect(warn).toHaveBeenCalled();
    });

    it('clears the stored session on logout', async () => {
        const store = makeStore();
        const bridge = createBilibiliApiBridge({
            store, safeStorage: fakeSafeStorage(),
            fetchImpl: vi.fn().mockResolvedValue(pollResponse(0, ['SESSDATA=s3cr3t; Path=/'])),
            warn: vi.fn(),
        });
        await bridge.request('qr-poll', { qrcode_key: 'KEY' });
        expect(store._data.has('BILIBILI_SESSION_V2')).toBe(true);
        await bridge.request('logout');
        expect(store._data.has('BILIBILI_SESSION_V2')).toBe(false);
        expect((await bridge.request('get-session')).data).toBeNull();
    });

    it('keeps waiting/scanned codes as data, not errors', async () => {
        const bridge = createBilibiliApiBridge({
            store: makeStore(), safeStorage: fakeSafeStorage(),
            fetchImpl: vi.fn().mockResolvedValue(pollResponse(86101)),
            warn: vi.fn(),
        });
        const reply = await bridge.request('qr-poll', { qrcode_key: 'KEY' });
        expect(reply.ok).toBe(true);
        expect(reply.data.code).toBe(86101);
    });
});
