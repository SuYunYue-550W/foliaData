// 鲸鱼桌宠（Whale Pet）运行时入口。
// 资源来自 luweiyabo/dsh-whale-pet 的 95 个透明 WebM 动画；pet.js 是零依赖播放器。
// 挂载后：随机登场动画 → 固定悬浮页面顶部 → 播放状态联动 → 空闲自主行为。
import './pet.js';
import { usePlaybackStore, selectDisplayPlayerState } from '../stores/usePlaybackStore';
import { PlayerState } from '../types';
import { WHALE_PET_ANIMS } from './catalog';
import { attachWhalePetLinkage, detachWhalePetLinkage } from './linkage';
// Android 浮层模式：主 WebView 不渲染桌宠 DOM，所有操作经代理转发到浮层鲸鱼（全局仅一只）。
import { isWhalePetSupported, invokeWhale, isSplashFloatingMode, animateWhaleToRest } from './floating';

export interface WhalePetInstance {
    settings: {
        enabled: boolean; size: number; x: number; y: number;
        tips: boolean; idle: boolean; dragAnim: boolean; opacity: number; splash: boolean;
        /** 联动扩展：鼓点起舞 / 歌词气泡 / 久坐提醒（间隔分钟） */
        beatDance?: boolean; lyricBubble?: boolean;
        sittingReminder?: boolean; sittingReminderMin?: number;
        /** 屏幕漫游 / 置顶：roam 自主游走、roamSpeed 速度、duckBehindModal 弹窗遮挡时是否隐身 */
        roam?: boolean; roamSpeed?: number; duckBehindModal?: boolean;
    };
    react: (event: string) => void;
    boot: () => void;
    play: (spec: string, opts?: { once?: boolean; label?: string }) => void;
    applySettings: (s: {
        enabled?: boolean; size?: number;
        tips?: boolean; idle?: boolean; dragAnim?: boolean; opacity?: number; splash?: boolean;
        beatDance?: boolean; lyricBubble?: boolean;
        sittingReminder?: boolean; sittingReminderMin?: number;
        roam?: boolean; roamSpeed?: number; duckBehindModal?: boolean;
    }) => void;
    resetPos?: () => void;
    /** 交互/空闲落定回调：宿主注入，按播放状态恢复正确动画 */
    onSettle?: () => void;
    destroy?: () => void;
    /** 联动扩展的气泡接口（pet.js 暴露） */
    showTip?: (text: string) => void;
    /** 节拍脉冲（pet.js 暴露，鼓点起舞用） */
    pulse?: () => void;
}

declare global {
    interface Window {
        WhalePet?: new (opts: Record<string, unknown>) => WhalePetInstance;
        __whalePet?: WhalePetInstance | null;
    }
}

export const WHALE_PET_ASSET_BASE = 'whale-pet/thumb';
/** 屏幕三档自适应：手机 <600 / 平板 600-1023 / 桌面 >=1024（按视口宽度） */
export const whalePetDefaultSize = (): number => {
    if (typeof window === 'undefined') return 240;
    const w = window.innerWidth;
    if (w < 600) return 170;
    if (w < 1024) return 200;
    return 240;
};

/**
 * 桌宠在视口里的目标矩形（开屏飞向这里）。
 * 位置来自 localStorage 的 x/y（与 pet.js 同一个 key），尺寸按当前视口档位。
 */
export function whalePetTargetRect(): { centerX: number; top: number; size: number } {
    let x = 0, y = 0;
    try {
        const raw = JSON.parse(localStorage.getItem(WHALE_PET_SIZE_KEY) || 'null');
        if (raw) { x = Number(raw.x) || 0; y = Number(raw.y) || 0; }
    } catch { /* 用默认 */ }
    const size = whalePetDefaultSize();
    return { centerX: window.innerWidth / 2 + x, top: Math.max(0, y), size };
}
export const WHALE_PET_SIZE_KEY = 'whale-pet-settings';

