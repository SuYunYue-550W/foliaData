import { useEffect, useRef } from 'react';
import { hasBlockingWindow, isTextEntryTarget } from '../../../../utils/keyboardTargets';

// src/library/suites/grid/home/useGrid3DTabKeys.ts
// 网格首页的 F6 / Shift+F6：在顶部胶囊的内容页签（含扩展入口）之间循环 —— 与 Bravais 首页、
// 模组首页页、B站首页页是同一个键（B站页那两处也是 F6），跨 suite 键位不再变。
//
// 原来这里劫持的是 Tab / Shift+Tab。那样键盘用户永远 Tab 不到任何控件：焦点本该在
// 按钮、输入框、页签之间移动，却被整页的页签循环吃掉（isTextEntryTarget 守卫也救不了，
// 因为根本到不了输入框）。Tab 还给浏览器，页签循环换到 F6。
//
// TUI 首页仍用 Tab 切分区：那是终端式套件，Tab 切分区是刻意的终端语义，
// 并且它另有 F6 切来源，两者不是同一个维度。
//
// 输入框里的按键不抢，上层窗口打开时让路；长按不连发。

type Grid3DTabKeys = {
    isActive: boolean;
    /** F6 / Shift+F6：下一个 / 上一个页签。 */
    onCycleTab: (delta: 1 | -1) => void;
};

export const useGrid3DTabKeys = (handlers: Grid3DTabKeys) => {
    const latest = useRef(handlers);
    latest.current = handlers;

    useEffect(() => {
        if (!handlers.isActive) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'F6' || event.ctrlKey || event.altKey || event.metaKey) return;
            if (isTextEntryTarget(event.target) || hasBlockingWindow()) return;
            event.preventDefault();
            if (event.repeat) return;
            latest.current.onCycleTab(event.shiftKey ? -1 : 1);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handlers.isActive]);
};
