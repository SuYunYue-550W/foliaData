import type { AudioQualityPreference } from '../../../types/onlineMusic';

// src/services/onlineMusic/qq/qqQualityTiers.ts
//
// 播放档位的回退链，单独放成无副作用的数据模块，好让「哪些 quality key 会被发给后端」
// 这件事能被单测直接钉住。provider 里其它 import 会拉起 i18n / 原生桥，不适合作为契约测试的入口。
//
// 后端是 @yakult-green-tea/qq-music-api：MUSIC_FILE_TYPES 只有 m4a / 128 / 320 / ape / flac，
// 未知 key 不会报错，而是静默退回 128 kbps 文件。所以这里出现的每一个 apiQuality 都必须在
// 那张表里，且 omni 的 UNLISTED 档位表也不会把 atmos / ultra 直接发下来。
//
// ⚠️ 关于 ape（A000 .ape）：它确实在后端的文件类型表里，2026-11-12 试过把它接在 flac 之后，
// 但**本轮决定不启用**，理由是实测的代价大于收益：
//   · ape 与 flac 同为普通无损，并不比 flac「更高」，不是用户要的官方 SDK 母带档；
//   · 只有极少数「有 APE 没有 FLAC」的曲目才用得上，却给每一次最高档播放多加一次串行请求；
//   · 它把「每档一次请求」的失败路径契约整体推后一档，17 个精心设计的可靠性用例（超时短路、
//     preview 兜底、请求次数）会全部失准。为这点收益削弱那组护栏不划算。
// 真要支持 ape，应作为独立能力单独评估，而不是塞进这条通用回退链。
//
// 官方 SDK（com.tencent.qqmusic.openapisdk）的 MASTER_TAPE / GALAXY / DOLBY / HIRES /
// EXCELLENT 属于另一套需开放平台 appId 与商业授权的播放栈，本后端协议里不存在，
// 绝不在这里声明成档位——那只会变成未知 key → 静默 128 kbps 的假开关。

export type QqApiQuality = '128' | '320' | 'flac';

export const QQ_QUALITY_FALLBACKS: Record<
    AudioQualityPreference,
    Array<{ apiQuality: QqApiQuality; resolvedQuality: AudioQualityPreference }>
> = {
    standard: [{ apiQuality: '128', resolvedQuality: 'standard' }],
    high: [
        { apiQuality: '320', resolvedQuality: 'high' },
        { apiQuality: '128', resolvedQuality: 'standard' },
    ],
    // For the type: this provider is never asked at 'ultra' (omni asks at 'high' in its place).
    ultra: [
        { apiQuality: '320', resolvedQuality: 'high' },
        { apiQuality: '128', resolvedQuality: 'standard' },
    ],
    lossless: [
        { apiQuality: 'flac', resolvedQuality: 'lossless' },
        { apiQuality: '320', resolvedQuality: 'high' },
        { apiQuality: '128', resolvedQuality: 'standard' },
    ],
    // The backend has no distinct Hi-Res tier: its highest real file is FLAC (F000). The official
    // SDK master / Galaxy / Dolby tiers are a separate licensed stack, not reachable here.
    hires: [
        { apiQuality: 'flac', resolvedQuality: 'lossless' },
        { apiQuality: '320', resolvedQuality: 'high' },
        { apiQuality: '128', resolvedQuality: 'standard' },
    ],
    // `atmos` is never *asked* of this provider (omni's UNLISTED level list excludes it), but a
    // stored `atmos` preference must still resolve to something: the FLAC chain above is the
    // highest tier this backend has.
    atmos: [
        { apiQuality: 'flac', resolvedQuality: 'lossless' },
        { apiQuality: '320', resolvedQuality: 'high' },
        { apiQuality: '128', resolvedQuality: 'standard' },
    ],
};
