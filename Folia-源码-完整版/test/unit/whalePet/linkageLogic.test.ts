import { describe, expect, it } from 'vitest';
import {
    LYRIC_BUBBLE_MAX_CHARS,
    SITTING_REMINDER_DEFAULT_MINUTES,
    SittingReminderTracker,
    clampSittingReminderMinutes,
    shouldHopOnBeat,
    shouldShowLyricBubble,
    shouldTrackSitting,
    truncateLyricText,
} from '../../../src/whalePet/linkageLogic';

describe('truncateLyricText', () => {
    it('keeps short lines as-is', () => {
        expect(truncateLyricText('你好世界')).toBe('你好世界');
    });

    it('collapses whitespace before truncating', () => {
        expect(truncateLyricText('  a \n b ')).toBe('a b');
    });

    it('truncates to the cap with an ellipsis', () => {
        const long = '一'.repeat(LYRIC_BUBBLE_MAX_CHARS + 10);
        const out = truncateLyricText(long);
        expect(out.length).toBe(LYRIC_BUBBLE_MAX_CHARS);
        expect(out.endsWith('…')).toBe(true);
        expect(out.slice(0, -1)).toBe('一'.repeat(LYRIC_BUBBLE_MAX_CHARS - 1));
    });

    it('returns empty for blank input', () => {
        expect(truncateLyricText('   ')).toBe('');
        expect(truncateLyricText('')).toBe('');
    });
});

describe('clampSittingReminderMinutes', () => {
    it('clamps into 15..120', () => {
        expect(clampSittingReminderMinutes(1)).toBe(15);
        expect(clampSittingReminderMinutes(999)).toBe(120);
        expect(clampSittingReminderMinutes(45)).toBe(45);
    });

    it('rounds to whole minutes', () => {
        expect(clampSittingReminderMinutes(45.6)).toBe(46);
    });
});

describe('SittingReminderTracker', () => {
    it('accumulates only while playing; pausing does not reset', () => {
        const t = new SittingReminderTracker(15);   // 15 分钟
        const min = 60_000;
        for (let i = 0; i < 14; i++) {
            expect(t.tick(min, true)).toBe(false);
            t.tick(min, false);   // 暂停时间不累计、也不清零
        }
        expect(t.tick(min, true)).toBe(true);       // 第 15 分钟到点
        for (let i = 0; i < 14; i++) {
            expect(t.tick(min, true)).toBe(false);  // 重新累计下一个周期
            t.tick(min, false);                     // 暂停同样不清零
        }
        expect(t.tick(min, true)).toBe(true);       // 再满 15 分钟，重复提醒
    });

    it('warns again every interval in a single continuous run', () => {
        const t = new SittingReminderTracker(SITTING_REMINDER_DEFAULT_MINUTES);
        const min = 60_000;
        let reminders = 0;
        for (let i = 0; i < 135; i++) if (t.tick(min, true)) reminders++;
        expect(reminders).toBe(3);   // 45 / 90 / 135 分钟
    });

    it('honours a changed interval from the next tick on', () => {
        const t = new SittingReminderTracker(45);
        t.tick(44 * 60_000, true);
        t.setIntervalMinutes(15);
        expect(t.tick(1 * 60_000, true)).toBe(true);   // 已累计 44 分钟，远超新间隔，立即到点
        expect(t.remainingMs).toBeLessThanOrEqual(15 * 60_000);
    });

    it('reset clears the accumulation', () => {
        const t = new SittingReminderTracker(15);
        t.tick(14 * 60_000, true);
        t.reset();
        expect(t.remainingMs).toBe(15 * 60_000);
    });
});

describe('linkage gating', () => {
    const on = { enabled: true, beatDance: true, lyricBubble: true, sittingReminder: true };

    it('everything off when the pet is disabled', () => {
        expect(shouldHopOnBeat({ ...on, enabled: false }, true)).toBe(false);
        expect(shouldShowLyricBubble({ ...on, enabled: false }, true)).toBe(false);
        expect(shouldTrackSitting({ ...on, enabled: false })).toBe(false);
    });

    it('each feature gated by its own switch, defaults on', () => {
        expect(shouldHopOnBeat({ enabled: true }, true)).toBe(true);
        expect(shouldHopOnBeat({ enabled: true, beatDance: false }, true)).toBe(false);
        expect(shouldHopOnBeat({ enabled: true }, false)).toBe(false);   // 不播放不蹦
        expect(shouldShowLyricBubble({ enabled: true }, true)).toBe(true);
        expect(shouldShowLyricBubble({ enabled: true, lyricBubble: false }, true)).toBe(false);
        expect(shouldShowLyricBubble({ enabled: true }, false)).toBe(false);
        expect(shouldTrackSitting({ enabled: true })).toBe(true);
        expect(shouldTrackSitting({ enabled: true, sittingReminder: false })).toBe(false);
    });
});
