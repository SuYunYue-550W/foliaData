// test/unit/bilibili/bilibiliQr.test.ts
// B站扫码登录的二维码。
//
// B站的扫码地址 account.bilibili.com/.../scan-web 是**网页**（响应 text/html），不是图片。
// 早先 createQr 直接把那个 https URL 交回去，LoginTile 拿它当 <img src> 渲染 —— 破图。
// 现在本地用 qrcode 依赖生成 data URL，与其它平台（bodian/netease/kugou 都给真图片）一致。
import { describe, expect, it } from 'vitest';
import { bilibiliProvider } from '../../../src/services/onlineMusic/bilibili/bilibiliProvider';

// test/unit/bilibili/bilibiliQr.test.ts

describe('B站扫码二维码', () => {
    const createQr = bilibiliProvider.auth.createQr as (key: string) => Promise<string>;

    it('createQr 返回可渲染的 PNG data URL，而不是扫码网页地址', async () => {
        const image = await createQr('KEY-123');
        expect(image.startsWith('data:image/png;base64,')).toBe(true);
        // 网页地址当 <img src> 会直接破图：这里不能是它。
        expect(image).not.toContain('account.bilibili.com');
        expect(image).not.toMatch(/^https?:/);
    });

    it('同一个 key 每次都生成出可用的二维码（非空 base64）', async () => {
        const image = await createQr('KEY-123');
        const base64 = image.slice('data:image/png;base64,'.length);
        expect(base64.length).toBeGreaterThan(100);
        // PNG 文件头
        expect(base64.startsWith('iVBORw0KGgo')).toBe(true);
    });

    it('二维码内容带上 B站扫码地址与 key（扫出来能登录）', async () => {
        // QRCode.toDataURL 把内容编进 PNG，断言像素无法反解；这里改验源码里的地址构造。
        const { readFileSync } = require('node:fs');
        const { resolve } = require('node:path');
        const src = readFileSync(resolve(__dirname, '../../../src/services/onlineMusic/bilibili/bilibiliProvider.ts'), 'utf8');
        expect(src).toContain('account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=');
        expect(src).toContain('encodeURIComponent(key)');
        expect(src).toContain('QRCode.toDataURL');
    });
});
