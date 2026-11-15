import { describe, expect, it } from 'vitest';
import type { SongResult } from '@/types';
import { canPlaySongExternally, getOnlineMusicProvider, listOnlineMusicProviders } from '@/services/onlineMusic/providerRegistry';
import { omni } from '@/services/onlineMusic/omni';
import { getAppleMusicTransportAvailability } from '@/services/onlineMusic/appleMusic/appleMusicTransport';

// test/unit/onlineMusic/appleMusicForkWiring.test.ts
// 上游主线是单文件 omni.ts + 自带 hifi 路由；本仓库是 folia-sonnet fork，omni 按能力分组拼装、
// 没有 hifi 引擎。Apple Music 移植后，这条「注册 → 能力 → 外部播放判定 → omni 方法」的接线
// 必须单独验一次：provider 能编译不代表它真的被接进了播放路径。

const appleSong = {
    id: 'apple-catalog-1',
    title: 'Example',
    sourceRef: { kind: 'online', providerId: 'appleMusic', mediaId: 'apple-catalog-1' },
} as unknown as SongResult;

const localSong = {
    id: 'local-1',
    title: 'Local',
    sourceRef: { kind: 'local', mediaId: 'local-1' },
} as unknown as SongResult;

describe('Apple Music fork wiring', () => {
    it('registers Apple Music with external playback instead of URL playback', () => {
        const provider = getOnlineMusicProvider('appleMusic');
        expect(provider).toBeTruthy();
        expect(provider!.capabilities.externalPlayback).toBe(true);
        // Apple 的音频受 DRM 保护，Folia 永远拿不到播放地址。
        expect(provider!.capabilities.playback).toBe(false);
        expect(provider!.externalPlayback).toBeTruthy();
        expect(listOnlineMusicProviders().some(item => item.id === 'appleMusic')).toBe(true);
    });

    it('routes Apple Music songs to the external player but leaves local songs alone', () => {
        expect(canPlaySongExternally(appleSong)).toBe(true);
        expect(canPlaySongExternally(localSong)).toBe(false);
    });

    it('exposes the external playback methods on the assembled omni service', () => {
        const methods = [
            'canPlayExternally', 'playSongExternally', 'pauseExternalPlayback',
            'resumeExternalPlayback', 'seekExternalPlayback', 'getExternalPlaybackStatus',
            'isExternalPlaybackStatusForSong', 'prepareExternalPlaybackQueue',
            'adoptExternalPlayback', 'setExternalPlaybackVolume', 'setExternalPlaybackRepeatOne',
        ] as const;
        for (const name of methods) {
            expect(typeof (omni as unknown as Record<string, unknown>)[name], name).toBe('function');
        }
    });

    it('reports runtime-unavailable without a desktop bridge instead of pretending to work', () => {
        // vitest 跑在 node 环境，没有 window.electron；安卓/Web 端天然不可用。
        const availability = getAppleMusicTransportAvailability();
        expect(availability.configured).toBe(false);
        expect(availability.reason).toBe('runtime-unavailable');
    });
});
