import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
    AUDIO_CONSOLE_BASS_CROSSOVER_MAX,
    AUDIO_CONSOLE_BASS_CROSSOVER_MIN,
    AUDIO_CONSOLE_CROSSFEED_DELAY_MAX,
    AUDIO_CONSOLE_CROSSFEED_DELAY_MIN,
    AUDIO_CONSOLE_CROSSFEED_LEVEL_MAX,
    AUDIO_CONSOLE_CROSSFEED_LEVEL_MIN,
    AUDIO_CONSOLE_IMMERSIVE_PRESET_SETTINGS,
    AUDIO_CONSOLE_IMMERSIVE_PRESETS,
    AUDIO_CONSOLE_ORBIT_PERIOD_MAX,
    AUDIO_CONSOLE_ORBIT_PERIOD_MIN,
    AUDIO_CONSOLE_SURROUND_WIDTH_MAX,
    AUDIO_CONSOLE_SURROUND_WIDTH_MIN,
    AUDIO_CONSOLE_TARGET_LOUDNESS_MAX,
    AUDIO_CONSOLE_TARGET_LOUDNESS_MIN,
    AUDIO_CONSOLE_VOCAL_MAX_DB,
    type AudioConsoleImmersivePreset,
    type AudioConsoleSurroundMode,
} from '../../../utils/audioConsole';
import { useAudioConsoleStore } from '../../../stores/useAudioConsoleStore';
import { Segmented, Toggle } from '../../modal/settings/kit';
import EqualizerSection from '../equalizer/EqualizerSection';
import { ConsoleSlider, formatDb, formatHz, formatMs, formatPercent, formatSeconds } from './controls';

// src/components/panelTab/console/ImmersivePane.tsx
// 调音台的第六页：沉浸音效。
//
// 为什么单独一页而不塞进混响页：这一页改的是「声场」，混响页改的是「空间的大小」——
// 两者都在动空间，但一个是「声音从哪儿来」，一个是「房间有多大」。放在一起，
// 用户会以为它们是一件事，而实际上把它们同时开到最大，声音会先散掉再糊掉。
//
// 七块的顺序与信号链一致（环绕 → 交叉馈送 → 人声 → 夜间 → 黑胶 → 8D → 超低音），
// 从上往下读就是「声音经过了什么」。这比按「常用度」排更有解释力 ——
// 也让人一眼看出 8D 在最后、环绕在最前，调 8D 时不会奇怪为什么环绕没效果。
//
// 顶部那排一键预设是整组替换（store 的 applyImmersivePreset），不是叠加：
// 预设存在的意义是「一次拿到一个能听的起点」，叠加会让它退化成「又一个开关」。

const SURROUND_MODES: ReadonlyArray<{ id: AudioConsoleSurroundMode; key: string }> = [
    { id: 'off', key: 'ui.consoleSurroundModeOff' },
    { id: 'headphone', key: 'ui.consoleSurroundModeHeadphone' },
    { id: 'speaker', key: 'ui.consoleSurroundModeSpeaker' },
];

const PRESETS: ReadonlyArray<{ id: AudioConsoleImmersivePreset; key: string }> = [
    { id: 'off', key: 'ui.consoleImmersivePresetOff' },
    { id: 'music', key: 'ui.consoleImmersivePresetMusic' },
    { id: 'movie', key: 'ui.consoleImmersivePresetMovie' },
    { id: 'night', key: 'ui.consoleImmersivePresetNight' },
    { id: 'headphone', key: 'ui.consoleImmersivePresetHeadphone' },
];

// ConsoleSlider 的 onCommit 是必填项，但这一页的滑杆 onChange 已经实时写 store
// （拖动即生效、无需松手再提交），没有任何收尾要做。统一引用这一个模块级常量，
// 免得每渲染造 14 个新函数、把下游组件的 memo 全打穿。
const NO_COMMIT = () => undefined;

