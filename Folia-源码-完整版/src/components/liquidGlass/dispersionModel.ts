// src/components/liquidGlass/dispersionModel.ts
//
// 色散液态玻璃（chromatic dispersion glass）的**纯计算层**：位移图、三通道色散参数、
// 能力判定。这里刻意不碰 DOM，全部是可单测的纯函数；浏览器相关的注入与订阅放在
// LiquidGlass.tsx 里。
//
// ── 独立实现与致谢 ──────────────────────────────────────────────────────────────
// 视觉思路参考了 Mineradio 2.2.0（github.com/XxHuberrr/Mineradio-paused, GPL-3.0-only）
// 的 control-glass 效果，在此向作者致谢。本项目为 AGPL-3.0，与 GPL-3.0-only 条款不相容，
// 因此**没有复制该项目任何源码文件**：本模块的参数模型、渐变构造、通道链与降级策略均为
// 独立重写。所用「SVG feDisplacementMap + 分通道 feColorMatrix + feBlend screen」属于公开的
// 通用图形技术（liquid glass / chromatic aberration），不构成可版权的具体表达。
//
// 物理原理：feDisplacementMap 用一张位移图的 R 通道决定水平位移、B 通道决定垂直位移，
// 位移量 = scale * (channel/255 - 0.5)。让 R/B 在边缘呈梯度、中心回到中性灰(128)，
// 就得到「边缘像凸透镜折射、中间清晰」的玻璃。三条通道各用略不同的 scale 与 feOffset，
// 再经 feColorMatrix 分离、feBlend screen 合成，即产生彩色镶边（色散）。

/** 单条通道在 SVG 滤镜链里的全部数值。 */
export interface DispersionChannel {
    name: 'red' | 'green' | 'blue';
    /** feDisplacementMap 的 scale。三通道递减，制造折射差 → 色散。 */
    scale: number;
    /** feOffset 的 dx。 */
    dx: number;
    /** feOffset 的 dy。 */
    dy: number;
    /** feColorMatrix 的 values：从对齐后的图里只留一个颜色通道。 */
    matrix: string;
}

/** 一组完整、可调的色散玻璃参数。 */
export interface DispersionParams {
    /** 基准折射强度（feDisplacementMap scale），越大边缘扭曲越明显。 */
    refractionScale: number;
    /** 三通道 scale 的级差。 */
    scaleStep: number;
    /** 色散横向分离量上限（px）。 */
    chromaSpread: number;
    /** 用户可调的色散偏移强度，钳制到 [30,140]。 */
    chromaticOffset: number;
    /** 垂直色散相对水平的比例，默认很小，避免文字上下抖动。 */
    verticalFactor: number;
    /** 位移图边缘渐变带占短边的比例。 */
    edgeBand: number;
    /** 位移图中心中性区的高斯模糊半径（px），越大折射越柔和。 */
    soften: number;
}

export const CHROMATIC_OFFSET_MIN = 30;
export const CHROMATIC_OFFSET_MAX = 140;

/** 默认值：与 Electron/Chromium 43 上肉眼可辨、又不至于让文字发虚的一组参数。 */
export const DEFAULT_DISPERSION_PARAMS: Readonly<DispersionParams> = Object.freeze({
    refractionScale: 150,
    scaleStep: 12,
    chromaSpread: 18,
    chromaticOffset: 92,
    verticalFactor: 0.08,
    edgeBand: 0.07,
    soften: 9,
});

/** 钳制并把非有限数回退到 fallback，避免 NaN 打进 SVG 属性。 */
export const clampNumber = (
    value: number, min: number, max: number, fallback: number,
): number => (
    Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
);

/** 把可缺省的局部参数补全、逐项钳制成一组安全参数。 */
export const normalizeDispersionParams = (
    partial: Partial<DispersionParams> | undefined,
): DispersionParams => {
    const d = DEFAULT_DISPERSION_PARAMS;
    return {
        refractionScale: clampNumber(partial?.refractionScale ?? d.refractionScale, 0, 260, d.refractionScale),
        scaleStep: clampNumber(partial?.scaleStep ?? d.scaleStep, 0, 60, d.scaleStep),
        chromaSpread: clampNumber(partial?.chromaSpread ?? d.chromaSpread, 0, 60, d.chromaSpread),
        chromaticOffset: clampNumber(
            partial?.chromaticOffset ?? d.chromaticOffset,
            CHROMATIC_OFFSET_MIN, CHROMATIC_OFFSET_MAX, d.chromaticOffset,
        ),
        verticalFactor: clampNumber(partial?.verticalFactor ?? d.verticalFactor, 0, 0.5, d.verticalFactor),
        edgeBand: clampNumber(partial?.edgeBand ?? d.edgeBand, 0.02, 0.2, d.edgeBand),
        soften: clampNumber(partial?.soften ?? d.soften, 0, 24, d.soften),
    };
};

const RED_MATRIX = '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0';
const GREEN_MATRIX = '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0';
const BLUE_MATRIX = '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0';

/**
 * 生成三通道色散链。baseShiftX 取 -scale/2 附近，用来把折射后的图与 SourceGraphic 对齐
 * （否则整块内容会被推走）。chroma 由用户档位归一化，spread 决定彩色镶边宽度。
 */
