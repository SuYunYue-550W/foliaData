import { describe, expect, it } from 'vitest';
import { AUDIO_QUALITY_CHOICES } from '@/components/audioQualityChoices';
import { omni } from '@/services/onlineMusic/omni';

// test/unit/settings/audioQualitySettings.test.ts
// 音质偏好搬到设置弹窗后，「哪几档可挑」「存着的偏好点亮哪一档」必须还和账户页那一行
// 同一套语义：档位表共用一份，落档由 omni 决定（不是页面自己算），Apple Music 那种
// 不报档位的平台不许出现一个假的下拉框。

describe('the audio quality row in the settings page', () => {
    it('shares one ordered choice table with the account panel', () => {
        expect(AUDIO_QUALITY_CHOICES.map(choice => choice.value)).toEqual([
            'standard', 'high', 'ultra', 'lossless', 'hires', 'atmos',
        ]);
        for (const choice of AUDIO_QUALITY_CHOICES) {
            expect(choice.labelKey).toMatch(/^account\.quality/);
        }
    });

    it('offers only what the active provider declares, and lights where the stored preference lands', () => {
        const levels = omni.getAudioQualityLevels('ytm');
        expect(levels.length).toBeGreaterThan(0);
        const choices = AUDIO_QUALITY_CHOICES.filter(option => levels.includes(option.value));
        expect(choices.map(option => option.value)).toEqual([...levels]);
        // A preference the provider does not have falls back to its nearest lower level.
        const lit = omni.resolveAudioQuality('ytm', 'hires');
        expect(levels).toContain(lit);
    });

    it('gives Apple Music no pick list: the official page owns the audio format', () => {
        // external 播放路线的音频在 companion 页面里出声，Folia 拿不到流，也就没有档位可挑。
        // omni 对未声明档位的平台回退到通用四档，那是取流协议的护栏，不是页面上能改的选项；
        // 页面按 provider 自己声明的档位决定画不画下拉框。
        expect(omni.offersAudioQualityChoice('appleMusic')).toBe(false);
        expect(omni.getAudioQualityLevels('appleMusic').length).toBeGreaterThan(0);
        expect(omni.offersAudioQualityChoice('netease')).toBe(true);
    });
});
