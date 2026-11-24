import { beforeEach, describe, expect, it, vi } from 'vitest';

// 控制运行时环境：默认都 false（纯 Web），各用例按需打开。
const env = vi.hoisted(() => ({ electron: false, android: false, harmony: false }));
vi.mock('../../../src/platform/runtime', () => ({
    hasElectronBridge: () => env.electron,
    isCapacitorAndroid: () => env.android,
    isCapacitorHarmony: () => env.harmony,
}));

import { bilibiliProvider } from '../../../src/services/onlineMusic/bilibili/bilibiliProvider';

// test/unit/bilibili/bilibiliAvailability.test.ts
//
// 纯 Web 构建里 B站接口不给 localhost 回 CORS 头，扫码登录的 Set-Cookie 拿不到，
// SESSDATA 无法落地。按项目通用约定把 provider 标成 runtime-unavailable，
// 通用 UI 就会隐藏连接按钮、置灰登录行，不让用户点了再失败。

describe('B站 provider 的运行时可用性', () => {
    beforeEach(() => {
        env.electron = false;
        env.android = false;
        env.harmony = false;
    });

    it('纯 Web 下标为 runtime-unavailable', () => {
        expect(bilibiliProvider.getAvailability()).toEqual({ configured: false, reason: 'runtime-unavailable' });
    });

    it('Electron 桌面端可用', () => {
        env.electron = true;
        expect(bilibiliProvider.getAvailability()).toEqual({ configured: true, reason: null });
    });

    it('Android 原生壳可用（原生 HTTP 桥能带 cookie）', () => {
        env.android = true;
        expect(bilibiliProvider.getAvailability().configured).toBe(true);
    });

    it('鸿蒙 ArkWeb 壳可用', () => {
        env.harmony = true;
        expect(bilibiliProvider.getAvailability().configured).toBe(true);
    });

    it('能力声明不随环境变化：搜索与播放不受影响', () => {
        // UI 隐藏的是"登录入口"，不是这个 provider 的歌曲能力。
        expect(bilibiliProvider.capabilities.search).toBe(true);
        expect(bilibiliProvider.capabilities.playback).toBe(true);
        expect(bilibiliProvider.capabilities.auth).toBe(true);
    });
});
