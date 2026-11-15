import { afterEach, describe, expect, it } from 'vitest';
import { omni } from '@/services/onlineMusic/omni';
import { registerOnlineMusicProvider, unregisterOnlineMusicProvider } from '@/services/onlineMusic/providerRegistry';
import type { AudioQualityPreference, OnlineMusicProvider } from '@/types/onlineMusic';
import { resolveStoredAudioQuality } from '@/stores/useAudioSettingsStore';
import { getPlaybackCapabilities } from '@/platform/playbackCapabilities';
import {
    hasDolbyObjectDecodeBackend,
    findDolbyDecodeBackend,
    registerDolbyDecodeBackend,
    listDolbyDecodeBackends,
    type DolbyDecodeBackend,
} from '@/services/audioCodec/dolbyDecodeBackend';

// test/unit/onlineMusic/atmosQualityTier.test.ts
// 2026-11-12: the `atmos` tier is a platform-rendered spatial track (an ordinary audio file),
// NOT an E-AC-3 JOC / AC-4 object stream. These tests pin down the two safety properties:
//   1. a provider that does not declare `atmos` is never asked for it (would degrade to 128 kbps);
//   2. a stored `atmos` preference still resolves to a real level everywhere.

describe('stored audio quality preference', () => {
    it('preserves the new atmos preference', () => {
        expect(resolveStoredAudioQuality('atmos')).toBe('atmos');
    });

    it.each(['standard', 'ultra', 'lossless', 'hires'] as const)('still preserves %s', quality => {
        expect(resolveStoredAudioQuality(quality)).toBe(quality);
    });

    it('falls back to high for an unknown value', () => {
        expect(resolveStoredAudioQuality('exhigh')).toBe('high');
        expect(resolveStoredAudioQuality(null)).toBe('high');
    });
});

const atmostProviderId = 'atmos-quality-test-listed';
const plainProviderId = 'atmos-quality-test-plain';

const fakeProvider = (id: string, levels?: readonly AudioQualityPreference[]): OnlineMusicProvider => ({
    id,
    displayName: id,
    capabilities: {
        search: true, playback: true, lyrics: false, auth: false, userLibrary: false,
        playlists: false, albums: false, artists: false, recommendations: false,
        mutations: false, wordByWordLyrics: false,
    },
    normalizeSong: () => ({ id: '1', name: 'x', artists: [], album: { id: '', name: '' }, durationMs: 1, sourceRef: { kind: 'online', providerId: id, mediaId: '1' } }),
    playback: {
        getSongDetail: async () => null,
        getAudioSource: async () => ({ url: `https://${id}/1`, fetchedAt: 1, quality: 'standard' }),
        ...(levels ? { audioQualityLevels: levels } : {}),
    },
});

afterEach(() => {
    unregisterOnlineMusicProvider(atmostProviderId);
    unregisterOnlineMusicProvider(plainProviderId);
});

describe('omni audio quality levels', () => {
    it('never resolves a provider that does not declare atmos to atmos', () => {
        registerOnlineMusicProvider(fakeProvider(plainProviderId));
        // No audioQualityLevels -> UNLISTED (standard/high/lossless/hires). The guard exists so a
        // stored `atmos` preference cannot leak an unknown quality key into QQ/NetEase/KuGou.
        expect(omni.getAudioQualityLevels(plainProviderId)).not.toContain('atmos');
        expect(omni.resolveAudioQuality(plainProviderId, 'atmos')).toBe('hires');
        expect(omni.resolveAudioQuality(plainProviderId, 'hires')).toBe('hires');
        expect(omni.resolveAudioQuality(plainProviderId, 'ultra')).toBe('high');
    });

    it('resolves atmos for a provider that declares it, and stays ordered above hires', () => {
        registerOnlineMusicProvider(fakeProvider(atmostProviderId, ['standard', 'high', 'lossless', 'hires', 'atmos']));
        expect(omni.getAudioQualityLevels(atmostProviderId)).toContain('atmos');
        expect(omni.resolveAudioQuality(atmostProviderId, 'atmos')).toBe('atmos');
        expect(omni.resolveAudioQuality(atmostProviderId, 'hires')).toBe('hires');
        expect(omni.resolveAudioQuality(atmostProviderId, 'ultra')).toBe('high');
        expect(omni.resolveAudioQuality(atmostProviderId, 'standard')).toBe('standard');
    });
});

describe('playback capabilities are honest about Dolby', () => {
    it('reports platform-rendered tracks playable but object decoding unavailable', () => {
        const caps = getPlaybackCapabilities();
        expect(caps.platformAtmosTracks).toBe(true);
        expect(caps.dolbyObjectDecoding).toBe(false);
        expect(caps.dolbyMode).toBe('platform-rendered');
        expect(caps.hiResBitPerfectOutput).toBe(false);
    });
});

describe('Dolby decode backend registry', () => {
    it('is empty by default — no fake capability', () => {
        expect(hasDolbyObjectDecodeBackend()).toBe(false);
        expect(listDolbyDecodeBackends()).toEqual([]);
        expect(findDolbyDecodeBackend({ mimeType: 'audio/eac3' })).toBeNull();
    });

    it('accepts a real backend and can unregister it', () => {
        const backend: DolbyDecodeBackend = {
            id: 'test-dolby',
            isReady: () => true,
            canDecode: s => s.mimeType === 'audio/ac4',
            decodeAndRender: async () => ({ pcm: new Float32Array(0), sampleRate: 48000, channelLayout: 'binaural' }),
        };
        const unregister = registerDolbyDecodeBackend(backend);
        expect(hasDolbyObjectDecodeBackend()).toBe(true);
        expect(findDolbyDecodeBackend({ mimeType: 'audio/ac4' })?.id).toBe('test-dolby');
        expect(findDolbyDecodeBackend({ mimeType: 'audio/eac3' })).toBeNull();
        unregister();
        expect(hasDolbyObjectDecodeBackend()).toBe(false);
    });
});
