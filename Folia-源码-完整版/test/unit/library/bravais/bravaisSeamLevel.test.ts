import { describe, expect, it } from 'vitest';
import {
    applySeamLevel,
    defaultSeamLevel,
    defaultSeamRestoreLevel,
    resolveSeamEscapeLevel,
    resolveSeamLevelOnResize,
    resolveSeamOpenWidth,
    resolveSeamVariant,
    restoreSeamLevel,
    seamVariantWidth,
    useBravaisSeamStore,
} from '@/library/suites/bravais/bravaisSeamLevel';

// test/unit/library/bravais/bravaisSeamLevel.test.ts
// 缝的开口等级状态机（设计稿 §5）：宽屏 full / 窄屏 spine 的默认值、折叠记住折叠前的等级、跨 900px 阈值时
// 非 hidden 的等级回到新宽度的默认值、每层每级的开口宽度与内容形态（翻转时排版宽度跟着渲染的那一套走）。

describe('seam level', () => {
    it('defaults to the full strip on wide screens and the spine below 900px', () => {
        expect(defaultSeamLevel(1280)).toBe('full');
        expect(defaultSeamLevel(900)).toBe('full');
        expect(defaultSeamLevel(899)).toBe('spine');
    });

    it('remembers the level it folded from and restores it', () => {
        let state = applySeamLevel({ level: 'full', restoreLevel: 'full' }, 'spine');
        expect(state).toEqual({ level: 'spine', restoreLevel: 'spine' });
        state = applySeamLevel(state, 'hidden');
        expect(state).toEqual({ level: 'hidden', restoreLevel: 'spine' });
        expect(applySeamLevel(state, 'hidden')).toBe(state);
        expect(restoreSeamLevel(state)).toEqual({ level: 'spine', restoreLevel: 'spine' });
        expect(restoreSeamLevel({ level: 'full', restoreLevel: 'full' })).toEqual({ level: 'full', restoreLevel: 'full' });
    });

    it('returns to the new default only when the width crosses the threshold', () => {
        const spine = { level: 'spine' as const, restoreLevel: 'spine' as const };
        expect(resolveSeamLevelOnResize(spine, 1280, 1100)).toBe(spine);
        expect(resolveSeamLevelOnResize(spine, 1280, 800)).toEqual({ level: 'spine', restoreLevel: 'spine' });
        expect(resolveSeamLevelOnResize({ level: 'full', restoreLevel: 'full' }, 1280, 800)).toEqual({ level: 'spine', restoreLevel: 'spine' });
        expect(resolveSeamLevelOnResize({ level: 'spine', restoreLevel: 'spine' }, 800, 1280)).toEqual({ level: 'full', restoreLevel: 'full' });
        // 折叠着跨阈值：仍是折叠，恢复目标换成新宽度的默认值。
        expect(resolveSeamLevelOnResize({ level: 'hidden', restoreLevel: 'full' }, 1280, 800)).toEqual({ level: 'hidden', restoreLevel: 'spine' });
    });

    it('opens 120 on the home layer, 300 on a collection, 64 as a spine and 0 folded', () => {
        expect(resolveSeamOpenWidth('home', 'full')).toBe(120);
        expect(resolveSeamOpenWidth('collection', 'full')).toBe(300);
        expect(resolveSeamOpenWidth('collection', 'spine')).toBe(64);
        expect(resolveSeamOpenWidth('home', 'spine')).toBe(64);
        expect(resolveSeamOpenWidth('home', 'hidden')).toBe(0);
    });

    it('lays each variant out at its own width', () => {
        expect(resolveSeamVariant('home', 'full')).toBe('home');
        expect(resolveSeamVariant('home', 'spine')).toBe('home-spine');
        expect(resolveSeamVariant('collection', 'full')).toBe('full');
        expect(resolveSeamVariant('collection', 'spine')).toBe('spine');
        expect(resolveSeamVariant('collection', 'hidden')).toBe('none');
        expect(['home', 'home-spine', 'full', 'spine', 'none'].map(variant => seamVariantWidth(variant as never))).toEqual([120, 64, 300, 64, 0]);
    });
});

