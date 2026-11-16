import { describe, expect, it } from 'vitest';
import { requestAppleMusicOnAndroid, validateAndroidAppleMusicRequest } from '@/services/onlineMusic/appleMusic/android/appleMusicAndroidBridge';
import { getAppleMusicTransportAvailability } from '@/services/onlineMusic/appleMusic/appleMusicTransport';

// test/unit/appleMusic/appleMusicAndroidBridge.test.ts
// 安卓桥的两条底线：① 请求校验与桌面 companionRequests.cjs 的 validateRequest 同一套
// 规则（这里钉几个代表性的形状，两边的规则漂移会在真实请求上变成 invalid-request）；
// ② 不在安卓 App 里时这条路明确说 runtime-unavailable，而不是假装能跑。
// vitest 跑在 node 环境：Capacitor.isNativePlatform() 为 false，正好覆盖「不是宿主」那一支。

describe('the Android Apple Music bridge validation', () => {
    it('normalizes paging like the desktop validator', () => {
        expect(validateAndroidAppleMusicRequest('stations', {})).toEqual({ limit: 20, offset: 0 });
        expect(validateAndroidAppleMusicRequest('personalFm', {})).toEqual({ limit: 2, offset: 0 });
        expect(validateAndroidAppleMusicRequest('playbackStatus', {})).toEqual({});
    });

    it('rejects malformed playback and write requests exactly as the desktop does', () => {
        expect(validateAndroidAppleMusicRequest('seek', { seconds: -1 })).toBeNull();
        expect(validateAndroidAppleMusicRequest('seek', { seconds: 604801 })).toBeNull();
        expect(validateAndroidAppleMusicRequest('setVolume', { volume: 1.5 })).toBeNull();
        expect(validateAndroidAppleMusicRequest('likeSong', { catalogId: 'abc', liked: true })).toBeNull();
        expect(validateAndroidAppleMusicRequest('playSong', { catalogId: '144001', startSec: 0 })).toEqual({ catalogId: '144001', startSec: 0 });
        expect(validateAndroidAppleMusicRequest('playSong', { catalogId: 'x', startSec: 0 })).toBeNull();
        expect(validateAndroidAppleMusicRequest('prepareNext', { catalogId: '1', nextIds: ['1'] })).toBeNull();
        expect(validateAndroidAppleMusicRequest('addPlaylistTracks', { playlistId: 'p.a', catalogIds: [] })).toBeNull();
    });

    it('trims and bounds search queries', () => {
        expect(validateAndroidAppleMusicRequest('search', { query: '  hello  ' })).toEqual({ query: 'hello', offset: 0, limit: 25 });
        expect(validateAndroidAppleMusicRequest('search', { query: '' })).toBeNull();
        expect(validateAndroidAppleMusicRequest('search', { query: 'x'.repeat(201) })).toBeNull();
    });

    it('refuses to run outside the Android app instead of pretending', async () => {
        await expect(requestAppleMusicOnAndroid('accountStatus', {})).resolves.toEqual({ ok: false, error: 'runtime-unavailable' });
        await expect(requestAppleMusicOnAndroid('showWindow', {})).resolves.toEqual({ ok: false, error: 'runtime-unavailable' });
    });
});

describe('the Android Apple Music transport availability', () => {
    it('stays runtime-unavailable in the node test environment (no window.electron, no native host)', () => {
        const availability = getAppleMusicTransportAvailability();
        expect(availability.configured).toBe(false);
        expect(availability.reason).toBe('runtime-unavailable');
    });
});
