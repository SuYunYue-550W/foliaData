// test/unit/liquidGlass/liquidGlassCss.test.ts
// 液态玻璃的样式链路护栏。
//
// 曾经的 bug：liquidGlass.css 只被 LiquidGlass.tsx import，而运行时真正挂载的是
// useLiquidGlassFilter.tsx（AppShell / FloatingPlayerControls 都用 hook）。
// LiquidGlass.tsx 的唯一消费者是未挂载的示例组件 LiquidGlassNavBar.tsx，
// 于是 CSS 根本没进构建产物 —— 内高光、青绿内描边、降级磨砂全部失效，
// 用户切到「液体玻璃」只看到 hook 注入的 inline backdrop-filter。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8');

describe('液态玻璃样式链路', () => {
    it('运行时 hook 必须引入 liquidGlass.css', () => {
        const hook = read('src/components/liquidGlass/useLiquidGlassFilter.tsx');
        expect(hook).toContain("import './liquidGlass.css'");
    });

    it('CSS 里确实有液态玻璃的核心样式', () => {
        const css = read('src/components/liquidGlass/liquidGlass.css');
        // 色散玻璃的内高光 / 青绿描边 / 光晕，以及无 SVG 时的降级磨砂
        expect(css).toContain('.folia-chromatic-glass');
        expect(css).toContain('::after');
        expect(css).toContain('blur(18px)');
        expect(css).toContain('prefers-reduced-motion');
    });

    it('两个真实挂载点都在用这个 hook', () => {
        for (const file of [
            'src/components/app/AppShell.tsx',
            'src/components/FloatingPlayerControls.tsx',
        ]) {
            expect(read(file), `${file} 没用液态玻璃 hook`).toContain('useLiquidGlassFilter');
        }
    });

    it('开关与三语文案齐全', () => {
        const store = read('src/stores/usePlayerChromeSettingsStore.ts');
        expect(store).toContain("playerBarGlass: 'frosted' | 'liquid'");
        for (const locale of ['zh-CN', 'en', 'in']) {
            expect(existsSync(resolve(root, `src/i18n/locales/${locale}.ts`))).toBe(true);
            const text = read(`src/i18n/locales/${locale}.ts`);
            expect(text, `${locale} 缺 playerBarGlass 文案`).toContain('playerBarGlass');
        }
    });
});
