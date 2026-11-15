// src/services/listeningArchive/wrappedShareImage.ts
// 听歌报告的分享图：把一份 WrappedReport 画到 1080×1920 的竖版画布上，导出 PNG。
//
// 视觉与档案页的暗色系一致（深底、渐变、一档强调色）。封面图不往画布上画：远程封面会
// 污染画布（toBlob 直接抛错），分享图以数字与名次为主，没有封面也不缺信息。文字用系统
// 字体栈，中文渲染交给系统（PingFang / 微软雅黑 / Noto）。
//
// 纯浏览器 API，Web / Electron / 安卓 WebView 都能走通；导出用 toBlob + 下载链接，
// 失败（画布被污染、环境没有下载能力）时把错误抛给调用方提示。

import type { WrappedReport } from './wrapped';

/** 画布尺寸：竖版 1080×1920。 */
export const WRAPPED_IMAGE_WIDTH = 1080;
export const WRAPPED_IMAGE_HEIGHT = 1920;

/** 中文字体栈：canvas 直接用系统字体，不引外部字体文件。 */
const FONT_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

const font = (size: number, weight: string = '400'): string => `${weight} ${size}px ${FONT_STACK}`;

/** 深色底上的强调色，与档案页高亮一致的一档青色。 */
const ACCENT = '#4fd1c5';
const TEXT_MAIN = 'rgba(255,255,255,0.92)';
const TEXT_SUB = 'rgba(255,255,255,0.55)';
const BAR_FILL = 'rgba(79,209,197,0.75)';

/** 画到图上的文案包（调用方用 i18n 填好）。 */
export type WrappedImageText = {
    title: string;
    rangeLabel: string;
    playsLabel: string;
    secondsLabel: string;
    songsLabel: string;
    topSongsLabel: string;
    peakLabel: string;
    weeklyLabel: string;
    footer: string;
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** 秒数写成「x 小时 y 分」，与档案页的时长口径一致。 */
const durationLabel = (seconds: number): string => {
    const total = Math.max(Math.round(seconds), 0);
    if (total < 60) return `${total} 秒`;
    if (total < 3600) return `${Math.floor(total / 60)} 分`;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return `${hours} 小时 ${minutes} 分`;
};

const rangeText = (report: WrappedReport): string => {
    const from = new Date(report.from);
    const to = new Date(report.to);
    const stamp = (date: Date): string => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    return `${stamp(from)} ~ ${stamp(to)}`;
};

/** 画一块深色渐变背景与顶部标题。 */
const drawHeader = (ctx: CanvasRenderingContext2D, text: WrappedImageText, report: WrappedReport): void => {
    const gradient = ctx.createLinearGradient(0, 0, WRAPPED_IMAGE_WIDTH, WRAPPED_IMAGE_HEIGHT);
    gradient.addColorStop(0, '#0b0d12');
    gradient.addColorStop(0.55, '#101623');
    gradient.addColorStop(1, '#0b0d12');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, WRAPPED_IMAGE_WIDTH, WRAPPED_IMAGE_HEIGHT);

    ctx.fillStyle = ACCENT;
    ctx.font = font(34, '600');
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text.title, 96, 200);

    ctx.fillStyle = TEXT_SUB;
    ctx.font = font(28);
    ctx.fillText(rangeText(report), 96, 260);
};

/** 三个总量：播放次数 / 听歌时长 / 听过的歌。 */
const drawTotals = (ctx: CanvasRenderingContext2D, text: WrappedImageText, report: WrappedReport): void => {
    const items: Array<{ value: string; label: string }> = [
        { value: String(report.totals.plays), label: text.playsLabel },
        { value: durationLabel(report.totals.seconds), label: text.secondsLabel },
        { value: String(report.totals.songs), label: text.songsLabel },
    ];
    items.forEach((item, index) => {
        const x = 96 + index * 300;
        ctx.fillStyle = TEXT_MAIN;
        ctx.font = font(56, '700');
        ctx.fillText(item.value, x, 420);
        ctx.fillStyle = TEXT_SUB;
        ctx.font = font(26);
        ctx.fillText(item.label, x, 470);
    });
};

/** 截断过长的一行文本，末尾补省略号。 */
const ellipsize = (ctx: CanvasRenderingContext2D, value: string, maxWidth: number): string => {
    if (ctx.measureText(value).width <= maxWidth) return value;
    let cut = value.length;
    while (cut > 1 && ctx.measureText(`${value.slice(0, cut)}…`).width > maxWidth) cut -= 1;
    return `${value.slice(0, cut)}…`;
};

