// src/components/liquidGlass/LiquidGlassNavBar.tsx
//
// 用 LiquidGlass 原语搭出的完整导航栏示例：顶部搜索框 / 账号胶囊、左侧导航 rail、
// 面板页签、底部播放控制条。它演示「色散液态玻璃」如何套到不同类型的导航元素上，
// 并复现 hover 抬升 / 按压回弹 / 点击涟漪 / 页签激活态。
//
// 这是**可挂载的独立组件**，不改现有 AppShell / PanelShell 的任何 DOM；接入方式见交付说明。
// 布局与图标为本组件独立编写，视觉思路致谢 Mineradio 2.2.0（GPL-3.0-only）。

import React, { useState } from 'react';
import {
    Home, Search, Library, Radio, Compass, Settings2,
    Play, SkipBack, SkipForward, Volume2, Heart, ListMusic,
} from 'lucide-react';
import LiquidGlass from './LiquidGlass';
import './liquidGlassNavBar.css';

const RAIL_ITEMS = [
    { key: 'home', label: '首页', Icon: Home },
    { key: 'search', label: '搜索', Icon: Search },
    { key: 'library', label: '曲库', Icon: Library },
    { key: 'radio', label: '电台', Icon: Radio },
    { key: 'explore', label: '发现', Icon: Compass },
] as const;

const PANEL_TABS = ['歌曲', '歌词', '队列', '音效', '账号'] as const;

export interface LiquidGlassNavBarProps {
    tone?: 'dark' | 'light';
    /** 强制退回普通磨砂（开关对比 / 低性能 / 用户偏好）。 */
    disableDispersion?: boolean;
    /** 局部色散参数，交给每一个玻璃元素。 */
    dispersionParams?: React.ComponentProps<typeof LiquidGlass>['params'];
}

const LiquidGlassNavBar: React.FC<LiquidGlassNavBarProps> = ({
    tone = 'dark',
    disableDispersion = false,
    dispersionParams,
}) => {
    const [railKey, setRailKey] = useState<string>('home');
    const [tab, setTab] = useState<string>('歌曲');
    const glassProps = { tone, disabled: disableDispersion, params: dispersionParams };

    return (
        <div className="folia-lg-nav" data-tone={tone}>
            {/* 顶栏：品牌 + 搜索框 + 账号胶囊 */}
            <header className="folia-lg-topbar">
                <div className="folia-lg-brand">
                    <span className="folia-lg-brand-mark" />
                    <span>FOLIA</span>
                </div>
                <LiquidGlass {...glassProps} radius={999} className="folia-lg-search">
                    <Search size={16} />
                    <input placeholder="搜索歌曲、歌手、专辑…" aria-label="搜索" />
                    <kbd>⌘K</kbd>
                </LiquidGlass>
                <LiquidGlass {...glassProps} radius={999} interactive className="folia-lg-account">
                    <span className="folia-lg-avatar">鲸</span>
                    <span className="folia-lg-account-name">Whale Pet</span>
                </LiquidGlass>
            </header>

            <div className="folia-lg-body">
                {/* 左侧导航 rail */}
                <nav className="folia-lg-rail" aria-label="主导航">
                    {RAIL_ITEMS.map(({ key, label, Icon }) => (
                        <LiquidGlass
                            {...glassProps}
                            key={key}
                            radius={16}
                            interactive
                            active={railKey === key}
                            onClick={() => setRailKey(key)}
                            className="folia-lg-rail-item"
                            aria-current={railKey === key ? 'page' : undefined}
                        >
                            <Icon size={18} />
                            <span>{label}</span>
                        </LiquidGlass>
                    ))}
                </nav>

                {/* 内容区：面板 + 页签 */}
                <main className="folia-lg-main">
                    <div className="folia-lg-panel-tabs" role="tablist">
                        {PANEL_TABS.map(t => (
                            <LiquidGlass
                                {...glassProps}
                                key={t}
                                radius={999}
                                interactive
                                active={tab === t}
                                onClick={() => setTab(t)}
                                className="folia-lg-tab"
                                role="tab"
                                aria-selected={tab === t}
                            >
                                {t}
                            </LiquidGlass>
                        ))}
                    </div>
                    <LiquidGlass {...glassProps} radius={26} className="folia-lg-content">
                        <div className="folia-lg-content-head">
                            <div>
                                <div className="folia-lg-eyebrow">正在播放 · {tab}</div>
                                <h2>色散液态玻璃</h2>
                                <p>拖动右侧滑块，观察玻璃边缘的折射与彩色镶边如何变化。</p>
                            </div>
                            <span className="folia-lg-badge">SVG Dispersion</span>
                        </div>
                        <div className="folia-lg-tiles">
                            {['沉浸声场', '母带音质', '粒子频谱', '无缝混音'].map((t, i) => (
                                <LiquidGlass {...glassProps} key={t} radius={18} interactive className="folia-lg-tile">
                                    <span className="folia-lg-tile-idx">0{i + 1}</span>
                                    <span>{t}</span>
                                </LiquidGlass>
                            ))}
                        </div>
                    </LiquidGlass>
                </main>
            </div>

            {/* 底部播放控制条 */}
            <footer className="folia-lg-bottom">
                <LiquidGlass {...glassProps} radius={28} className="folia-lg-player">
                    <div className="folia-lg-track">
                        <span className="folia-lg-cover">♫</span>
                        <div>
                            <div className="folia-lg-track-title">Liquid Glass</div>
                            <div className="folia-lg-track-artist">Folia · Chromatic Session</div>
                        </div>
                        <Heart size={16} className="folia-lg-dim" />
                    </div>
                    <div className="folia-lg-controls">
                        <button aria-label="上一首"><SkipBack size={18} /></button>
                        <button className="folia-lg-play" aria-label="播放"><Play size={20} fill="currentColor" /></button>
                        <button aria-label="下一首"><SkipForward size={18} /></button>
                    </div>
                    <div className="folia-lg-extra">
                        <ListMusic size={16} />
                        <Volume2 size={16} />
                        <Settings2 size={16} />
                        <div className="folia-lg-progress"><span /></div>
                    </div>
                </LiquidGlass>
            </footer>
        </div>
    );
};

export default LiquidGlassNavBar;
