// src/components/liquidGlass/LiquidGlass.tsx
//
// 可复用的色散液态玻璃原语。与参考实现「全局 getElementById + 单例 filter」不同，这里每个
// 实例用 useId() 持有自己的 SVG filter 与 feImage，位移图随自身尺寸生成——React 里更安全，
// 也避免多个不同尺寸的玻璃元素共用一张位移图导致边缘错位。视觉思路致谢 Mineradio 2.2.0，
// 组件结构与降级策略为独立重写。

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
    buildDisplacementMapDataUri,
    canUseSvgBackdropFilter,
    displacementMapKey,
    dispersionChannels,
    normalizeDispersionParams,
    type DispersionParams,
} from './dispersionModel';
import './liquidGlass.css';

/** 探测 backdrop-filter: url(#svg) 是否可用；firefox/旧 safari 由纯函数再判一次。 */
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

export interface LiquidGlassProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
    children?: React.ReactNode;
    /** 圆角 px；不传则读 computed border-radius（由 CSS 变量 --folia-glass-radius 决定）。 */
    radius?: number;
    /** 明暗主题，仅影响底色与描边。 */
    tone?: 'dark' | 'light';
    /** 局部覆盖色散参数。 */
    params?: Partial<DispersionParams>;
    /** 是否有 hover 抬升 / 按压 / 点击涟漪。 */
    interactive?: boolean;
    /** 激活态（页签选中）。 */
    active?: boolean;
    /** 强制关闭 SVG 折射，退回普通磨砂（开关对比 / 用户偏好 / 低性能设备）。 */
    disabled?: boolean;
}

const LiquidGlass: React.FC<LiquidGlassProps> = ({
    children,
    radius,
    tone = 'dark',
    params,
    interactive = false,
    active = false,
    disabled = false,
    className,
    style,
    onPointerDown,
    ...rest
}) => {
    const rawId = useId();
    // useId 带 ":"，放进 CSS url(#...) 前去掉非法字符，保证 id 唯一且合法。
    const filterId = `folia-glass-filter-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const hostRef = useRef<HTMLDivElement | null>(null);
    const [support, setSupport] = useState(false);
    const [mapUri, setMapUri] = useState<string | null>(null);
    const lastKeyRef = useRef<string>('');

    const resolved = useMemo(() => normalizeDispersionParams(params), [params]);
    const channels = useMemo(() => dispersionChannels(resolved), [resolved]);

    // 能力检测只在挂载后跑一次（SSR / 单测环境安全）。
    useEffect(() => { setSupport(detectSvgBackdropSupport()); }, []);

    // 尺寸 → 位移图。ResizeObserver 保证窗口缩放、内容变化后边缘折射仍然贴合实际几何。
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const sync = () => {
            const rect = host.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2) return;
            const resolvedRadius = radius ?? (parseFloat(getComputedStyle(host).borderRadius) || 20);
            const options = {
                width: rect.width,
                height: rect.height,
                cornerRadius: resolvedRadius,
                edgeBand: resolved.edgeBand,
                soften: resolved.soften,
            };
            const key = displacementMapKey(options);
            if (key === lastKeyRef.current) return;
            lastKeyRef.current = key;
            setMapUri(buildDisplacementMapDataUri(options));
        };
        sync();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(sync);
        ro.observe(host);
        return () => ro.disconnect();
    }, [radius, resolved.edgeBand, resolved.soften]);

    const svgEnabled = support && !disabled && Boolean(mapUri);
    const mode = svgEnabled ? 'svg' : 'fallback';
    const backdropFilter = svgEnabled ? `url(#${filterId}) saturate(1.15)` : undefined;

    // 点击涟漪：读指针落点插入 span，动画结束自移除。纯装饰，失败不影响业务点击。
    const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        onPointerDown?.(e);
        if (!interactive || e.pointerType === 'touch') return;
        const host = hostRef.current;
        if (!host) return;
        const rect = host.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height) * 1.6;
        const ripple = document.createElement('span');
        ripple.className = 'folia-glass-ripple';
        ripple.style.left = `${e.clientX - rect.left}px`;
        ripple.style.top = `${e.clientY - rect.top}px`;
        ripple.style.width = `${size}px`;
        ripple.style.height = `${size}px`;
        ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
        host.appendChild(ripple);
    }, [interactive, onPointerDown]);

    return (
        <>
            {svgEnabled && (
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
            )}
            <div
                {...rest}
                ref={hostRef}
                className={['folia-liquid-glass', className].filter(Boolean).join(' ')}
                data-glass-mode={mode}
                data-tone={tone}
                data-interactive={interactive ? 'true' : undefined}
                data-active={active ? 'true' : undefined}
                onPointerDown={handlePointerDown}
                style={{
                    ...style,
                    ...(backdropFilter ? {
                        backdropFilter,
                        WebkitBackdropFilter: backdropFilter,
                    } : {}),
                    ...(radius !== undefined ? { ['--folia-glass-radius' as string]: `${radius}px` } : {}),
                }}
            >
                {children}
            </div>
        </>
    );
};

export default LiquidGlass;
