import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const css = readFileSync(path.join(root, 'src/styles/androidPhoneFit.css'), 'utf8');
const handle = readFileSync(path.join(root, 'src/components/panelTab/shell/PanelHandle.tsx'), 'utf8');

// 竖屏手机上，面板「打开」时右下角的白色圆形关闭按钮（PanelHandle 的 isOpen 态）会浮到
// fixed 视口右下。旧规则把它的 bottom 硬钉成 120px，而展开的 PanelSurface 底部的 dock
// 页签栏在浅底基线的手机上恰好也升到 ~120px 一带，于是白球压住了最右的「音量」页签。
//
// 修复分两半，任何一半被改回去都会让遮挡复发，所以在这里把契约钉死：
//  1. 120px 的抬升只允许作用在「面板关闭」态（:not([data-folia-panel-open='true'])）；
//  2. PanelHandle 在 isOpen 时输出 data-folia-panel-open='true'，供上面的选择器识别。
// 打开态不套用 120px，白球回到与 PanelShell 同源的内联动态基线，落进 surface 预留的
// 60px 净空（PanelShell 的 HANDLE_ROOM_PX），位于 dock 之下，不再遮挡。
describe('portrait phone: panel close button must not cover the dock tab row', () => {
    it('scopes the 120px lift to the CLOSED panel state only', () => {
        // 找出所有给 panel-toggle 设 bottom: 120px 的规则，确认它们都带关闭态门控。
        const bottom120Rules = [...css.matchAll(
            /html\[data-folia-phone-fit='true'\]\[data-folia-phone-orientation='portrait'\][^{]*\[data-testid='panel-toggle'\][^{]*\{[^}]*bottom:\s*120px\s*!important/g,
        )].map(match => match[0]);

        expect(bottom120Rules.length).toBeGreaterThan(0);
        for (const rule of bottom120Rules) {
            expect(rule).toContain(":not([data-folia-panel-open='true'])");
        }

        // 不能存在「无门控、对全部 panel-toggle 生效」的 120px 规则。
        const unconditional = [...css.matchAll(
            /html\[data-folia-phone-fit='true'\]\[data-folia-phone-orientation='portrait'\]\s*\[data-testid='panel-toggle'\]\s*\{[^}]*bottom:\s*120px\s*!important/g,
        )];
        expect(unconditional).toHaveLength(0);
    });

    it('marks the open state on the handle so the CSS can distinguish it', () => {
        expect(handle).toContain("data-testid=\"panel-toggle\"");
        expect(handle).toMatch(/data-folia-panel-open=\{isOpen\s*\?\s*'true'\s*:\s*undefined\}/);
    });

    it('keeps right/width alignment for BOTH open and closed states', () => {
        // 对齐与触摸尺寸不该被状态门控收窄，否则打开态按钮会跑位或变小。
        const alignmentRule = css.match(
            /html\[data-folia-phone-fit='true'\]\[data-folia-phone-orientation='portrait'\]\s*\[data-testid='panel-toggle'\]\s*\{([^}]*)\}/,
        );
        expect(alignmentRule).not.toBeNull();
        expect(alignmentRule![1]).toContain('right: var(--folia-safe-area-right, 0px)');
        expect(alignmentRule![1]).toContain('width: 44px');
        expect(alignmentRule![1]).not.toContain('bottom: 120px');
    });
});
