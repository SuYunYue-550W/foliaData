// src/components/liquidGlass/useLiquidGlassFilter.ts
//
// 把色散液态玻璃的 SVG 折射滤镜「挂」到任意已有元素上，而不把它包进新 div——
// 这样像底部播放胶囊这类用 framer-motion 驱动 transform / layout / 拖拽的元素，
// 其 DOM 结构与动画完全不动，只是多了一层 backdrop-filter: url(#id)。
//
// 纯计算层（位移图 / 三通道参数 / 能力判定）见 dispersionModel.ts；DOM 订阅与
// 尺寸同步在本 hook 里。视觉思路致谢 Mineradio 2.2.0（GPL-3.0-only），本 hook 为独立重写。

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
    buildDisplacementMapDataUri,
    canUseSvgBackdropFilter,
    displacementMapKey,
    dispersionChannels,
    normalizeDispersionParams,
    type DispersionParams,
} from './dispersionModel';
// 运行时真正挂载的是这个 hook（AppShell / FloatingPlayerControls），
// 而 liquidGlass.css 之前只被未挂载的 LiquidGlass.tsx 引入 —— 结果 CSS 根本没进
// 构建产物：内高光、青绿内描边、光晕与降级磨砂全都没生效，只剩 hook 注入的
// inline backdrop-filter。在这里引入，样式才会随 bootstrap 一起打包。
import './liquidGlass.css';

/** 探测 backdrop-filter: url(#svg) 是否可用；firefox / 旧 safari 由纯函数再判一次。 */
const detectSvgBackdropSupport = (): boolean => {
    if (typeof document === 'undefined' || typeof navigator === 'undefined') return false;
    let probe = false;
    try {
        const el = document.createElement('div');
        el.style.backdropFilter = 'url(#folia-glass-probe)';
        probe = el.style.backdropFilter !== '';
    } catch {
        probe = false;
    }
    return canUseSvgBackdropFilter(navigator.userAgent, probe);
};

export interface UseLiquidGlassFilterOptions {
    /** 要施加折射的元素的 ref；位移图按它的实时尺寸生成（缩放/展开态都会重新贴合）。 */
    targetRef: React.RefObject<HTMLElement | null>;
    /** 是否启用。关闭时不注入任何滤镜，元素保持原样（零回归）。 */
    enabled?: boolean;
    /** 局部覆盖色散参数。 */
    params?: Partial<DispersionParams>;
    /**
     * 圆角（px）。不传则按「胶囊 / 药丸形」估算：rx = height/2，正好贴合底部条的圆角胶囊。
     */
    radius?: number;
}

export interface LiquidGlassFilterResult {
    /** 全局唯一的 SVG filter id，供目标元素 style.backdropFilter 引用。 */
    filterId: string;
    /** 要渲染进 DOM 的隐藏 <svg> defs（含 feImage + 三通道色散链）。 */
    defs: React.ReactNode;
    /** 直接挂到目标元素 style.backdropFilter 的值；不支持时为 undefined。 */
    backdropFilter: string | undefined;
    /** SVG 折射是否生效（用来决定是否再套玻璃描边 class）。 */
    svgEnabled: boolean;
}

export const useLiquidGlassFilter = (options: UseLiquidGlassFilterOptions): LiquidGlassFilterResult => {
    const { targetRef, enabled = true, params, radius } = options;
    const rawId = useId();
    // useId 带 ":"，放进 CSS url(#...) 前去掉非法字符，保证 id 唯一且合法。
    const filterId = `folia-glass-filter-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const [support, setSupport] = useState(false);
    const [mapUri, setMapUri] = useState<string | null>(null);
    const lastKeyRef = useRef('');

    const resolved = useMemo(() => normalizeDispersionParams(params), [params]);
    const channels = useMemo(() => dispersionChannels(resolved), [resolved]);

    // 能力检测只在挂载后跑一次（SSR / 单测环境安全）。
    useEffect(() => { setSupport(detectSvgBackdropSupport()); }, []);

    // 尺寸 → 位移图。ResizeObserver 保证窗口缩放、展开/收起切换后边缘折射仍然贴合实际几何。
    useEffect(() => {
        const host = targetRef.current;
        if (!host) return;
        const sync = () => {
            const rect = host.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2) return;
            const resolvedRadius = radius ?? (rect.height / 2);
            const opts = {
                width: rect.width,
                height: rect.height,
                cornerRadius: resolvedRadius,
                edgeBand: resolved.edgeBand,
                soften: resolved.soften,
            };
            const key = displacementMapKey(opts);
            if (key === lastKeyRef.current) return;
            lastKeyRef.current = key;
            setMapUri(buildDisplacementMapDataUri(opts));
        };
        sync();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(sync);
        ro.observe(host);
        return () => ro.disconnect();
    }, [targetRef, radius, resolved.edgeBand, resolved.soften]);

    const svgEnabled = support && enabled && Boolean(mapUri);
    // 折射之外再叠一层轻磨砂，避免纯色散让胶囊显得太透；Chromium 支持 url()+blur 串联。
    const backdropFilter = svgEnabled ? `url(#${filterId}) blur(6px) saturate(1.15)` : undefined;

    const defs = svgEnabled ? (
        <svg className="folia-glass-defs" aria-hidden="true" focusable="false">
            <defs>
                <filter
                    id={filterId}
                    colorInterpolationFilters="sRGB"
                    x="-20%" y="-30%" width="140%" height="160%"
                >
                    <feImage
                        href={mapUri ?? undefined}
                        x="0" y="0" width="100%" height="100%"
                        preserveAspectRatio="none" result="map"
                    />
                    {channels.map(ch => (
                        <React.Fragment key={ch.name}>
                            <feDisplacementMap
                                in="SourceGraphic" in2="map" scale={ch.scale}
                                xChannelSelector="R" yChannelSelector="B"
                                result={`disp_${ch.name}`}
                            />
                            <feOffset
                                in={`disp_${ch.name}`} dx={ch.dx} dy={ch.dy}
                                result={`shift_${ch.name}`}
                            />
                            <feMerge result={`aligned_${ch.name}`}>
                                <feMergeNode in="SourceGraphic" />
                                <feMergeNode in={`shift_${ch.name}`} />
                            </feMerge>
                            <feColorMatrix
                                in={`aligned_${ch.name}`} type="matrix" values={ch.matrix}
                                result={ch.name}
                            />
                        </React.Fragment>
                    ))}
                    <feBlend in="red" in2="green" mode="screen" result="rg" />
                    <feBlend in="rg" in2="blue" mode="screen" result="rgb" />
                    <feGaussianBlur in="rgb" stdDeviation="0.4" />
                </filter>
            </defs>
        </svg>
    ) : null;

    return { filterId, defs, backdropFilter, svgEnabled };
};

export default useLiquidGlassFilter;
