// 桌宠联动扩展的纯逻辑（无 DOM / 无 store 依赖，可单测）：
//   - 歌词截断
//   - 久坐提醒计时的状态机（只在播放时累计，暂停不重置，到点提醒后重新累计）
//   - 开关门控判断
// src/whalePet/linkage.ts 是接 store / beatFx 的运行时壳。

/** 气泡里一句歌词最多显示多少个字符（半角全角都按 1 计）。 */
export const LYRIC_BUBBLE_MAX_CHARS = 20;

/** 久坐提醒间隔的合法范围（分钟）。 */
export const SITTING_REMINDER_MIN_MINUTES = 15;
export const SITTING_REMINDER_MAX_MINUTES = 120;
export const SITTING_REMINDER_DEFAULT_MINUTES = 45;

/** 把一个设置值夹回合法的提醒间隔。 */
export const clampSittingReminderMinutes = (value: number): number =>
    Math.max(SITTING_REMINDER_MIN_MINUTES,
        Math.min(SITTING_REMINDER_MAX_MINUTES, Math.round(value)));

/** 歌词行文本 → 气泡文本：压掉空白，超长截断加省略号。 */
export const truncateLyricText = (text: string, max = LYRIC_BUBBLE_MAX_CHARS): string => {
    const flat = (text || '').replace(/\s+/g, ' ').trim();
    if (flat.length <= max) return flat;
    return flat.slice(0, max - 1) + '…';
};

/**
 * 久坐提醒状态机：`tick(deltaMs, playing)` 只在 playing 时累计，暂停不重置；
 * 累计满一个间隔返回 true（该提醒了）并自动开始下一个周期的累计，
 * 所以连续播放会每过一个间隔提醒一次。间隔可通过 `setIntervalMinutes` 随时改。
 */
export class SittingReminderTracker {
    private intervalMs: number;
    private accumulatedMs = 0;

    constructor(intervalMinutes = SITTING_REMINDER_DEFAULT_MINUTES) {
        this.intervalMs = clampSittingReminderMinutes(intervalMinutes) * 60_000;
    }

    setIntervalMinutes(minutes: number): void {
        this.intervalMs = clampSittingReminderMinutes(minutes) * 60_000;
    }

    /** 到下一个提醒还差多少毫秒；负数不会出现（到点即提醒并重新累计）。 */
    get remainingMs(): number {
        return Math.max(0, this.intervalMs - this.accumulatedMs);
    }

    reset(): void {
        this.accumulatedMs = 0;
    }

    tick(deltaMs: number, playing: boolean): boolean {
        if (!playing || deltaMs <= 0) return false;
        this.accumulatedMs += deltaMs;
        if (this.accumulatedMs < this.intervalMs) return false;
        this.accumulatedMs -= this.intervalMs;
        return true;
    }
}

/** 联动功能的开关集合（与 pet.js settings 里的新增字段一一对应）。 */
export interface WhalePetLinkageSettings {
    enabled?: boolean;
    beatDance?: boolean;
    lyricBubble?: boolean;
    sittingReminder?: boolean;
    sittingReminderMin?: number;
}

/** 桌宠整体关了，联动全部不跑。 */
export const isLinkageAlive = (settings: WhalePetLinkageSettings): boolean =>
    settings.enabled !== false;

export const shouldHopOnBeat = (settings: WhalePetLinkageSettings, playing: boolean): boolean =>
    isLinkageAlive(settings) && settings.beatDance !== false && playing;

export const shouldShowLyricBubble = (settings: WhalePetLinkageSettings, playing: boolean): boolean =>
    isLinkageAlive(settings) && settings.lyricBubble !== false && playing;

export const shouldTrackSitting = (settings: WhalePetLinkageSettings): boolean =>
    isLinkageAlive(settings) && settings.sittingReminder !== false;
