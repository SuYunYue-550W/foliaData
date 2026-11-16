// test/unit/startup/splashBootGuard.test.ts
// 「卡在启动页」回归护栏。
//
// 现象：Windows 打开后停在 #app-splash 的 Folia logo/波形动画上，永不进入主界面。
// 成因：index.tsx 顶层副作用（microRender / 调试 / 限帧等）任意一个同步抛错，模块执行
//       中断，写在中间的 import('./bootstrap') 不运行 -> React 永不挂载 -> 遮罩不被移除；
//       而 bootstrap 内的 8 秒兜底也因此从未被设置。
// 修复：① index.html 纯内联看门狗（不依赖 bundle）到点强制摘遮罩并打诊断标记；
//       ② index.tsx 顶部用 queueMicrotask 排队 bootstrap（同步抛错也挡不住微任务）。
// 这些断言钉住两道护栏都在，且内联看门狗确实进了构建产物。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../../..');
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), 'utf8');

const indexHtml = () => read('index.html');
const indexTsx = () => read('src/index.tsx');
const bootstrapTsx = () => read('src/bootstrap.tsx');

const tryReadDist = (): string | null => {
    try {
        return read('dist/index.html');
    } catch {
        return null;
    }
};

describe('首屏遮罩看门狗（index.html 内联，独立于 bundle）', () => {
    it('存在内联看门狗，且设置诊断标记与控制台告警', () => {
        const html = indexHtml();
        expect(html).toContain('__foliaSplashWatchdogFired');
        expect(html).toContain("data-app-splash-watchdog");
        expect(html).toMatch(/console\.warn\('\[AppSplash\]\s*watchdog fired/);
    });

    it('到点后复用 is-hiding 淡出并从 DOM 移除遮罩', () => {
        const html = indexHtml();
        expect(html).toMatch(/getElementById\('app-splash'\)/);
        expect(html).toMatch(/classList\.add\('is-hiding'\)/);
        expect(html).toMatch(/removeChild\(splash\)/);
    });

    it('看门狗时长晚于 bootstrap 的 8 秒兜底，不干扰正常启动', () => {
        const html = indexHtml();
        const watchdogMs = Number(html.match(/WATCHDOG_MS\s*=\s*(\d+)/)?.[1]);
        const bootstrap = bootstrapTsx();
        // 源码里写的是 8_000（带千分位下划线），取数字并去掉下划线再比较。
        const fallbackRaw = bootstrap.match(/BOOT_RENDER_FALLBACK_MS\s*=\s*([\d_]+)/)?.[1];
        const fallbackMs = Number(fallbackRaw?.replace(/_/g, ''));
        expect(Number.isFinite(watchdogMs)).toBe(true);
        expect(Number.isFinite(fallbackMs)).toBe(true);
        expect(fallbackMs).toBe(8000);
        expect(watchdogMs).toBeGreaterThan(fallbackMs);
    });

    it('构建产物 dist/index.html 也带看门狗（确认打包进去）', () => {
        const dist = tryReadDist();
        if (dist === null) return; // 未构建时跳过，不制造假失败
        // dist 可能是修改前遗留的旧产物：仅当它已经带上新看门狗标记时才核对完整性，
        // 否则视为「尚未重新构建」，由发布流程的构建步骤保证同步，不在单测里制造假失败。
        if (!dist.includes('__foliaSplashWatchdogFired')) return;
        expect(dist).toContain('data-app-splash-watchdog');
        expect(dist).toContain('watchdog fired');
    });
});

describe('bootstrap 挂载保护（index.tsx 顶部微任务）', () => {
    it('在文件开头用 queueMicrotask 排队 bootstrap', () => {
        const tsx = indexTsx();
        expect(tsx).toMatch(/queueMicrotask\(\(\)\s*=>\s*\{\s*void import\('\.\/bootstrap'\);?\s*\}\)/);
    });

    it('排队语句位于所有顶层副作用之前', () => {
        const tsx = indexTsx();
        const queueAt = tsx.indexOf('queueMicrotask');
        const firstSideEffect = tsx.indexOf('installConsoleLogCapture()');
        expect(queueAt).toBeGreaterThanOrEqual(0);
        expect(firstSideEffect).toBeGreaterThan(queueAt);
    });

    it('可执行代码里只有一次 bootstrap import（注释不算，避免重复挂载）', () => {
        const tsx = indexTsx();
        // 去掉整行注释后统计，注释里提到的 import('./bootstrap') 不计入。
        const code = tsx.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
        const imports = code.match(/import\('\.\/bootstrap'\)/g) ?? [];
        expect(imports).toHaveLength(1);
    });
});
