import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// test/unit/library/core/gridTabKeys.test.ts
//
// 网格首页的页签循环键：F6 / Shift+F6，与 Bravais 首页、模组首页页、B站首页页一致。
// 原来劫持 Tab，键盘用户永远 Tab 不到任何控件（焦点该在按钮/输入框之间移动，
// 却被整页的页签循环吃掉）。Tab 已还给浏览器。

const source = readFileSync(
    fileURLToPath(new URL('../../../../src/library/suites/grid/home/useGrid3DTabKeys.ts', import.meta.url)),
    'utf8',
);

describe('网格首页的页签循环键', () => {
    it('cycles the tabs with F6 instead of hijacking Tab', () => {
        expect(source).toContain("event.key !== 'F6'");
        expect(source).not.toContain("event.key !== 'Tab'");
    });

    it('keeps the guards: text entry targets, blocking windows and key repeat', () => {
        expect(source).toContain('isTextEntryTarget(event.target)');
        expect(source).toContain('hasBlockingWindow()');
        expect(source).toContain('if (event.repeat) return;');
    });

    it('still supports the reverse direction with Shift', () => {
        expect(source).toContain('event.shiftKey ? -1 : 1');
    });
});
