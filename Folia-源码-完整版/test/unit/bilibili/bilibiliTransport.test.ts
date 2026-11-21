// test/unit/bilibili/bilibiliTransport.test.ts
// B站所有请求的唯一出口（bilibiliTransport.ts）。
//
// 安卓 WebView 跑在 https://localhost，passport.bilibili.com 不给它回 CORS 头，
// 裸 fetch 会直接 `TypeError: Failed to fetch` —— 0.7.36 的扫码登录就是这么挂的。
// 这里钉住：transport 的所有请求（尤其扫码 generate/poll）都走 createNativeFetch
// 返回的那条路，绝不自己用全局 fetch。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = vi.fn();

vi.mock('../../../src/services/nativeHttpFetch', () => ({
    createNativeFetch: () => nativeFetch,
}));

const QR_RESPONSE = JSON.stringify({
    code: 0,
    message: 'OK',
    data: { url: 'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=KEY', qrcode_key: 'KEY' },
});

const jsonResponse = (body: string, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body),
    headers: new Headers(),
});

describe('B站 transport 走原生 HTTP（安卓 CORS 修复）', () => {
    beforeEach(() => {
        vi.resetModules();
        nativeFetch.mockReset();
        globalThis.fetch = vi.fn() as typeof fetch;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('扫码生成走 createNativeFetch，且请求头带 B站 Referer', async () => {
        // ensureBuvid 会先取一次首页 cookie，所以共两次原生请求。
        nativeFetch.mockImplementation(async (url: string) => jsonResponse(
            url.includes('qrcode/generate') ? QR_RESPONSE : '{"code":0,"data":null}'
        ));
        const { requestBilibili } = await import('../../../src/services/onlineMusic/bilibili/bilibiliTransport');

        const result = await requestBilibili<{ qrcode_key: string }>('qr-generate');

        expect(nativeFetch).toHaveBeenCalledTimes(2);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        const generateCall = nativeFetch.mock.calls.find((call) => String(call[0]).includes('qrcode/generate'));
        expect(generateCall).toBeDefined();
        const [url, init] = generateCall as [string, RequestInit];
        expect(url).toBe('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
        const headers = new Headers(init.headers);
        expect(headers.get('Referer')).toBe('https://www.bilibili.com/');
        expect(headers.get('User-Agent')).toContain('Mozilla');
        expect(result.data.qrcode_key).toBe('KEY');
    });

    it('扫码轮询也走 native（generate 与 poll 不能一条原生一条裸）', async () => {
        nativeFetch.mockImplementation(async () => jsonResponse('{"code":0,"message":"OK","data":null}'));
        const { requestBilibili } = await import('../../../src/services/onlineMusic/bilibili/bilibiliTransport');

        await requestBilibili('qr-poll', { qrcode_key: 'KEY' });

        expect(nativeFetch).toHaveBeenCalledTimes(2);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        const pollCall = nativeFetch.mock.calls.find((call) => String(call[0]).includes('qrcode/poll'));
        expect(pollCall).toBeDefined();
        const [url] = pollCall as [string];
        expect(url).toBe('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=KEY');
    });

    it('native 抛网络错误时仍包装成 network 类，分类不出错', async () => {
        nativeFetch.mockRejectedValue(new TypeError('Failed to fetch'));
        const { requestBilibili } = await import('../../../src/services/onlineMusic/bilibili/bilibiliTransport');

        await expect(requestBilibili('qr-generate')).rejects.toMatchObject({
            code: 'network',
            message: expect.stringContaining('bilibili qr-generate: Failed to fetch'),
        });
    });

    it('源码护栏：transport 不得再出现裸 fetch 调用', () => {
        const { readFileSync } = require('node:fs');
        const { resolve } = require('node:path');
        const src = readFileSync(resolve(__dirname, '../../../src/services/onlineMusic/bilibili/bilibiliTransport.ts'), 'utf8');
        expect(src).toContain('import { createNativeFetch }');
        expect(src).toContain('const biliFetch = createNativeFetch()');
        // 只允许 biliFetch(...) 与 createNativeFetch() 这两种调用，裸 fetch( 一律不许。
        expect(src).not.toMatch(/(?<!bili)\bfetch\(/);
    });
});
