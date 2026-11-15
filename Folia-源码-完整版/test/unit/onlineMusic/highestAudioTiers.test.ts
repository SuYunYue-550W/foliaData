import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type { AudioQualityPreference, ProviderAudioSource } from '../../../src/types/onlineMusic';
import {
    KUGOU_DESKTOP_HIGH_TIERS,
    kugouCanUseUpstreamSongUrl,
    kugouHighTierCandidates,
    kugouQualityValueFor,
} from '../../../src/services/onlineMusic/kugou/kugouHighTiers';
import { QQ_QUALITY_FALLBACKS } from '../../../src/services/onlineMusic/qq/qqQualityTiers';
import { getPlaybackCapabilities } from '../../../src/platform/playbackCapabilities';

// The desktop audio bridge is CommonJS. Require it directly so the format branch is tested
// against the real code rather than a copy of the regex.
const require = createRequire(import.meta.url);
const { shapeOf } = require('../../../electron/spotify/audio.cjs') as {
    shapeOf: (format: string) => { mimeType: string; skip: number } | null;
};

const ALL_PREFERENCES: readonly AudioQualityPreference[] =
    ['standard', 'high', 'ultra', 'lossless', 'hires', 'atmos'];

describe('平台专属最高档（只有 Electron 桌面才下发）', () => {
    it('只有明确要最高档的偏好才额外问，母带排第一', () => {
        expect(kugouHighTierCandidates('hires')).toEqual(KUGOU_DESKTOP_HIGH_TIERS);
        expect(kugouHighTierCandidates('atmos')).toEqual(KUGOU_DESKTOP_HIGH_TIERS);
        expect(KUGOU_DESKTOP_HIGH_TIERS[0]).toBe('viper_tape');
        expect(KUGOU_DESKTOP_HIGH_TIERS).toContain('viper_atmos');
        expect(kugouHighTierCandidates('lossless')).toEqual([]);
        expect(kugouHighTierCandidates('high')).toEqual([]);
        expect(kugouHighTierCandidates('standard')).toEqual([]);
    });

    it('门控只在 Electron 且非安卓壳时打开，Web / 安卓都不发未知档位', () => {
        expect(kugouCanUseUpstreamSongUrl(true, false)).toBe(true);
        expect(kugouCanUseUpstreamSongUrl(false, false)).toBe(false);
        expect(kugouCanUseUpstreamSongUrl(true, true)).toBe(false);
        expect(kugouCanUseUpstreamSongUrl(false, true)).toBe(false);
    });

    it('安卓壳只发本地桥能懂的 quality，且 hires / atmos 不再降到 320 kbps', () => {
        expect(kugouQualityValueFor('hires', true)).toBe('flac');
        expect(kugouQualityValueFor('atmos', true)).toBe('flac');
        expect(kugouQualityValueFor('lossless', true)).toBe('flac');
        expect(kugouQualityValueFor('high', true)).toBe('320');
        expect(kugouQualityValueFor('standard', true)).toBe('128');
        // The guard that matters: no platform-specific tier string may ever reach the on-device
        // bridge, where an unknown quality key silently degrades to 128 kbps.
        for (const quality of ALL_PREFERENCES) {
            expect(kugouQualityValueFor(quality, true)).not.toMatch(/viper|super/);
        }
    });

    it('桌面保留无损与 high 的常规语义', () => {
        expect(kugouQualityValueFor('hires', false)).toBe('high');
        expect(kugouQualityValueFor('lossless', false)).toBe('flac');
        expect(kugouQualityValueFor('standard', false)).toBe('128');
    });
});

describe('QQ 档位链：只用后端认识的 key，不混入官方 SDK 档位名', () => {
    it('每条链都只用后端白名单里的 quality key', () => {
        const allowed = new Set(['128', '320', 'flac']);
        for (const chain of Object.values(QQ_QUALITY_FALLBACKS)) {
            const keys = chain.map(candidate => candidate.apiQuality);
            expect(keys.every(key => allowed.has(key))).toBe(true);
            // Every chain still degrades down to the standard tier.
            expect(keys[keys.length - 1]).toBe('128');
        }
    });

    it('最高档链以 FLAC 开头，APE 与官方 SDK 档位都不启用', () => {
        for (const quality of ['lossless', 'hires', 'atmos'] as const) {
            const keys = QQ_QUALITY_FALLBACKS[quality].map(c => c.apiQuality);
            expect(keys[0]).toBe('flac');
            expect(keys).not.toContain('ape');
            expect(keys.some(key => /master|galaxy|dolby|excellent/i.test(key))).toBe(false);
        }
    });

    it('标准链不含 APE，任何档位都不会解析成高于 lossless 的假档', () => {
        expect(QQ_QUALITY_FALLBACKS.standard.map(c => c.apiQuality)).toEqual(['128']);
        for (const chain of Object.values(QQ_QUALITY_FALLBACKS)) {
            for (const candidate of chain) {
                expect(ALL_PREFERENCES).toContain(candidate.resolvedQuality);
            }
        }
    });
});

describe('Spotify 的 FLAC 分支只是格式预留，不是无损质量档', () => {
    it('认得 FLAC 文件格式，其余格式行为不变', () => {
        expect(shapeOf('FLAC_FLAC_24BIT')).toEqual({ mimeType: 'audio/flac', skip: 0 });
        expect(shapeOf('OGG_VORBIS_320')).toEqual({ mimeType: 'audio/ogg', skip: 0xa7 });
        expect(shapeOf('MP3_320')).toEqual({ mimeType: 'audio/mpeg', skip: 0 });
        expect(shapeOf('AAC_320')).toBeNull();
    });
});

describe('Hi-Res 输出能力如实标注', () => {
    it('bit-perfect 恒为 false，本轮不引入假开关', () => {
        expect(getPlaybackCapabilities().hiResBitPerfectOutput).toBe(false);
    });

    it('sourceTier 只是可选诊断字段，不改变全局档位语义', () => {
        const plain: ProviderAudioSource = { url: 'https://example.test/a', fetchedAt: 1, quality: 'hires' };
        const withTier: ProviderAudioSource = { ...plain, sourceTier: 'viper_tape' };
        expect(plain.sourceTier).toBeUndefined();
        expect(withTier.quality).toBe('hires');
        expect(withTier.sourceTier).toBe('viper_tape');
    });
});