/**
 * Android 浮层模式下的「桌宠实例」代理：主 WebView 根本不渲染桌宠 DOM，所有方法调用
 * 都经 invokeWhale 转发到浮层 WebView 里的那只鲸鱼（window.__whalePet）。这样全局
 * 只有「一只鲸鱼」，不会出现「应用内一只 + 浮层又一只」的重复显示。
 *
 * 代理本地也保留一份 settings 副本，供联动层（鼓点/歌词/久坐）按当前开关做门控判断
 * （联动层只读 pet.settings，不写），applySettings 同时更新本地副本与浮层鲸鱼。
 */
function createFloatingProxy(): WhalePetInstance {
    // 与设置页 / 浮层 pet 共用同一个 localStorage key 初始化，避免重启后
    // 联动门控（鼓点/歌词/久坐）按默认全开跑，与浮层侧保存的设置不一致。
    let stored: Record<string, unknown> = {};
    try { stored = JSON.parse(localStorage.getItem('whale-pet-settings') || '{}') || {}; } catch { /* 忽略坏数据 */ }
    const settings = {
        enabled: true,
        size: whalePetDefaultSize(),
        x: 0,
        y: 0,
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
    } as WhalePetInstance['settings'];
    Object.assign(settings, stored);
    // 浮层位置由原生 WindowManager 管理，代理不参与 x/y。
    settings.x = 0; settings.y = 0;
    const fwd = (method: string, ...args: unknown[]) => {
        void invokeWhale(method, args);
    };
    const proxy = {
        settings,
        react: (event: string) => fwd('react', event),
        boot: () => fwd('boot'),
        play: (spec: string, opts?: { once?: boolean; label?: string }) => fwd('play', spec, opts),
        applySettings: (s: Record<string, unknown>) => {
            Object.assign(settings, s);
            fwd('applySettings', s);
        },
        resetPos: () => fwd('resetPos'),
        showTip: (text: string) => fwd('showTip', text),
        pulse: () => fwd('pulse'),
        poke: () => fwd('poke'),
        destroy: () => fwd('destroy'),
        takeOver: (target: unknown, animId: string) => fwd('takeOver', target, animId),
    } as unknown as WhalePetInstance;
    return proxy;
}

/** 播放状态订阅的退订函数：模块级保存，重建桌宠时先退订旧的，避免重复订阅泄漏 */
let unsubscribePlayback: (() => void) | null = null;

