import React, { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Download, Loader2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import { Segmented } from '@/components/modal/settings/kit';
import type { ArchivePlay } from '../../../services/listeningArchive/types';
import {
    buildWrappedReport,
    WRAPPED_TOP_COUNT,
    type WrappedPeriod,
    type WrappedReport,
} from '../../../services/listeningArchive/wrapped';
import { exportWrappedImage, type WrappedImageText } from '../../../services/listeningArchive/wrappedShareImage';
import { formatArchiveDuration } from './listeningArchiveFormat';

// src/components/app/listeningArchive/WrappedOverlay.tsx
// 「生成回顾报告」的全屏浮层：本月 / 本年 / 全部三个档位，展示总量、Top 榜、最常听时段、
// 每周柱状与上一周期对比，并支持把报告导出成 1080×1920 的竖版 PNG。
//
// 视觉照档案页外壳的暗色系（同款渐变底 + blur），数据全部由 wrapped.ts 的纯函数现算，
// 这个组件只负责选择档位、展示与导出。空数据时不报错，给一句友好的空态。

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

type WrappedOverlayProps = {
    plays: ArchivePlay[];
    isDaylight: boolean;
    onClose: () => void;
};

type ExportState = 'idle' | 'exporting' | 'exported' | 'failed';

const RankList: React.FC<{
    title: string;
    report: WrappedReport;
    kind: 'topSongs' | 'topArtists' | 'topAlbums';
    t: (key: string, options?: Record<string, unknown>) => string;
}> = ({ title, report, kind, t }) => {
    const entries = report[kind];
    if (entries.length === 0) return null;
    return (
        <section className="rounded-xl border border-[var(--st-line)] bg-[var(--st-surface)] p-4">
            <h3 className="pb-2 text-[12px] font-medium uppercase tracking-wide text-[color:var(--st-t3)]">{title}</h3>
            <ol className="flex flex-col gap-1.5">
                {entries.map((entry, index) => (
                    <li key={entry.key} className="flex items-baseline gap-3 text-[13px]">
                        <span className="w-5 shrink-0 text-right font-semibold text-[color:var(--st-accent,var(--st-t2))]">
                            {index + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[color:var(--st-t1)]">{entry.title}</span>
                        {entry.subtitle && (
                            <span className="hidden shrink-0 truncate text-[11px] text-[color:var(--st-t3)] sm:block">
                                {entry.subtitle}
                            </span>
                        )}
                        <span className="shrink-0 text-[11px] text-[color:var(--st-t3)]">
                            {t('listeningArchive.wrapped.playUnit', { count: entry.plays })}
                        </span>
                    </li>
                ))}
            </ol>
        </section>
    );
};

const WrappedOverlay: React.FC<WrappedOverlayProps> = ({ plays, isDaylight, onClose }) => {
    const { t } = useTranslation();
    const [period, setPeriod] = useState<WrappedPeriod>('month');
    const [exportState, setExportState] = useState<ExportState>('idle');

    const report = useMemo(() => buildWrappedReport(plays, period), [plays, period]);

    const periodOptions = useMemo<Array<{ value: WrappedPeriod; label: string }>>(() => ([
        { value: 'month', label: t('listeningArchive.wrapped.periodMonth') },
        { value: 'year', label: t('listeningArchive.wrapped.periodYear') },
        { value: 'all', label: t('listeningArchive.wrapped.periodAll') },
    ]), [t]);

    const weekdayLabel = (weekday: number): string => t(`listeningArchive.timeline.weekdays.${WEEKDAY_KEYS[weekday] ?? 'mon'}`);

    const handleExport = () => {
        if (!report.hasData || exportState === 'exporting') return;
        setExportState('exporting');
        try {
            const text: WrappedImageText = {
                title: t('listeningArchive.wrapped.imageTitle'),
                rangeLabel: '',
                playsLabel: t('listeningArchive.wrapped.totalsPlays'),
                secondsLabel: t('listeningArchive.wrapped.totalsSeconds'),
                songsLabel: t('listeningArchive.wrapped.totalsSongs'),
                topSongsLabel: t('listeningArchive.wrapped.topSongs'),
                peakLabel: t('listeningArchive.wrapped.peakShort'),
                weeklyLabel: t('listeningArchive.wrapped.weeklyTitle'),
                footer: t('listeningArchive.title'),
            };
            exportWrappedImage(report, text);
            setExportState('exported');
        } catch (error) {
            console.warn('[ListeningArchive] 分享图导出失败', error);
            setExportState('failed');
        }
    };

    const comparison = report.comparison;
    const playsDelta = comparison ? report.totals.plays - comparison.plays : null;
    const secondsDelta = comparison ? report.totals.seconds - comparison.seconds : null;

    return (
        <motion.section
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 24 }}
                className="fixed inset-0 z-[60] flex flex-col overflow-y-auto px-4 py-5 sm:px-8 sm:py-8"
                style={{
                    color: 'var(--st-t1)',
                    backgroundColor: isDaylight ? 'rgba(250,250,250,0.97)' : 'rgba(8,8,10,0.97)',
                    backdropFilter: 'blur(24px)',
                }}
                aria-label={t('listeningArchive.wrapped.title')}
            >
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
                    <header className="flex shrink-0 items-center gap-3">
                        <Button
                            variant="quiet"
                            className="h-8 w-8 shrink-0 rounded-full"
                            onClick={onClose}
                            aria-label={t('listeningArchive.wrapped.close')}
                            tip={t('listeningArchive.wrapped.close')}
                            icon={ArrowLeft}
                        />
                        <h2 className="flex items-center gap-2 truncate text-[15px] text-[color:var(--st-t1)]">
                            <Sparkles className="h-4 w-4 text-[color:var(--st-accent,#4fd1c5)]" />
                            {t('listeningArchive.wrapped.title')}
                        </h2>
                        <div className="ml-auto">
                            <Segmented value={period} options={periodOptions} onChange={setPeriod} />
                        </div>
                    </header>

                    {!report.hasData ? (
                        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 text-center">
                            <Sparkles className="h-8 w-8 opacity-30" />
                            <p className="text-[13px] text-[color:var(--st-t3)]">{t('listeningArchive.wrapped.empty')}</p>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-3">
                            <section className="grid grid-cols-3 gap-3 rounded-xl border border-[var(--st-line)] bg-[var(--st-surface)] p-4">
                                <div>
                                    <p className="text-[22px] font-semibold text-[color:var(--st-t1)]">{report.totals.plays}</p>
                                    <p className="text-[11px] text-[color:var(--st-t3)]">{t('listeningArchive.wrapped.totalsPlays')}</p>
                                </div>
                                <div>
                                    <p className="text-[22px] font-semibold text-[color:var(--st-t1)]">
                                        {formatArchiveDuration(t, report.totals.seconds)}
                                    </p>
                                    <p className="text-[11px] text-[color:var(--st-t3)]">{t('listeningArchive.wrapped.totalsSeconds')}</p>
                                </div>
                                <div>
                                    <p className="text-[22px] font-semibold text-[color:var(--st-t1)]">{report.totals.songs}</p>
                                    <p className="text-[11px] text-[color:var(--st-t3)]">{t('listeningArchive.wrapped.totalsSongs')}</p>
                                </div>
                            </section>

                            {report.peak && (
                                <section className="rounded-xl border border-[var(--st-line)] bg-[var(--st-surface)] p-4">
                                    <p className="text-[13px] text-[color:var(--st-t1)]">
                                        {t('listeningArchive.wrapped.peak', {
                                            weekday: weekdayLabel(report.peak.weekday),
                                            hour: report.peak.hour,
                                            duration: formatArchiveDuration(t, report.peak.seconds),
                                        })}
                                    </p>
                                </section>
                            )}

                            {comparison && (playsDelta !== null || secondsDelta !== null) && (
                                <section className="rounded-xl border border-[var(--st-line)] bg-[var(--st-surface)] p-4">
                                    <h3 className="pb-1 text-[12px] font-medium uppercase tracking-wide text-[color:var(--st-t3)]">
                                        {t('listeningArchive.wrapped.comparisonTitle')}
                                    </h3>
                                    <p className="text-[13px] text-[color:var(--st-t1)]">
                                        {t('listeningArchive.wrapped.comparisonPlays', {
                                            count: report.totals.plays,
                                            sign: (playsDelta ?? 0) >= 0 ? '+' : '-',
                                            delta: Math.abs(playsDelta ?? 0),
                                        })}
                                        {' · '}
                                        {t('listeningArchive.wrapped.comparisonSeconds', {
                                            duration: formatArchiveDuration(t, Math.abs(secondsDelta ?? 0)),
                                            sign: (secondsDelta ?? 0) >= 0 ? '+' : '-',
                                        })}
                                    </p>
                                </section>
                            )}

                            <RankList title={t('listeningArchive.wrapped.topSongs')} report={report} kind="topSongs" t={t} />
                            <RankList title={t('listeningArchive.wrapped.topArtists')} report={report} kind="topArtists" t={t} />
                            <RankList title={t('listeningArchive.wrapped.topAlbums')} report={report} kind="topAlbums" t={t} />

                            <section className="rounded-xl border border-[var(--st-line)] bg-[var(--st-surface)] p-4">
                                <h3 className="pb-2 text-[12px] font-medium uppercase tracking-wide text-[color:var(--st-t3)]">
                                    {t('listeningArchive.wrapped.weeklyTitle')}
                                </h3>
                                <div className="flex h-24 items-end gap-1" aria-hidden="true">
                                    {report.weeklyBars.map(bucket => {
                                        const max = Math.max(...report.weeklyBars.map(item => item.seconds), 1);
                                        const height = Math.max((bucket.seconds / max) * 100, bucket.seconds > 0 ? 4 : 1.5);
                                        return (
                                            <div
                                                key={bucket.key}
                                                className="min-w-[3px] flex-1 rounded-t-sm bg-[color:var(--st-accent,#4fd1c5)]"
                                                style={{ height: `${height}%`, opacity: bucket.seconds > 0 ? 0.85 : 0.2 }}
                                            />
                                        );
                                    })}
                                </div>
                            </section>

                            <div className="flex items-center justify-end gap-2 pb-2">
                                {exportState === 'exported' && (
                                    <span className="text-[11px] text-[color:var(--st-t3)]">
                                        {t('listeningArchive.wrapped.exported')}
                                    </span>
                                )}
                                {exportState === 'failed' && (
                                    <span className="text-[11px] text-[color:var(--st-t3)]">
                                        {t('listeningArchive.wrapped.exportFailed')}
                                    </span>
                                )}
                                <Button
                                    variant="quiet"
                                    onClick={handleExport}
                                    disabled={exportState === 'exporting'}
                                    icon={exportState === 'exporting' ? Loader2 : Download}
                                    tip={t('listeningArchive.wrapped.export')}
                                    aria-label={t('listeningArchive.wrapped.export')}
                                />
                            </div>
                        </div>
                    )}
                </div>
            </motion.section>
    );
};

export default WrappedOverlay;
