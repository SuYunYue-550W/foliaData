import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Row, Toggle, Slider, Button } from './kit';
import { getWhalePet, WHALE_PET_SIZE_KEY, whalePetDefaultSize } from '../../../whalePet/init';
import { clampSittingReminderMinutes } from '../../../whalePet/linkageLogic';
import {
    isWhalePetSupported,
    canDrawOverlay,
    openOverlaySettings,
    openNotificationSettings,
    startWhalePet,
    stopWhalePet,
    isWhalePetRunning,
} from '../../../whalePet/floating';
import {
    isDesktopPetHost,
    startDesktopPet,
    stopDesktopPet,
    mirrorDesktopPet,
} from '../../../whalePet/desktop';

// 鲸鱼桌宠设置：开关 / 大小 / 不透明度 / 行为开关 / 复位位置。
// 状态与 pet.js 的 localStorage 持久化共用同一个 key，改完刷新仍生效。

type PetSettings = {
    enabled: boolean;
    size: number;
    x?: number;
    y?: number;
    tips?: boolean;
    idle?: boolean;
    dragAnim?: boolean;
    opacity?: number;
    splash?: boolean;
    beatDance?: boolean;
    lyricBubble?: boolean;
    sittingReminder?: boolean;
    sittingReminderMin?: number;

    roam?: boolean;
    roamSpeed?: number;
    duckBehindModal?: boolean;
};

const DEFAULTS: PetSettings = {
    enabled: true,
    size: 240,
    tips: true,
    idle: true,
    dragAnim: true,
    opacity: 1,
    splash: true,
    beatDance: true,
    lyricBubble: true,
    sittingReminder: true,
    sittingReminderMin: 45,
    roam: false,
    roamSpeed: 60,
    duckBehindModal: true,
};

const SIZE_MIN = 100;
const SIZE_MAX = 420;

const readSettings = (): PetSettings => {
    try {
        const raw = JSON.parse(localStorage.getItem(WHALE_PET_SIZE_KEY) || 'null');
        if (raw && typeof raw.enabled === 'boolean') {
            return {
                ...DEFAULTS,
                ...raw,
                size: typeof raw.size === 'number' ? raw.size : whalePetDefaultSize(),
            };
        }
    } catch { /* 忽略坏数据 */ }
    return { ...DEFAULTS, size: whalePetDefaultSize() };
};

