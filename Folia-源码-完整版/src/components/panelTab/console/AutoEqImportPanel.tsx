import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../modal/settings/kit/Button';
import { TextArea } from '../../modal/settings/kit/TextArea';
import {
    AUDIO_EQUALIZER_MAX_GAIN_DB,
    AUDIO_EQUALIZER_MIN_GAIN_DB,
} from '../../../utils/audioEqualizer';
import {
    mapAutoEqPointsToBands,
    parseAutoEqText,
    planAutoEqPreamp,
    type AutoEqParseResult,
} from '../../../services/autoeqImport';
import { AUDIO_EQUALIZER_BANDS } from '../../../utils/audioEqualizer';

// src/components/panelTab/console/AutoEqImportPanel.tsx
// 「导入 AutoEQ」的小面板：粘贴 → 解析预览（十段结果 + preamp 去处）→ 确认写入。
//
// 解析与拟合都是纯函数（services/autoeqImport.ts），这里只管粘贴框、预览与报错的呈现，
// 手机上同样可用 —— 没有文件选择、剪贴板 API 之外的平台依赖，粘贴靠系统输入法菜单。

type AutoEqImportPanelProps = {
    /** 确认后把十段增益与 preamp（可能为 null）交给调用方。 */
    onApply: (gains: number[], preampDb: number | null) => void;
    onClose: () => void;
};

const clampGain = (value: number): number => (
    Math.min(AUDIO_EQUALIZER_MAX_GAIN_DB, Math.max(AUDIO_EQUALIZER_MIN_GAIN_DB, value))
);

const formatDb = (value: number): string => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;

/** 解析一次粘贴文本；空文本不解析（免得一打开就满屏报错）。 */
const useParsed = (text: string): AutoEqParseResult | null => useMemo(() => {
    if (!text.trim()) return null;
    return parseAutoEqText(text);
}, [text]);

const AutoEqImportPanel: React.FC<AutoEqImportPanelProps> = ({ onApply, onClose }) => {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const parsed = useParsed(text);

    const hasPoints = Boolean(parsed && parsed.points.length > 0);
    const preampPlan = planAutoEqPreamp(parsed?.preampDb ?? null);
    const mappedGains = useMemo(() => {
        if (!parsed || parsed.points.length === 0) return null;
        return mapAutoEqPointsToBands(parsed.points)
            .map(gain => clampGain(gain + preampPlan.perBandDb));
    }, [parsed, preampPlan.perBandDb]);

    const formatLabel = parsed ? t(`ui.autoEqFormat.${parsed.format}`) : '';

    return (
        <div className="mx-1 mb-3 rounded-xl bg-[var(--st-card)] p-3 shadow-[0_0_0_1px_var(--st-line)]">
            <div className="flex items-center justify-between gap-2">
                <h4 className="text-[13px] font-semibold text-[color:var(--st-t1)]">{t('ui.autoEqImportTitle')}</h4>
                <Button variant="quiet" onClick={onClose}>{t('ui.autoEqClose')}</Button>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.autoEqImportHint')}</p>
            <div className="mt-2">
                <TextArea
                    value={text}
                    onChange={setText}
                    placeholder={t('ui.autoEqPlaceholder')}
                />
            </div>

            {parsed && (
                <div className="mt-2 text-[11px] leading-4 text-[color:var(--st-t3)]">
                    <span className="text-[color:var(--st-t2)]">{t('ui.autoEqDetectedFormat')}</span>
                    {formatLabel}
                    {hasPoints && <span> · {t('ui.autoEqPointCount', { n: parsed.points.length })}</span>}
                </div>
            )}

            {/* 行级错误：哪一行坏了、原文是什么，直接列出来。 */}
            {parsed && parsed.errors.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                    {parsed.errors.slice(0, 6).map(error => (
                        <li key={error.line} className="text-[11px] leading-4 text-[color:var(--st-danger, #e05a5a)]">
                            {t('ui.autoEqLineError', { line: error.line, text: error.text })}
                        </li>
                    ))}
                    {parsed.errors.length > 6 && (
                        <li className="text-[11px] leading-4 text-[color:var(--st-t3)]">
                            {t('ui.autoEqMoreErrors', { n: parsed.errors.length - 6 })}
                        </li>
                    )}
                </ul>
            )}

            {/* 十段预览：每一格是「段名 + 拟合后的 dB」。 */}
            {mappedGains && (
                <div className="mt-2">
                    <div className="text-[11px] font-medium text-[color:var(--st-t2)]">{t('ui.autoEqPreview')}</div>
                    <div className="mt-1 grid grid-cols-5 gap-1 max-sm:grid-cols-5">
                        {AUDIO_EQUALIZER_BANDS.map((band, index) => (
                            <div key={band.frequency} className="rounded-md bg-[var(--st-fill)] px-1.5 py-1 text-center">
                                <div className="text-[10px] text-[color:var(--st-t3)]">{band.label}</div>
                                <div className="font-mono text-[11px] text-[color:var(--st-t1)]">
                                    {formatDb(mappedGains[index])}
                                </div>
                            </div>
                        ))}
                    </div>
                    {parsed?.preampDb !== null && parsed?.preampDb !== undefined && (
                        <p className="mt-1.5 text-[11px] leading-4 text-[color:var(--st-t3)]">
                            {t(preampPlan.folded ? 'ui.autoEqPreampFolded' : 'ui.autoEqPreampApplied', {
                                preamp: formatDb(parsed.preampDb),
                            })}
                        </p>
                    )}
                </div>
            )}

            {!hasPoints && parsed && (
                <p className="mt-2 text-[11px] leading-4 text-[color:var(--st-danger, #e05a5a)]">
                    {t('ui.autoEqNoPoints')}
                </p>
            )}

            <div className="mt-2.5 flex justify-end gap-2">
                <Button variant="fill" onClick={onClose}>{t('ui.autoEqCancel')}</Button>
                <Button
                    variant="primary"
                    disabled={!mappedGains}
                    onClick={() => mappedGains && onApply(mappedGains, parsed?.preampDb ?? null)}
                >
                    {t('ui.autoEqApply')}
                </Button>
            </div>
        </div>
    );
};

export default AutoEqImportPanel;
