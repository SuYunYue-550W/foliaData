import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/kugouHighTierIntegration.test.ts
//
// The desktop (Electron) path is the only one that may send the platform's own tier strings.
// These tests pin down the part the pure-function tests cannot see: that the high tiers are
// *inside* the ordinary degradation loop, so a timeout still short-circuits the whole chain
// instead of being swallowed by a separate probe loop.

const requestMock = vi.hoisted(() => vi.fn());
const anonymousSearchMock = vi.hoisted(() => vi.fn());
const legacyPlayInfoMock = vi.hoisted(() => vi.fn());
const transportState = vi.hoisted(() => ({ hasAuthenticatedSearchSession: true }));
const runtimeState = vi.hoisted(() => ({ electron: true }));

vi.mock('@/platform/runtime', async importOriginal => ({
    ...await importOriginal<typeof import('@/platform/runtime')>(),
    hasElectronBridge: () => runtimeState.electron,
}));

vi.mock('@/services/onlineMusic/kugou/kugouTransport', async importOriginal => ({
    ...await importOriginal<typeof import('@/services/onlineMusic/kugou/kugouTransport')>(),
    getKugouTransportAvailability: () => ({ configured: true, reason: 'electron' }),
    hasKugouAuthenticatedSearchSession: () => transportState.hasAuthenticatedSearchSession,
    requestKugouAnonymousSearch: anonymousSearchMock,
    requestKugou: requestMock,
    requestKugouLegacyPlayInfo: legacyPlayInfoMock,
}));

vi.mock('@/services/onlineMusic/providerStorage', () => ({
    readProviderSessionValue: () => 'desktop-session-user',
    removeProviderSessionValue: vi.fn(),
}));

import { kugouProvider, normalizeKugouSong } from '@/services/onlineMusic/kugou/kugouProvider';
import { OnlineProviderError } from '@/types/onlineMusic';

// Mirrors the bridge's real timeout error so isKugouTimeout() classifies it as unreachable.
const timeoutError = () => new OnlineProviderError(
    'network',
    'KuGou request failed (operation=song_url): ETIMEDOUT: connect ETIMEDOUT 1.2.3.4:443',
    'kugou',
    new Error("Error invoking remote method 'kugou-api-request': KuGouApiError: KuGouApi[operation=song_url]: ETIMEDOUT: connect ETIMEDOUT 1.2.3.4:443"),
);

const plainSong = () => normalizeKugouSong({ FileHash: 'hash', SongName: 'Song' });

const askedQualities = (): unknown[] => requestMock.mock.calls.map(call => call[1]?.quality);

describe('kugouProvider · Electron 桌面平台专属高档', () => {
    beforeEach(async () => {
        runtimeState.electron = true;
        transportState.hasAuthenticatedSearchSession = true;
        requestMock.mockReset();
        requestMock.mockResolvedValue(undefined);
        anonymousSearchMock.mockReset();
        legacyPlayInfoMock.mockReset();
        // Logout itself may issue a request (without a `quality`). Reset once more afterwards so
        // askedQualities() sees only the /song/url calls made by getAudioSource.
        await kugouProvider.auth?.logout?.();
        requestMock.mockReset();
        requestMock.mockResolvedValue(undefined);
    });

    it('hires 优先问蝰蛇母带与全景声，命中时记录 sourceTier 且保持全局档位', async () => {
        requestMock.mockResolvedValueOnce({
            data: { play_url: 'https://example.test/master.flac' },
        });

        const source = await kugouProvider.playback!.getAudioSource(plainSong(), 'hires');

        expect(askedQualities()).toEqual(['viper_tape']);
        expect(source).toMatchObject({
            url: 'https://example.test/master.flac',
            quality: 'hires',
            sourceTier: 'viper_tape',
        });
    });

    it('高档都没给 URL 时，按同一条链继续降级到常规档', async () => {
        requestMock
            .mockResolvedValueOnce({ data: {} })
            .mockResolvedValueOnce({ data: {} })
            .mockResolvedValueOnce({ data: { play_url: 'https://example.test/high.mp3' } });

        const source = await kugouProvider.playback!.getAudioSource(plainSong(), 'hires');

        expect(askedQualities()).toEqual(['viper_tape', 'viper_atmos', 'high']);
        expect(source).toMatchObject({ quality: 'hires', url: 'https://example.test/high.mp3' });
    });

    // The regression this suite exists for: a separate probe loop swallowed the timeout and kept
    // asking, turning the guard's single request into three. Inside the shared loop it must stop.
    it('高档请求超时时立即短路整条 /song/url 链，legacy 兜底仍只问一次', async () => {
        requestMock.mockRejectedValue(timeoutError());
        legacyPlayInfoMock.mockRejectedValue(
            new OnlineProviderError('network', 'KuGou legacy playInfo failed', 'kugou'),
        );

        const error = await kugouProvider.playback!.getAudioSource(plainSong(), 'hires').catch(caught => caught);

        expect(requestMock).toHaveBeenCalledTimes(1);
        expect(legacyPlayInfoMock).toHaveBeenCalledTimes(1);
        expect(kugouProvider.describeFailure?.('audio', error)).toEqual({ case: 'unreachable' });
    });

    it('非 Electron（Web 远端服务）不下发平台专属档位，序列保持原样', async () => {
        runtimeState.electron = false;
        requestMock
            .mockResolvedValueOnce({ data: {} })
            .mockResolvedValueOnce({ data: { play_url: 'https://example.test/lossless.flac' } });

        const source = await kugouProvider.playback!.getAudioSource(plainSong(), 'hires');

        expect(askedQualities()).toEqual(['high', 'flac']);
        expect(source).toMatchObject({ quality: 'lossless' });
        expect(source?.sourceTier).toBeUndefined();
    });

    it('标准音质偏好不触发任何平台专属档位', async () => {
        requestMock.mockResolvedValueOnce({ data: { play_url: 'https://example.test/128.mp3' } });

        const source = await kugouProvider.playback!.getAudioSource(plainSong(), 'standard');

        expect(askedQualities()).toEqual(['128']);
        expect(source?.sourceTier).toBeUndefined();
    });
});