/** 桌宠可用即创建并启动（幂等）。initialAnim：接续开屏的那段动画。 */
export function ensureWhalePet(opts?: { initialAnim?: string }): WhalePetInstance | null {
    if (typeof window === 'undefined' || window.__whalePet) {
        return window.__whalePet ?? null;
    }
    // 系统级浮层模式（Android / Electron 桌面端）：不渲染 DOM，返回转发代理（全局仅浮层一只鲸鱼）
    if (isWhalePetSupported()) {
        const proxy = createFloatingProxy();
        window.__whalePet = proxy;
        // 播放状态联动也要转发到浮层窗口：播放 → 跳舞/演奏，暂停 → 待机。
        // 此前浮层分支漏了这一层，导致浮层鲸鱼不会随音乐起舞（只剩空闲随机动作）。
        let lastFloatingState: PlayerState | null = null;
        try {
            unsubscribePlayback?.();
            unsubscribePlayback = usePlaybackStore.subscribe((state) => {
                const current = selectDisplayPlayerState(state);
                if (current === lastFloatingState) return;
                lastFloatingState = current;
                if (!proxy.settings.enabled) return;
                if (current === PlayerState.PLAYING) proxy.react('play_music');
                else if (current === PlayerState.PAUSED) proxy.react('pause_music');
            });
        } catch { /* 订阅失败不影响桌宠显示 */ }
        // 联动扩展（鼓点/歌词/久坐）仍挂到代理上，通过 invokeWhale 落到浮层鲸鱼
        attachWhalePetLinkage(proxy);
        return proxy;
    }
    if (!window.WhalePet) {
        return null;
    }
    const pet = new window.WhalePet({
        assetBase: WHALE_PET_ASSET_BASE,
        animList: WHALE_PET_ANIMS,
        introHoldSec: 3.0,   // 登场动作播放约 3 秒
        size: whalePetDefaultSize(),
        initialAnim: opts?.initialAnim,   // 有值时跳过随机登场，直接续播（开屏过渡用）
        idleMinMs: 20000,
        idleMaxMs: 42000,
    });
    window.__whalePet = pet;

    // 播放状态联动：播放 → 跳舞/演奏，暂停 → 待机/日常
    let lastState: PlayerState | null = null;
    try {
        // 已有旧订阅（理论上 destroy 后才可能走到这里）：先退订，防重复
        unsubscribePlayback?.();
        unsubscribePlayback = usePlaybackStore.subscribe((state) => {
            const current = selectDisplayPlayerState(state);
            if (current === lastState) return;
            lastState = current;
            if (!pet.settings.enabled) return;
            if (current === PlayerState.PLAYING) pet.react('play_music');
            else if (current === PlayerState.PAUSED) pet.react('pause_music');
        });
    } catch (e) {
        console.warn('[whalePet] 播放状态订阅失败，桌宠将不联动播放器', e);
    }

    // 落定回调：拖动/点击/登场等交互结束后，按当前播放状态恢复正确动画——
    // 音乐在放就回到跳舞，没放才播日常/待机。否则拖完会停在"暂停系"动画里。
    pet.onSettle = () => {
        if (!pet.settings.enabled) return;
        if (lastState === PlayerState.PLAYING) pet.react('play_music');
        else pet.react('idle');
    };

    // 联动扩展（鼓点起舞 / 歌词气泡 / 久坐提醒）：随实例挂载，destroy 时一并退订
    attachWhalePetLinkage(pet);
    const originalDestroy = pet.destroy?.bind(pet);
    pet.destroy = () => {
        detachWhalePetLinkage();
        originalDestroy?.();
    };

    return pet;
}

export function getWhalePet(): WhalePetInstance | null {
    return (typeof window !== 'undefined' && window.__whalePet) || null;
}

/**
 * 开屏鲸鱼飞到位 → 桌宠接管（位置/尺寸/动画进度全部对齐）。
 * splash.ts 通过这个钩子拿到 takeOver，避免它与桌宠实例互相耦合。
 */
export let attachWhaleSplashTakeover:
    | ((target: { centerX: number; top: number; size: number; time?: number }, animId: string) => void | Promise<void>)
    | undefined;

export function bindWhaleSplashTakeover(): void {
    attachWhaleSplashTakeover = (target, animId) => {
        (window as { __whaleSplashTookOver?: boolean }).__whaleSplashTookOver = true;
        if (isSplashFloatingMode()) {
            // 浮层模式：**开屏那只鲸鱼就是浮层窗口本身**，屏幕上从头到尾只有一个渲染源。
            // 此刻启动它的窗口几何过渡：从「屏幕中央放大态」连续变换到常驻落点，视频全程
            // 不中断。没有接管、没有交叉淡化、没有坐标换算，因此不会闪帧、不会重叠成两只，
            // 更不会在过渡结束后「再向下移动一段距离」（终点就是原生算好的落点）。
            //
            // 返回 Promise：主 WebView 等原生确认动画已启动，再让黑幕渐隐，保证界面浮现
            // 与鲸鱼飞行同步开始、同时结束。
            return animateWhaleToRest(680);   // 与 splash.ts 的 MORPH_MS 一致（黑幕渐隐同长）
        }
        // 非浮层：主 WebView 自有桌宠，交给 pet.js 的 takeOver 瞬移到目标矩形并续播同段动画。
        const pet = ensureWhalePet({ initialAnim: animId }) as unknown as {
            takeOver?: (t: typeof target, id: string) => void;
        } | null;
        pet?.takeOver?.(target, animId);
    };
}
