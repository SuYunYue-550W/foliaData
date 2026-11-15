import React from 'react';
import { MicVocal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../../../types';
import { useKaraokeModeStore, type KaraokeMode } from '../../../stores/useKaraokeModeStore';
import { isAndroidAppShell } from '../../../platform/runtime';
import { Button } from '../../ui';

// src/components/panelTab/controls/KaraokeRow.tsx
// 控制面板里的「伴唱」：三档 —— 关 / 伴奏（人声消除）/ 人声独唱。
//
// 实时路由，正在播的歌不重启：档位切换只动 Web Audio 图上三颗增益的斜坡
// （services/audioEffects/karaokeBranch.ts）。安卓 App 壳里原生 ExoPlayer 出声、
// 没有这张图，整行灰置并说明原因 —— 不是分析能力缺不缺的问题（htdemucs 的
// 分轨只覆盖头尾各 30 秒，本来也撑不起整首伴唱），是播放链路不经过 Web Audio。

interface KaraokeRowProps {
    theme: Theme;
    isDaylight: boolean;
}

const KaraokeRow: React.FC<KaraokeRowProps> = ({ theme, isDaylight }) => {
    const { t } = useTranslation();
    const mode = useKaraokeModeStore(state => state.mode);
    const setMode = useKaraokeModeStore(state => state.setMode);

    // 与 useKaraokeModeStore 顶部说明一致：判定只认「原生 App 壳」，
    // 不认 Capacitor 桥是否就绪（启动头几秒那个判断会答错，见 runtime.ts）。
    const available = !isAndroidAppShell();

    const options: Array<{ id: KaraokeMode; label: string }> = [
        { id: 'off', label: t('karaoke.modeOff', '关') },
        { id: 'instrumental', label: t('karaoke.modeInstrumental', '伴奏') },
        { id: 'vocal', label: t('karaoke.modeVocal', '人声') },
    ];

    return (
        <div className="flex min-h-11 items-center gap-3 px-1 py-1.5">
            <MicVocal
                size={16}
                className="shrink-0"
                style={mode !== 'off' && available ? { color: theme.accentColor } : { opacity: 0.4 }}
            />
            <span className="shrink-0 text-sm leading-5">{t('karaoke.rowTitle', '伴唱')}</span>
            {available ? (
                <div className={`flex min-w-0 flex-1 gap-1 rounded-lg p-0.5 ${isDaylight ? 'bg-black/5' : 'bg-black/25'}`}>
                    {options.map(option => {
                        const active = option.id === mode;
                        return (
                            <Button
                                key={option.id}
                                aria-pressed={active}
                                onClick={() => setMode(option.id)}
                                className={`min-w-0 flex-1 truncate rounded-md px-1.5 py-1 text-[11px] font-semibold transition-opacity ${active
                                    ? (isDaylight ? 'bg-white shadow-sm' : 'bg-white/10')
                                    : (isDaylight ? 'opacity-55 hover:opacity-100' : 'opacity-50 hover:opacity-100')}`}
                                style={active ? { color: theme.accentColor } : undefined}
                            >
                                {option.label}
                            </Button>
                        );
                    })}
                </div>
            ) : (
                <span
                    className="min-w-0 flex-1 truncate text-[10px] opacity-50"
                    style={{ color: 'var(--text-secondary)' }}
                >
                    {t('karaoke.unavailableNative', '安卓原生播放暂不支持伴唱')}
                </span>
            )}
        </div>
    );
};

export default KaraokeRow;
