import React, { useState } from 'react';
import PanelShell from '../../src/components/panelTab/shell/PanelShell';
import { DEFAULT_THEME } from '../../src/services/baseThemes';
import type { ProbeDefinition } from './definition';

// dev/probes/panelOutsideClick.probe.tsx
// 播放页那块面板没有遮罩层，关它只能去够右下角那颗按钮。这里验证「点面板以外的空白处收起」：
// 点面板本体不该关、点空白该关、点手柄仍然只切换一次（不能双触发）。
//
// 面板本体用一小块固定盒子代替真实内容：验的是 PanelShell 的判定范围，不是页签内容。

const PanelOutsideClickProbe: React.FC = () => {
    const [isOpen, setIsOpen] = useState(true);
    const [clicks, setClicks] = useState(0);

    return (
        <div className="relative h-screen w-screen bg-[#0b0d16] p-6 text-white">
            <p className="text-xs leading-5 text-zinc-400">
                panel outside click · open={String(isOpen)} · toggles={clicks}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
                点左边这块空白应该收起面板；点面板本体不应该收起。
            </p>

            <div className="absolute inset-0" data-probe-blank onClick={() => { /* 空白处本身什么都不做 */ }} />

            {/* 一个模拟的浮层：点它不该关面板（判定里排除了 dialog 与 data-folia-float-layer）。 */}
            <div
                role="dialog"
                data-probe-dialog
                className="absolute left-8 top-40 h-24 w-40 rounded-xl bg-zinc-800 p-3 text-xs"
            >
                fake dialog
            </div>

            <PanelShell
                isOpen={isOpen}
                onToggle={() => { setClicks(c => c + 1); setIsOpen(v => !v); }}
                hasHandle
                isCover={false}
                tabKey="controls"
                theme={DEFAULT_THEME}
                isDaylight={false}
                header={<div className="px-1 pb-2 text-sm">song header</div>}
                dock={<div className="flex h-9 items-center gap-2 px-2 text-xs text-zinc-300">封面 / 控制 / 播放列表 / 音质</div>}
                handle={(
                    // 手柄在 shell 内，所以外面的监听器不会重复触发；这里点它应当只切换一次。
                    <div
                        className="pointer-events-auto mt-2 h-12 w-12 cursor-pointer rounded-full bg-white/85"
                        data-probe-handle
                        onClick={() => { setClicks(c => c + 1); setIsOpen(v => !v); }}
                    />
                )}
            >
                <div className="p-2 text-xs text-zinc-300" data-probe-panel-body>
                    panel body · 点这里不该收起
                </div>
            </PanelShell>
        </div>
    );
};

const probe: ProbeDefinition = {
    id: 'panelOutsideClick',
    title: '播放页面板 · 点空白处收起',
    description: '验证点面板以外收起、点面板本体不收起、点手柄不双触发。',
    Component: PanelOutsideClickProbe,
};

export default probe;
