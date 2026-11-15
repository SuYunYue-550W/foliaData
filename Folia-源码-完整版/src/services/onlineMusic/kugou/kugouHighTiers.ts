import { hasElectronBridge, isAndroidAppShell } from '../../../platform/runtime';
import type { AudioQualityPreference } from '../../../types/onlineMusic';

// src/services/onlineMusic/kugou/kugouHighTiers.ts
//
// 这个 provider 的「最高格式」在不同运行时走的是不同的取流链路，档位字符串不能共用：
//
//  · Electron 桌面：请求走随包打进去的 kugoumusicapi 模块（electron/kugou/kugouApiBridge.cjs
//    → node_modules/kugoumusicapi/module/song_url.js），quality 原样透传给上游 /song/url。
//    上游除了 128 / 320 / flac / high，还支持 viper_tape（蝰蛇母带）、viper_clear（蝰蛇超清）、
//    viper_atmos（蝰蛇全景声）、super（DSD）等平台专属档位。它们需要 VIP、只有部分曲目提供；
//    上游文档明确写着 viper_tape「该音质需要转码」，返回的 URL 未必能直接解码。所以只把它们
//    当作「额外优先尝试」，拿不到就回到常规档位链。
//  · Web 版：请求发到 getWebApiBase() 指向的远端 KuGouMusicApi 服务。那份服务的版本由部署方
//    决定、不由本项目控制，不能确认它认不认 viper_*；发未知档位可能静默降级或报错。不启用。
//  · 安卓 App 壳：请求走本地桥自己按 hash 挑档再打 /v5/url，quality 会被 Number() 归一化，
//    只认 128 / 320 / flac 这类值。把 viper_tape 传进去不会报错，而是退化成 128 kbps ——
//    不是「不支持」，是静默降到最低档，正是必须避免的那种失败。
//
// 结论：平台专属档位**只在能确认后端版本的 Electron 桌面链路**下发。这个收窄不是为了让测试
// 通过，而是「只在知道对端会怎么处理这个 key 时才发它」；桌面 exe 正是本项目的主要交付形态。
// 安卓壳沿用常规映射，并把 hires / atmos 明确落到 flac：原先映射到 high，而本地桥把 high 读成
// 320 kbps，反而比 lossless 低一档。
//
// 默认只额外问下面两个：上游还提供 viper_clear（蝰蛇超清）与 super（DSD），但每多一个候选
// 就是一次串行请求，绝大多数非 VIP / 无该档曲目的播放会被拖慢起速。这两个覆盖「母带」与
// 「空间音频」两项明确诉求，其余档位留作后续按需扩展。

/** 桌面 / Web 链路上按「母带优先」排列、默认会额外尝试的平台专属高档。 */
export const KUGOU_DESKTOP_HIGH_TIERS = [
    'viper_tape',
    'viper_atmos',
] as const;

export type KugouDesktopHighTier = typeof KUGOU_DESKTOP_HIGH_TIERS[number];

/** 只有明确要最高档的偏好才值得额外去问这些链：低档偏好问了也只会拿到同一批 VIP 拒绝。 */
export const kugouHighTierCandidates = (quality: AudioQualityPreference): readonly KugouDesktopHighTier[] => (
    quality === 'hires' || quality === 'atmos'
        ? KUGOU_DESKTOP_HIGH_TIERS
        : []
);

/**
 * 这个运行时是否走「能确认版本、能接收平台专属档位字符串」的上游 /song/url。
 * 只有 Electron 桌面：随包模块版本固定。Web 远端服务与安卓本地桥都不满足。
 * 布尔入参留成纯函数，好让这条门控能被单测直接覆盖，而不依赖测试跑在哪个环境。
 */
export const kugouCanUseUpstreamSongUrl = (electron: boolean, androidShell: boolean): boolean =>
    electron && !androidShell;

export const kugouUsesUpstreamSongUrl = (): boolean =>
    kugouCanUseUpstreamSongUrl(hasElectronBridge(), isAndroidAppShell());

/**
 * 常规档位映射到两端各自能懂的 quality 值。运行时判断留在外面的包装里，这里保持纯函数，
 * 好让两条分支都能被单测直接覆盖。
 *
 * 安卓壳把 hires / atmos 落到 flac：本地桥的归一化把 'high' 读成 320 kbps，比无损低一档，
 * 这是一个既有降级（原先 hires 偏好反而拿不到无损），随本轮一并修正。
 */
export const kugouQualityValueFor = (quality: AudioQualityPreference, androidShell: boolean): string => {
    if (androidShell) {
        return ({
            standard: '128', high: '320', ultra: '320',
            lossless: 'flac', hires: 'flac', atmos: 'flac',
        })[quality];
    }
    return ({
        standard: '128', high: '320', ultra: '320',
        lossless: 'flac', hires: 'high', atmos: 'high',
    })[quality];
};

export const kugouQualityValue = (quality: AudioQualityPreference): string =>
    kugouQualityValueFor(quality, isAndroidAppShell());
