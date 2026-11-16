import type { AudioQualityPreference } from '../types/onlineMusic';

// src/components/audioQualityChoices.ts
// 全局音质偏好的档位表：值是与平台无关的语义档（AudioQualityPreference），文案键给
// 面板的账户页与设置弹窗的播放页共用 —— 同一份偏好两处都能改，两处必须长一个样。
// 只在某平台把它列进 audioQualityLevels 时那一档才出现；atmos 是平台渲染好的空间音轨
// （普通音频文件），不是对象式 Dolby 流，所以文案键里带着那一句提示。

export const AUDIO_QUALITY_CHOICES: ReadonlyArray<{
    value: AudioQualityPreference;
    labelKey: string;
}> = [
    { value: 'standard', labelKey: 'account.qualityStandard' },
    { value: 'high', labelKey: 'account.qualityExhigh' },
    { value: 'ultra', labelKey: 'account.qualityUltra' },
    { value: 'lossless', labelKey: 'account.qualityLossless' },
    { value: 'hires', labelKey: 'account.qualityHires' },
    { value: 'atmos', labelKey: 'account.qualityAtmos' },
];