describe('seam level store', () => {
    it('applies the threshold rule only after the first measurement', () => {
        useBravaisSeamStore.setState({ level: 'full', restoreLevel: 'full', viewportWidth: 0 });
        useBravaisSeamStore.getState().syncViewport(1280);
        expect(useBravaisSeamStore.getState().level).toBe('full');
        useBravaisSeamStore.getState().syncViewport(700);
        expect(useBravaisSeamStore.getState().level).toBe('spine');
        useBravaisSeamStore.getState().setLevel('hidden');
        useBravaisSeamStore.getState().restore();
        expect(useBravaisSeamStore.getState().level).toBe('spine');
    });
});

describe('narrow-screen phone collapse', () => {
    it('defaults the seam to hidden on phone-portrait widths and to the spine just above it', () => {
        expect(defaultSeamLevel(480)).toBe('spine');
        expect(defaultSeamLevel(479)).toBe('hidden');
        expect(defaultSeamLevel(360)).toBe('hidden');
    });

    it('restores to the spine (never the overflowing full strip) on phones', () => {
        expect(defaultSeamRestoreLevel(360)).toBe('spine');
    });

    it('collapses to hidden when the viewport crosses into the phone tier', () => {
        // 宽屏完整信息条收成手机上的隐藏。
        expect(resolveSeamLevelOnResize({ level: 'full', restoreLevel: 'full' }, 1280, 400))
            .toEqual({ level: 'hidden', restoreLevel: 'spine' });
        // 书脊从窄屏跨进手机：缝藏起，恢复目标仍是书脊。
        expect(resolveSeamLevelOnResize({ level: 'spine', restoreLevel: 'spine' }, 800, 400))
            .toEqual({ level: 'hidden', restoreLevel: 'spine' });
        // 已在隐藏、从宽屏跨进手机：仍是隐藏，恢复目标换成书脊。
        expect(resolveSeamLevelOnResize({ level: 'hidden', restoreLevel: 'full' }, 1280, 400))
            .toEqual({ level: 'hidden', restoreLevel: 'spine' });
    });

    it('expands back out of the phone tier to the new-width default', () => {
        // 手机上展开（折叠态跨阈值）：保持隐藏，恢复目标换成宽屏的完整信息条。
        expect(resolveSeamLevelOnResize({ level: 'hidden', restoreLevel: 'spine' }, 400, 1280))
            .toEqual({ level: 'hidden', restoreLevel: 'full' });
        // 手机上展开到窄屏：书脊。
        expect(resolveSeamLevelOnResize({ level: 'spine', restoreLevel: 'spine' }, 400, 800))
            .toEqual({ level: 'spine', restoreLevel: 'spine' });
        // 没跨阈值（都在手机内）就不动。
        const phone = { level: 'hidden' as const, restoreLevel: 'spine' as const };
        expect(resolveSeamLevelOnResize(phone, 400, 420)).toBe(phone);
    });

    it('steps the full strip back to the spine on a phone Esc, not to hidden', () => {
        expect(resolveSeamEscapeLevel('full', 360)).toBe('spine');
        expect(resolveSeamEscapeLevel('full', 1280)).toBeNull();
    });

    it('collapses the seam store to hidden on a phone and restores to the spine', () => {
        useBravaisSeamStore.setState({ level: 'full', restoreLevel: 'full', viewportWidth: 0 });
        useBravaisSeamStore.getState().syncViewport(1280); // 第一次只记录宽度，等级不变
        useBravaisSeamStore.getState().syncViewport(360); // 宽屏跨进手机：折叠
        expect(useBravaisSeamStore.getState().level).toBe('hidden');
        useBravaisSeamStore.getState().setLevel('hidden');
        useBravaisSeamStore.getState().restore();
        expect(useBravaisSeamStore.getState().level).toBe('spine');
    });
});