const WhalePetSetting: React.FC = () => {
    const { t } = useTranslation();
    const [settings, setSettings] = useState<PetSettings>(readSettings);
    // 保存最新快照：apply 需要在 setSettings 之外读到合并后的值，且不能把副作用
    // 写进函数式 updater（React.StrictMode 会双调用 updater，导致 applySettings / IPC 执行两遍）。
    const settingsRef = useRef(settings);
    useEffect(() => { settingsRef.current = settings; }, [settings]);

    useEffect(() => {
        const onStorage = (e: StorageEvent) => {
            if (e.key === WHALE_PET_SIZE_KEY) setSettings(readSettings());
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const apply = useCallback((next: Partial<PetSettings>) => {
        const merged = { ...settingsRef.current, ...next };
        settingsRef.current = merged;
        setSettings(merged);
        const pet = getWhalePet() as any;
        if (!pet) return;
        // 桌宠实例可能被 destroy 后重建；每次都重新挂镜像，避免置顶窗口静默失联。
        mirrorDesktopPet();
        pet.applySettings({
            enabled: merged.enabled,
            size: merged.size,
            tips: merged.tips,
            idle: merged.idle,
            dragAnim: merged.dragAnim,
            opacity: merged.opacity,
            splash: merged.splash,
            beatDance: merged.beatDance,
            lyricBubble: merged.lyricBubble,
            sittingReminder: merged.sittingReminder,
            sittingReminderMin: merged.sittingReminderMin,
            roam: merged.roam,
            roamSpeed: merged.roamSpeed,
            duckBehindModal: merged.duckBehindModal,
        });
        // 悬浮窗开启期间，应用内鲸鱼仅「运行时隐藏」，绝不改写持久化的 enabled。
        if (floatingRef.current && pet.root) {
            pet.root.classList.add('whale-pet--hidden');
            try { pet.video?.pause?.(); } catch { /* ignore */ }
            clearTimeout(pet._timer);
        }
    }, []);

    const resetPosition = useCallback(() => {
        mirrorDesktopPet();
        const pet = getWhalePet();
        pet?.resetPos?.();
        setSettings(readSettings());
    }, []);

    const opacityPct = Math.round((settings.opacity ?? 1) * 100);

    // 系统级浮层（Android 悬浮窗 / 桌面端置顶窗口）：桌宠即浮层鲸鱼，能显示在其他应用之上。
    // 全局只有「一只鲸鱼」，因此不再有独立的「悬浮窗模式」开关 —— 桌宠开关即唯一权威。
    const floatingSupported = isWhalePetSupported();
    const overlayMode = floatingSupported || isDesktopPetHost();
    // 这些项依赖应用内 DOM 桌宠的交互层，系统级窗口下不生效，明确告知避免误以为坏了。
    const overlayHint = overlayMode ? '（当前为系统级窗口，该项不生效）' : '';
    const [floating, setFloating] = useState(false);
    const floatingRef = useRef(false);
    useEffect(() => { floatingRef.current = floating; }, [floating]);

    // 同步浮层运行态（设置页打开时回显当前是否在浮层）
    useEffect(() => {
        if (!floatingSupported) return;
        let alive = true;
        isWhalePetRunning().then(r => { if (alive) setFloating(r); }).catch(() => {});
        return () => { alive = false; };
    }, [floatingSupported]);

    // 权限授予后自动浮起：用户从系统设置授予悬浮窗权限返回后，
    // 若已开启桌宠且浮层未运行，则自动把鲸鱼浮起来（避免「开了桌宠却看不到鲸鱼」的死胡同）。
    useEffect(() => {
        if (!floatingSupported || !settings.enabled || floatingRef.current) return;
        let alive = true;
        (async () => {
            const granted = await canDrawOverlay();
            if (alive && granted && !floatingRef.current) {
                const res = await startWhalePet({ ...settings, enabled: true });
                if (res.running) setFloating(true);
            }
        })();
        return () => { alive = false; };
    }, [floatingSupported, settings.enabled]);

    return (
        <>
            <Row
                label="鲸鱼桌宠"
                note="鲸鱼桌宠显示在一个系统级置顶窗口里，能浮在其他应用之上（Android 悬浮窗 / 桌面端置顶窗口）。每次进入应用随机播放一个登场动作；播放音乐时跳舞，暂停时安静待机；单击有回应，双击有彩蛋；可拖到任意位置并记住。"
            >
                <Toggle
                    checked={settings.enabled}
                    onChange={async () => {
                        const next = !settings.enabled;
                        apply({ enabled: next });
                        // 桌面端走独立入口：置顶窗口由主进程管理，与 Android 浮层桥无关。
                        // 关闭必须销毁窗口（否则会留下一个透明但可拖拽的空命中层），
                        // 打开则不带开屏地按上次落点重建。
                        if (isDesktopPetHost()) {
                            if (!next) { stopDesktopPet(); return; }
                            startDesktopPet({ ...settingsRef.current, enabled: true }, { splash: false });
                            return;
                        }
                        // 关闭桌宠 → 收起浮层鲸鱼（同一个实体，全局仅一只）
                        if (!next) {
                            if (floatingRef.current) setFloating(false);
                            await stopWhalePet();
                            return;
                        }
                        // 打开桌宠（Android 上即浮层鲸鱼，浮在其他应用之上）
                        if (!floatingSupported) return;
                        const granted = await canDrawOverlay();
                        if (!granted) {
                            // 先要悬浮窗权限：引导去系统设置，授权后由上面的 effect 自动浮起
                            await openOverlaySettings();
                            return;
                        }
                        const res = await startWhalePet({ ...settingsRef.current, enabled: true });
                        if (res.running) {
                            setFloating(true);
                        } else if (res.notify === false) {
                            await openNotificationSettings();
                        } else if (!res.granted) {
                            await openOverlaySettings();
                        } else {
                            setFloating(false);
                        }
                    }}
                />
            </Row>

            <Row label="大小" note={`${Math.round(settings.size)} px`}>
                <Slider
                    value={Math.round(settings.size)}
                    min={SIZE_MIN}
                    max={SIZE_MAX}
                    step={4}
                    onChange={v => apply({ size: v })}
                    format={v => `${v}px`}
                    marks={[
                        { value: 170, label: '小' },
                        { value: 240, label: '中' },
                        { value: 320, label: '大' },
                    ]}
                    stacked
                />
            </Row>

            <Row label="不透明度" note={`${opacityPct}%`}>
                <Slider
                    value={opacityPct}
                    min={30}
                    max={100}
                    step={5}
                    onChange={v => apply({ opacity: v / 100 })}
                    format={v => `${v}%`}
                    stacked
                />
            </Row>

            <Row label="位置" note="拖到想要的位置即可，位置会自动记住">
                <Button variant="fill" onClick={resetPosition}>回到顶部居中</Button>
            </Row>

            <Row label="开屏动画" note="进入应用时全屏鲸鱼开屏；关闭则直接进主页面">
                <Toggle
                    checked={settings.splash !== false}
                    onChange={() => apply({ splash: !(settings.splash !== false) })}
                />
            </Row>

            <Row label="动作气泡" note="动作名称、提示文字的气泡">
                <Toggle
                    checked={settings.tips !== false}
                    onChange={() => apply({ tips: !(settings.tips !== false) })}
                />
            </Row>

            <Row label="空闲时自己动" note="不操作时随机播放日常/趣味动作">
                <Toggle
                    checked={settings.idle !== false}
                    onChange={() => apply({ idle: !(settings.idle !== false) })}
                />
            </Row>

            <Row label={t('whalePet.roam')} note={`${t('whalePet.roamNote')}${overlayHint}`}>
                <Toggle
                    checked={settings.roam !== false}
                    onChange={() => apply({ roam: !(settings.roam !== false) })}
                />
            </Row>

            <Row label={t('whalePet.roamSpeed')} note={`${settings.roamSpeed ?? 60}${overlayHint}`}>
                <Slider
                    value={settings.roamSpeed ?? 60}
                    min={30}
                    max={120}
                    step={5}
                    onChange={v => apply({ roamSpeed: v })}
                    format={v => `${v}`}
                    marks={[
                        { value: 30, label: '慢' },
                        { value: 60, label: '中' },
                        { value: 120, label: '快' },
                    ]}
                    stacked
                />
            </Row>

            <Row label={t('whalePet.alwaysOnTop')} note={`${t('whalePet.alwaysOnTopNote')}${overlayHint}`}>
                <Toggle
                    checked={settings.duckBehindModal === false}
                    onChange={() => apply({ duckBehindModal: !(settings.duckBehindModal === false) })}
                />
            </Row>

            <Row label="拖动时换动作" note={`拖起桌宠时切换成「被拖起来」的动画${overlayHint}`}>
                <Toggle
                    checked={settings.dragAnim !== false}
                    onChange={() => apply({ dragAnim: !(settings.dragAnim !== false) })}
                />
            </Row>

            <Row label={t('whalePet.beatDance')} note={t('whalePet.beatDanceNote')}>
                <Toggle
                    checked={settings.beatDance !== false}
                    onChange={() => apply({ beatDance: !(settings.beatDance !== false) })}
                />
            </Row>

            <Row label={t('whalePet.lyricBubble')} note={t('whalePet.lyricBubbleNote')}>
                <Toggle
                    checked={settings.lyricBubble !== false}
                    onChange={() => apply({ lyricBubble: !(settings.lyricBubble !== false) })}
                />
            </Row>

            <Row label={t('whalePet.sittingReminder')} note={t('whalePet.sittingReminderNote')}>
                <Toggle
                    checked={settings.sittingReminder !== false}
                    onChange={() => apply({ sittingReminder: !(settings.sittingReminder !== false) })}
                />
            </Row>

            <Row label={t('whalePet.sittingReminderInterval')} note={`${settings.sittingReminderMin ?? 45} min`}>
                <Slider
                    value={clampSittingReminderMinutes(settings.sittingReminderMin ?? 45)}
                    min={15}
                    max={120}
                    step={5}
                    onChange={v => apply({ sittingReminderMin: clampSittingReminderMinutes(v) })}
                    format={v => `${v} min`}
                    marks={[
                        { value: 15, label: '15' },
                        { value: 45, label: '45' },
                        { value: 120, label: '120' },
                    ]}
                    stacked
                />
            </Row>

        </>
    );
};

export default WhalePetSetting;
