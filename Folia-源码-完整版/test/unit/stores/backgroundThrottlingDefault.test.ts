// test/unit/stores/backgroundThrottlingDefault.test.ts
// 后台节流默认开启：新用户省电（最小化/托盘时停动画，不再 60/120fps 空跑），
// 但显式关过的老用户保持原样（OBS 窗口采集需要后台照常画）。
// 主进程两处 fallback 与三语设置文案用源码护栏钉住，避免只改一半。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');

describe('后台节流默认开启', () => {
    let values: Map<string, string>;

    beforeEach(() => {
        values = new Map();
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        };
        vi.stubGlobal('localStorage', storage);
        vi.stubGlobal('window', { localStorage: storage, electron: { saveSettings: vi.fn().mockResolvedValue(undefined) } });
        vi.resetModules();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    const loadStore = async () => (await import('@/stores/useDesktopSettingsStore')).useDesktopSettingsStore;

    it('新用户（没有存过设置）默认开启', async () => {
        const store = await loadStore();
        expect(store.getState().backgroundThrottling).toBe(true);
    });

    it('显式关过的老用户保持关闭，不被默认值覆盖', async () => {
        values.set('background_throttling', 'false');
        const store = await loadStore();
        expect(store.getState().backgroundThrottling).toBe(false);
    });

    it('主进程两处 fallback 都是 true，显式值仍优先', () => {
        const main = read('electron/main.cjs');
        expect(main).toContain('isEnabled: () => readStoredBoolean(BACKGROUND_THROTTLING_SETTING_KEY, true)');
        expect(main).toContain('[BACKGROUND_THROTTLING_SETTING_KEY]: readStoredBoolean(BACKGROUND_THROTTLING_SETTING_KEY, true)');
        // readStoredBoolean 先看显式值，fallback 只在没值时生效。
        expect(main).toContain('if (typeof value === \'boolean\') {\n    return value;\n  }');
    });

    it('三语设置文案不再说「默认关闭」', () => {
        for (const locale of ['zh-CN', 'en', 'in']) {
            const src = read(`src/i18n/locales/${locale}.ts`);
            expect(src, locale).not.toMatch(/backgroundThrottlingDesc.*(?:默认关闭|Off by default|Nonaktif secara bawaan)/);
            expect(src, locale).toMatch(/backgroundThrottlingDesc.*(?:默认开启|On by default|Aktif secara bawaan)/);
        }
    });
});