/** Top 5 歌曲榜单。 */
const drawTopSongs = (ctx: CanvasRenderingContext2D, text: WrappedImageText, report: WrappedReport): void => {
    ctx.fillStyle = TEXT_SUB;
    ctx.font = font(30, '600');
    ctx.fillText(text.topSongsLabel, 96, 600);

    report.topSongs.slice(0, 5).forEach((entry, index) => {
        const y = 670 + index * 108;
        ctx.fillStyle = ACCENT;
        ctx.font = font(40, '700');
        ctx.fillText(String(index + 1), 96, y);
        ctx.fillStyle = TEXT_MAIN;
        ctx.font = font(34, '500');
        ctx.fillText(ellipsize(ctx, entry.title, 720), 160, y);
        ctx.fillStyle = TEXT_SUB;
        ctx.font = font(26);
        ctx.fillText(`${entry.plays} · ${durationLabel(entry.seconds)}`, 160, y + 44);
    });
};

/** 每周播放柱状（最多画最近 12 周，柱高按最大值归一）。 */
const drawWeeklyBars = (ctx: CanvasRenderingContext2D, text: WrappedImageText, report: WrappedReport): void => {
    ctx.fillStyle = TEXT_SUB;
    ctx.font = font(30, '600');
    ctx.fillText(text.weeklyLabel, 96, 1400);

    const bars = report.weeklyBars.slice(-12);
    if (bars.length === 0) return;
    const max = Math.max(...bars.map(bucket => bucket.seconds), 1);
    const areaTop = 1460;
    const areaHeight = 260;
    const gap = 14;
    const width = (WRAPPED_IMAGE_WIDTH - 192 - gap * (bars.length - 1)) / bars.length;
    bars.forEach((bucket, index) => {
        const height = Math.max((bucket.seconds / max) * areaHeight, bucket.seconds > 0 ? 6 : 2);
        ctx.fillStyle = BAR_FILL;
        ctx.globalAlpha = bucket.seconds > 0 ? 1 : 0.25;
        ctx.fillRect(96 + index * (width + gap), areaTop + areaHeight - height, width, height);
    });
    ctx.globalAlpha = 1;

    const last = bars[bars.length - 1];
    if (last) {
        ctx.fillStyle = TEXT_SUB;
        ctx.font = font(22);
        ctx.fillText(last.key, 96, areaTop + areaHeight + 46);
    }
};

/** 最常听时段一行 + 底部落款。 */
const drawFootnotes = (ctx: CanvasRenderingContext2D, text: WrappedImageText, report: WrappedReport): void => {
    if (report.peak) {
        ctx.fillStyle = TEXT_MAIN;
        ctx.font = font(30, '500');
        const peak = `${text.peakLabel} ${durationLabel(report.peak.seconds)}`;
        ctx.fillText(ellipsize(ctx, peak, WRAPPED_IMAGE_WIDTH - 192), 96, 1330);
    }
    ctx.fillStyle = TEXT_SUB;
    ctx.font = font(24);
    ctx.fillText(text.footer, 96, WRAPPED_IMAGE_HEIGHT - 110);
};

/** 把报告画到传入的画布上（导出与测试共用）。 */
export const drawWrappedReport = (canvas: HTMLCanvasElement, report: WrappedReport, text: WrappedImageText): void => {
    canvas.width = WRAPPED_IMAGE_WIDTH;
    canvas.height = WRAPPED_IMAGE_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前环境无法创建画布');
    drawHeader(ctx, text, report);
    drawTotals(ctx, text, report);
    drawTopSongs(ctx, text, report);
    drawFootnotes(ctx, text, report);
    drawWeeklyBars(ctx, text, report);
};

/** 渲染并导出 PNG；返回交给下载的文件名。 */
export const exportWrappedImage = (report: WrappedReport, text: WrappedImageText): string => {
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
        throw new Error('当前环境无法导出图片');
    }
    const canvas = document.createElement('canvas');
    drawWrappedReport(canvas, report, text);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `听歌报告-${stamp}.png`;

    canvas.toBlob(blob => {
        if (!blob) throw new Error('分享图没能生成');
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.rel = 'noopener';
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }, 'image/png');
    return fileName;
};
