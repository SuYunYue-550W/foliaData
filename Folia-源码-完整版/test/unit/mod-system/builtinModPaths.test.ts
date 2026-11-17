// test/unit/mod-system/builtinModPaths.test.ts
// 随包模组的静态地址护栏。
//
// 桌面端曾出现过三个随包模组（听歌档案 / 黑胶唱片 / 跳一跳）全部启动失败：
// 客户端报 "Failed to fetch dynamically imported module: file:///C:/mods/builtin/.../client.mjs"。
// 根因是 BUILTIN_BASE 写死成 '/mods/builtin' —— 桌面页是 file:// 协议，浏览器把
// 根相对路径解析到盘符根（file:///C:/mods/…），而文件实际在 <dist>/mods/…。
// Capacitor（https://localhost）下根相对路径才恰好正确。
//
// 修法是跟 vite 的 base 走（桌面与 Capacitor 构建 base='./'，纯 Web 才是 '/'）。
// 这个测试钉住源码形状，防止哪天又被改回根相对路径。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = (rel: string): string => readFileSync(resolve(__dirname, '../../../', rel), 'utf8');

describe('随包模组的静态地址', () => {
    it('跟 vite 的 base 走，不写死根相对路径', () => {
        const src = source('src/mods/builtin/builtinMods.ts');
        expect(src).toContain('import.meta.env.BASE_URL');
        expect(src).not.toMatch(/const BUILTIN_BASE\s*=\s*['"`]\/mods\/builtin/);
    });

    it('preview 与 clientUrl 用的是同一个 base', () => {
        const src = source('src/mods/builtin/builtinMods.ts');
        expect(src).toContain('BUILTIN_BASE}/${source.id}/client.mjs');
        expect(src).toContain('BUILTIN_BASE}/${source.id}/${name}');
    });

    it('vite 在桌面与 Capacitor 构建下用相对 base', () => {
        const cfg = source('vite.config.ts');
        expect(cfg).toMatch(/base:\s*process\.env\.ELECTRON === 'true' \|\| isCapacitorBuild \? '\.\/' : '\/'/);
    });

    it('三个随包模组都在清单里', () => {
        const src = source('src/mods/builtin/builtinMods.ts');
        ['vinyl-disc', 'visualizer-jump', 'listening-archive']
            .forEach((id) => expect(src, `缺 ${id}`).toContain(`id: '${id}'`));
    });
});