export const dispersionChannels = (params: DispersionParams): readonly DispersionChannel[] => {
    const chroma = params.chromaticOffset / CHROMATIC_OFFSET_MAX;
    const spread = params.chromaSpread * chroma;
    const vertical = spread * params.verticalFactor;
    // 位移最大为 scale/2，用一个基础负偏移把合成结果拉回原位。
    const baseShiftX = -params.refractionScale / 2;
    return [
        {
            name: 'red',
            scale: clampNumber(params.refractionScale, 0, 260, 0),
            dx: baseShiftX - spread,
            dy: -vertical,
            matrix: RED_MATRIX,
        },
        {
            name: 'green',
            scale: clampNumber(params.refractionScale - params.scaleStep, 0, 260, 0),
            dx: baseShiftX,
            dy: 0,
            matrix: GREEN_MATRIX,
        },
        {
            name: 'blue',
            scale: clampNumber(params.refractionScale - params.scaleStep * 2, 0, 260, 0),
            dx: baseShiftX + spread,
            dy: vertical,
            matrix: BLUE_MATRIX,
        },
    ];
};

/** SVG 属性里的数字统一保留两位小数，避免长浮点撑大 data URI。 */
const fmt = (n: number): string => {
    const v = Math.round(n * 100) / 100;
    return String(Math.abs(v) < 0.005 ? 0 : v);
};

export interface DisplacementMapOptions {
    width: number;
    height: number;
    cornerRadius: number;
    edgeBand: number;
    soften: number;
}

/** ResizeObserver 的缓存键：尺寸/圆角/模糊不变就不必重算位移图。 */
export const displacementMapKey = (o: DisplacementMapOptions): string => (
    [Math.round(o.width), Math.round(o.height), Math.round(o.cornerRadius), o.edgeBand.toFixed(3), o.soften.toFixed(2)].join('x')
);

/**
 * 生成一张位移图，返回可直接喂给 <feImage href> 的 data URI。
 *
 * 三段式线性渐变（暗 → 中性 → 亮）分别驱动 R（水平）与 B（垂直）通道；两层用
 * difference 混合后中心趋近中性、四周产生梯度；再覆盖一层模糊的中性圆角矩形，
 * 把折射收敛到边缘。整体是「独立编写」的构造：渐变 stop、内缩算法、软模糊 filter
 * 与参数化方式都不同于参考实现。
 */
export const buildDisplacementMapDataUri = (o: DisplacementMapOptions): string => {
    const w = Math.max(2, Math.round(o.width));
    const h = Math.max(2, Math.round(o.height));
    const r = Math.max(0, Math.round(o.cornerRadius));
    const band = clampNumber(o.edgeBand, 0.02, 0.2, DEFAULT_DISPERSION_PARAMS.edgeBand);
    const inset = Math.min(w, h) * band * 0.5;
    const innerW = Math.max(1, w - inset * 2);
    const innerH = Math.max(1, h - inset * 2);
    const innerR = Math.max(0, r - inset);
    const blur = clampNumber(o.soften, 0, 24, DEFAULT_DISPERSION_PARAMS.soften);

    const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
        '<defs>',
        '<linearGradient id="folia-gx" x1="0%" y1="0%" x2="100%" y2="0%">',
        '<stop offset="0%" stop-color="rgb(0,0,0)"/>',
        '<stop offset="50%" stop-color="rgb(128,128,128)"/>',
        '<stop offset="100%" stop-color="rgb(255,0,0)"/>',
        '</linearGradient>',
        '<linearGradient id="folia-gy" x1="0%" y1="0%" x2="0%" y2="100%">',
        '<stop offset="0%" stop-color="rgb(0,0,0)"/>',
        '<stop offset="50%" stop-color="rgb(128,128,128)"/>',
        '<stop offset="100%" stop-color="rgb(0,0,255)"/>',
        '</linearGradient>',
        `<filter id="folia-soft"><feGaussianBlur stdDeviation="${fmt(blur)}"/></filter>`,
        '</defs>',
        `<rect x="0" y="0" width="${w}" height="${h}" rx="${r}" fill="url(#folia-gx)"/>`,
        `<rect x="0" y="0" width="${w}" height="${h}" rx="${r}" fill="url(#folia-gy)" style="mix-blend-mode:difference"/>`,
        `<rect x="${fmt(inset)}" y="${fmt(inset)}" width="${fmt(innerW)}" height="${fmt(innerH)}" rx="${fmt(innerR)}" fill="rgb(128,128,128)" filter="url(#folia-soft)"/>`,
        '</svg>',
    ].join('');

    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

/**
 * 判定能否用 backdrop-filter: url(#svg)。Firefox 与 Safari(非 Chromium 内核) 对 SVG
 * backdrop filter 支持不完整，直接禁用；其余由调用方注入的 probe 结果决定。
 * 抽成纯函数（ua + probe 均外部传入）便于单测覆盖各分支。
 */
export const canUseSvgBackdropFilter = (userAgent: string, probeResult: boolean): boolean => {
    if (/Firefox/i.test(userAgent)) return false;
    if (/Safari/i.test(userAgent) && !/Chrome|Chromium|Edg|CriOS|Electron/i.test(userAgent)) return false;
    return probeResult;
};
