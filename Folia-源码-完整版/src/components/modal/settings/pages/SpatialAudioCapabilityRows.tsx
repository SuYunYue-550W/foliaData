import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { isAndroidAppShell } from '../../../../platform/runtime';
import { getPlaybackCapabilities } from '../../../../platform/playbackCapabilities';
import { isNativePlayerAvailable, nativePlayer } from '../../../../services/playbackEngine/nativePlayerPlugin';
import type { AudioOutputCapabilities, DolbyDeviceCapabilities } from '../../../../services/playbackEngine/nativePlayerPlugin';
import { readMediaDiagnostics } from '../../../../utils/mediaDiagnostics';
import { hasDolbyObjectDecodeBackend } from '../../../../services/audioCodec/dolbyDecodeBackend';
import { Group, Row, option, type SettingsGroupDef } from '../kit';

// src/components/modal/settings/pages/SpatialAudioCapabilityRows.tsx
//
// 「空间音频与高解析」能力说明。这一组**没有开关**：目前没有任何一项是用户能在本应用里
// 打开或关闭的杜比能力，做出一个开关只会误导。它只如实回答三件事：
//   1. 平台标记的杜比全景声／空间音频曲目能播（那是平台已渲染好的普通音频文件）；
//   2. 对象式杜比解码不可用（需要 Dolby dev kit 与产品认证，本项目没有）；
//   3. Hi-Res 能播但会被重采样，不是 bit-perfect 输出。
// 安卓额外按需问一次设备 MediaCodec 里有没有 eac3/ac4 解码器，纯事实展示，不驱动播放。

const SPATIAL: SettingsGroupDef = { id: 'spatialAudioSettings', titleKey: 'options.spatialAudioSettings' };

const O = {
    atmosTracks: option(SPATIAL, 'spatialAtmosTracks', 'options.spatialAtmosTracks', { noteKey: 'options.spatialAtmosTracksDesc' }),
    objectDecoding: option(SPATIAL, 'spatialObjectDecoding', 'options.spatialObjectDecoding', { noteKey: 'options.spatialObjectDecodingDesc' }),
    hiResOutput: option(SPATIAL, 'spatialHiResOutput', 'options.spatialHiResOutput', { noteKey: 'options.spatialHiResOutputDesc' }),
    osTakeover: option(SPATIAL, 'spatialOsTakeover', 'options.spatialOsTakeover', { noteKey: 'options.spatialOsTakeoverDesc' }),
    deviceCodecs: option(SPATIAL, 'spatialDeviceCodecs', 'options.spatialDeviceCodecs', { noteKey: 'options.spatialDeviceCodecsDesc' }),
    outputRate: option(SPATIAL, 'spatialOutputRate', 'options.spatialOutputRate', { noteKey: 'options.spatialOutputRateDesc' }),
};

/** A small read-only status chip: no pointer, no toggle, just a fact. */
const Status: React.FC<{ text: string; tone: 'yes' | 'no' | 'info' }> = ({ text, tone }) => (
    <span
        className={`rounded-full px-2.5 py-1 text-xs ${
            tone === 'yes' ? 'bg-[var(--st-ok-bg,rgba(34,197,94,.12))] text-[color:var(--st-ok,rgb(34,197,94))]'
                : tone === 'no' ? 'bg-[var(--st-warn-bg,rgba(234,179,8,.12))] text-[color:var(--st-warn,rgb(234,179,8))]'
                    : 'bg-[var(--st-fill)] text-[color:var(--st-t2)]'
        }`}
    >
        {text}
    </span>
);

const describeCodecs = (caps: DolbyDeviceCapabilities, t: TFunction): string => {
    if (!caps.available) return t('options.spatialDeviceUnavailable');
    const present = [
        caps.ac4 ? 'AC-4' : null,
        caps.eac3 ? 'E-AC-3' : null,
        caps.ac3 ? 'AC-3' : null,
        caps.flac ? 'FLAC' : null,
    ].filter(Boolean) as string[];
    if (!present.length) return t('options.spatialDeviceNone');
    return t('options.spatialDeviceSome', { codecs: present.join(' / ') });
};

const SpatialAudioCapabilityRows: React.FC = () => {
    const { t } = useTranslation();
    const capabilities = getPlaybackCapabilities();
    const [device, setDevice] = React.useState<DolbyDeviceCapabilities | null>(null);
    const [output, setOutput] = React.useState<AudioOutputCapabilities | null>(null);
    const [webRate, setWebRate] = React.useState<number | null>(null);

    // The audio graph's real sample rate is already collected for diagnostics; read it once when
    // the page opens. This is a fact about the running output, never a setting or a switch.
    React.useEffect(() => {
        if (isAndroidAppShell()) return;
        setWebRate(readMediaDiagnostics().audioContextSampleRate);
    }, []);

    // Only Android, only once, only when the native player plugin is really there. Both probes are
    // pure read-only queries — neither loads a decoder nor changes the playback path. A failure is
    // shown as "unavailable" instead of being hidden, so no row implies a capability.
    React.useEffect(() => {
        if (!isAndroidAppShell() || !isNativePlayerAvailable()) return;
        let alive = true;
        nativePlayer.getDolbyDeviceCapabilities()
            .then(result => { if (alive) setDevice(result); })
            .catch(() => { if (alive) setDevice({ eac3: false, ac4: false, ac3: false, flac: false, available: false }); });
        nativePlayer.getAudioOutputCapabilities()
            .then(result => { if (alive) setOutput(result); })
            .catch(() => { if (alive) setOutput({ outputSampleRate: 0, floatPcmOutput: false, available: false }); });
        return () => { alive = false; };
    }, []);

    const rateHz = isAndroidAppShell()
        ? (output?.available ? output.outputSampleRate : 0)
        : (webRate ?? 0);
    const rateText = rateHz > 0
        ? t('options.spatialOutputRateValue', { rate: rateHz.toLocaleString() })
        : t('options.spatialOutputRateUnknown');

    // If a licensed backend is ever registered (see audioCodec/dolbyDecodeBackend.ts), the object
    // decoding row flips to "available" automatically. It stays "unavailable" by default.
    const objectDecodeAvailable = hasDolbyObjectDecodeBackend();

    return (
        <Group def={SPATIAL}>
            <Row option={O.atmosTracks}>
                <Status
                    text={capabilities.platformAtmosTracks ? t('options.spatialStatusPlayable') : t('options.spatialStatusUnavailable')}
                    tone={capabilities.platformAtmosTracks ? 'yes' : 'no'}
                />
            </Row>
            <Row option={O.objectDecoding}>
                <Status
                    text={objectDecodeAvailable ? t('options.spatialStatusPlayable') : t('options.spatialStatusUnavailable')}
                    tone={objectDecodeAvailable ? 'yes' : 'no'}
                />
            </Row>
            <Row option={O.hiResOutput}>
                <Status text={t('options.spatialHiResResampled')} tone="info" />
            </Row>
            <Row option={O.osTakeover}>
                <Status text={t('options.spatialOsManaged')} tone="info" />
            </Row>
            <Row option={O.outputRate}>
                <Status text={rateText} tone="info" />
            </Row>
            {isAndroidAppShell() && device && (
                <Row option={O.deviceCodecs} hint={describeCodecs(device, t)}>
                    <Status text={device.available ? t('options.spatialStatusProbed') : t('options.spatialStatusUnavailable')} tone={device.available ? 'info' : 'no'} />
                </Row>
            )}
        </Group>
    );
};

export default SpatialAudioCapabilityRows;