const ImmersivePane: React.FC = () => {
    const { t } = useTranslation();
    const immersive = useAudioConsoleStore(state => state.settings.immersive);
    const applyPreset = useAudioConsoleStore(state => state.applyImmersivePreset);
    const setSurround = useAudioConsoleStore(state => state.setSurround);
    const setCrossfeed = useAudioConsoleStore(state => state.setCrossfeed);
    const setVocal = useAudioConsoleStore(state => state.setVocal);
    const setNight = useAudioConsoleStore(state => state.setNight);
    const setVinyl = useAudioConsoleStore(state => state.setVinyl);
    const setOrbit = useAudioConsoleStore(state => state.setOrbit);
    const setBass = useAudioConsoleStore(state => state.setBass);

    const surroundOn = immersive.surround.mode !== 'off';

    /*
     * 当前跟哪一组预设对得上。
     *
     * 不存「上次点了哪个预设」—— 那个状态会跟真实设置脱节：用户点完「电影」又把环绕关掉，
     * 排上仍然会亮着「电影」。这里反过来算：把当前七项与每一组预设逐字段比一次，
     * 对得上就亮那一组，一组都对不上就不亮。这样「改过任何一根滑杆」都会立刻反映出来。
     */
    const activePreset = useMemo<AudioConsoleImmersivePreset | null>(() => {
        const signature = JSON.stringify(immersive);
        for (const preset of AUDIO_CONSOLE_IMMERSIVE_PRESETS) {
            if (JSON.stringify(AUDIO_CONSOLE_IMMERSIVE_PRESET_SETTINGS[preset]) === signature) return preset;
        }
        return null;
    }, [immersive]);

    return (
        <div className="flex min-h-full flex-col">
            <EqualizerSection title={t('ui.consoleImmersivePreset')} hint={t('ui.consoleImmersiveHint')}>
                <div className="space-y-2 px-4 pb-4 pt-3">
                    <Segmented
                        value={activePreset ?? ''}
                        options={PRESETS.map(item => ({ value: item.id, label: t(item.key) }))}
                        onChange={value => applyPreset(value as AudioConsoleImmersivePreset)}
                    />
                    <p className="text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleImmersivePresetHint')}</p>
                </div>
            </EqualizerSection>

            <EqualizerSection title={t('ui.consoleSurround')} hint={t('ui.consoleSurroundHint')}>
                <div className="space-y-3.5 px-4 pb-4 pt-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[12px] text-[color:var(--st-t2)]">{t('ui.consoleSurroundMode')}</span>
                        <Segmented
                            value={immersive.surround.mode}
                            options={SURROUND_MODES.map(item => ({ value: item.id, label: t(item.key) }))}
                            onChange={mode => setSurround({ mode })}
                        />
                    </div>

                    <div className={surroundOn ? 'space-y-3.5' : 'space-y-3.5 opacity-40'}>
                        <ConsoleSlider
                            label={t('ui.consoleSurroundWidth')}
                            valueText={formatPercent((immersive.surround.width - AUDIO_CONSOLE_SURROUND_WIDTH_MIN)
                                / (AUDIO_CONSOLE_SURROUND_WIDTH_MAX - AUDIO_CONSOLE_SURROUND_WIDTH_MIN))}
                            value={immersive.surround.width}
                            min={AUDIO_CONSOLE_SURROUND_WIDTH_MIN}
                            max={AUDIO_CONSOLE_SURROUND_WIDTH_MAX}
                            decimals={2}
                            disabled={!surroundOn}
                            onChange={width => setSurround({ width })}
                            onCommit={NO_COMMIT}
                        />
                        <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleSurroundWidthHint')}</p>
                        <ConsoleSlider
                            label={t('ui.consoleSurroundRoom')}
                            valueText={formatPercent(immersive.surround.roomAmount)}
                            value={immersive.surround.roomAmount}
                            min={0}
                            max={1}
                            decimals={2}
                            disabled={!surroundOn}
                            onChange={roomAmount => setSurround({ roomAmount })}
                            onCommit={NO_COMMIT}
                        />
                        <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleSurroundRoomHint')}</p>
                    </div>
                </div>
            </EqualizerSection>

            <EqualizerSection title={t('ui.consoleCrossfeed')} hint={t('ui.consoleCrossfeedHint')}>
                <div className="space-y-3.5 px-4 pb-4 pt-3">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleCrossfeedEnabled')}</span>
                        <Toggle
                            checked={immersive.crossfeed.enabled}
                            onChange={enabled => setCrossfeed({ enabled })}
                            label={t('ui.consoleCrossfeedEnabled')}
                        />
                    </div>
                    <ConsoleSlider
                        label={t('ui.consoleCrossfeedLevel')}
                        valueText={formatDb(-immersive.crossfeed.levelDb, 1)}
                        value={immersive.crossfeed.levelDb}
                        min={AUDIO_CONSOLE_CROSSFEED_LEVEL_MIN}
                        max={AUDIO_CONSOLE_CROSSFEED_LEVEL_MAX}
                        decimals={1}
                        disabled={!immersive.crossfeed.enabled}
                        onChange={levelDb => setCrossfeed({ levelDb })}
                        onCommit={NO_COMMIT}
                    />
                    <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleCrossfeedLevelHint')}</p>
                    <ConsoleSlider
                        label={t('ui.consoleCrossfeedDelay')}
                        valueText={formatMs(immersive.crossfeed.delayMs)}
                        value={immersive.crossfeed.delayMs}
                        min={AUDIO_CONSOLE_CROSSFEED_DELAY_MIN}
                        max={AUDIO_CONSOLE_CROSSFEED_DELAY_MAX}
                        decimals={2}
                        disabled={!immersive.crossfeed.enabled}
                        onChange={delayMs => setCrossfeed({ delayMs })}
                        onCommit={NO_COMMIT}
                    />
                    <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleCrossfeedDelayHint')}</p>
                </div>
            </EqualizerSection>

            <EqualizerSection title={t('ui.consoleVocal')} hint={t('ui.consoleVocalHint')}>
                <div className="space-y-3.5 px-4 pb-4 pt-3">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleVocalEnabled')}</span>
                        <Toggle
                            checked={immersive.vocal.enabled}
                            onChange={enabled => setVocal({ enabled })}
                            label={t('ui.consoleVocalEnabled')}
                        />
                    </div>
                    <ConsoleSlider
                        label={t('ui.consoleVocalAmount')}
                        valueText={formatDb(immersive.vocal.amountDb, 1)}
                        value={immersive.vocal.amountDb}
                        min={0}
                        max={AUDIO_CONSOLE_VOCAL_MAX_DB}
                        decimals={1}
                        disabled={!immersive.vocal.enabled}
                        onChange={amountDb => setVocal({ amountDb })}
                        onCommit={NO_COMMIT}
                    />
                    <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleVocalAmountHint')}</p>
                </div>
            </EqualizerSection>

            <EqualizerSection title={t('ui.consoleNight')} hint={t('ui.consoleNightHint')}>
                <div className="space-y-3.5 px-4 pb-4 pt-3">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleNightEnabled')}</span>
                        <Toggle
                            checked={immersive.night.enabled}
                            onChange={enabled => setNight({ enabled })}
                            label={t('ui.consoleNightEnabled')}
                        />
                    </div>
                    <ConsoleSlider
                        label={t('ui.consoleNightStrength')}
                        valueText={formatPercent(immersive.night.strength)}
                        value={immersive.night.strength}
                        min={0}
                        max={1}
                        decimals={2}
                        disabled={!immersive.night.enabled}
                        onChange={strength => setNight({ strength })}
                        onCommit={NO_COMMIT}
                    />
                    <ConsoleSlider
                        label={t('ui.consoleNightTarget')}
                        valueText={formatDb(immersive.night.targetLoudness, 1)}
                        value={immersive.night.targetLoudness}
                        min={AUDIO_CONSOLE_TARGET_LOUDNESS_MIN}
                        max={AUDIO_CONSOLE_TARGET_LOUDNESS_MAX}
                        decimals={1}
                        disabled={!immersive.night.enabled}
                        onChange={targetLoudness => setNight({ targetLoudness })}
                        onCommit={NO_COMMIT}
                    />
                    <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleNightTargetHint')}</p>
                    <p className="text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleNightNativeHint')}</p>
                </div>
            </EqualizerSection>

            <EqualizerSection title={t('ui.consoleVinylGroup')} hint={t('ui.consoleVinylHint')}>
                <div className="space-y-3.5 px-4 pb-4 pt-3">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleVinylEnabled')}</span>
                        <Toggle
                            checked={immersive.vinyl.enabled}
                            onChange={enabled => setVinyl({ enabled })}
                            label={t('ui.consoleVinylEnabled')}
                        />
                    </div>
                    <ConsoleSlider
                        label={t('ui.consoleVinylNoise')}
                        valueText={formatPercent(immersive.vinyl.noise)}
                        value={immersive.vinyl.noise}
                        min={0}
                        max={1}
                        decimals={2}
                        disabled={!immersive.vinyl.enabled}
                        onChange={noise => setVinyl({ noise })}
                        onCommit={NO_COMMIT}
                    />
                    <ConsoleSlider
                        label={t('ui.consoleVinylCrackle')}
                        valueText={formatPercent(immersive.vinyl.crackle)}
                        value={immersive.vinyl.crackle}
                        min={0}
                        max={1}
                        decimals={2}
                        disabled={!immersive.vinyl.enabled}
                        onChange={crackle => setVinyl({ crackle })}
                        onCommit={NO_COMMIT}
                    />
                    <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleVinylCrackleHint')}</p>
                    <ConsoleSlider
                        label={t('ui.consoleVinylWow')}
                        valueText={formatPercent(immersive.vinyl.wow)}
                        value={immersive.vinyl.wow}
                        min={0}
                        max={1}
                        decimals={2}
                        disabled={!immersive.vinyl.enabled}
                        onChange={wow => setVinyl({ wow })}
                        onCommit={NO_COMMIT}
                    />
                    <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleVinylWowHint')}</p>
                </div>
            </EqualizerSection>

            <EqualizerSection title={t('ui.consoleOrbit')} hint={t('ui.consoleOrbitHint')}>
                <div className="space-y-3.5 px-4 pb-4 pt-3">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleOrbitEnabled')}</span>
                        <Toggle
                            checked={immersive.orbit.enabled}
                            onChange={enabled => setOrbit({ enabled })}
                            label={t('ui.consoleOrbitEnabled')}
                        />
                    </div>
                    <ConsoleSlider
                        label={t('ui.consoleOrbitPeriod')}
                        valueText={formatSeconds(immersive.orbit.periodSec)}
                        value={immersive.orbit.periodSec}
                        min={AUDIO_CONSOLE_ORBIT_PERIOD_MIN}
                        max={AUDIO_CONSOLE_ORBIT_PERIOD_MAX}
                        decimals={1}
                        disabled={!immersive.orbit.enabled}
                        onChange={periodSec => setOrbit({ periodSec })}
                        onCommit={NO_COMMIT}
                    />
                    <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleOrbitPeriodHint')}</p>
                    <ConsoleSlider
                        label={t('ui.consoleOrbitDepth')}
                        valueText={formatPercent(immersive.orbit.depth)}
                        value={immersive.orbit.depth}
                        min={0}
                        max={1}
                        decimals={2}
                        disabled={!immersive.orbit.enabled}
                        onChange={depth => setOrbit({ depth })}
                        onCommit={NO_COMMIT}
                    />
                    <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleOrbitDepthHint')}</p>
                </div>
            </EqualizerSection>

            <EqualizerSection title={t('ui.consoleBass')} hint={t('ui.consoleBassHint')}>
                <div className="space-y-3.5 px-4 pb-4 pt-3">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleBassEnabled')}</span>
                        <Toggle
                            checked={immersive.bass.enabled}
                            onChange={enabled => setBass({ enabled })}
                            label={t('ui.consoleBassEnabled')}
                        />
                    </div>
                    <ConsoleSlider
                        label={t('ui.consoleBassAmount')}
                        valueText={formatPercent(immersive.bass.amount)}
                        value={immersive.bass.amount}
                        min={0}
                        max={1}
                        decimals={2}
                        disabled={!immersive.bass.enabled}
                        onChange={amount => setBass({ amount })}
                        onCommit={NO_COMMIT}
                    />
                    <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleBassAmountHint')}</p>
                    <ConsoleSlider
                        label={t('ui.consoleBassCrossover')}
                        valueText={formatHz(immersive.bass.crossoverHz)}
                        value={immersive.bass.crossoverHz}
                        min={AUDIO_CONSOLE_BASS_CROSSOVER_MIN}
                        max={AUDIO_CONSOLE_BASS_CROSSOVER_MAX}
                        decimals={0}
                        disabled={!immersive.bass.enabled}
                        onChange={crossoverHz => setBass({ crossoverHz })}
                        onCommit={NO_COMMIT}
                    />
                    <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleBassCrossoverHint')}</p>
                </div>
            </EqualizerSection>
        </div>
    );
};

export default ImmersivePane;
