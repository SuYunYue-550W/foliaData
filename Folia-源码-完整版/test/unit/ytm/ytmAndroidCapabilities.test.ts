// @vitest-environment jsdom
// YTM 在 Android 端开放的能力，必须与已移植的 operation 对齐。
// 三个资料库读操作（user_playlists / user_albums / playlist）已实现，
// 其余写操作与 explore 仍未移植 —— 能力 flag 不能超前点亮。
import { describe, expect, it, vi } from 'vitest';

const android = vi.hoisted(() => ({ value: false }));
vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => android.value, getPlatform: () => (android.value ? 'android' : 'web') },
    registerPlugin: () => ({}),
}));

describe('YTM Android 能力声明', () => {
    it('只开放已移植的账号能力，未移植的保持关闭', async () => {
        android.value = true;
        const { ytmProvider } = await import('@/services/onlineMusic/ytm/ytmProvider');
        const c = ytmProvider.capabilities!;
        expect(c.userLibrary).toBe(true);
        expect(c.userAlbums).toBe(true);
        expect(c.recommendations).toBe(true);
        expect(c.playlists).toBe(true);
        // 尚未移植
        expect(c.explore).toBe(false);
        expect(c.mutations).toBe(false);
        expect(c.playlistTrackMutations).toBe(false);
        expect(c.likes).toBe(false);
        expect(c.playlistSubscription).toBe(false);
    });
});
