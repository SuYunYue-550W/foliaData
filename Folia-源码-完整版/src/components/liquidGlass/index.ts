// src/components/liquidGlass/index.ts
// 色散液态玻璃模块的公共出口。业务侧只需 `import { LiquidGlass } from '@/components/liquidGlass'`。

export { default as LiquidGlass } from './LiquidGlass';
export type { LiquidGlassProps } from './LiquidGlass';
export { default as LiquidGlassNavBar } from './LiquidGlassNavBar';
export type { LiquidGlassNavBarProps } from './LiquidGlassNavBar';
export { default as useLiquidGlassFilter } from './useLiquidGlassFilter';
export type { UseLiquidGlassFilterOptions, LiquidGlassFilterResult } from './useLiquidGlassFilter';
export {
    DEFAULT_DISPERSION_PARAMS,
    CHROMATIC_OFFSET_MIN,
    CHROMATIC_OFFSET_MAX,
    clampNumber,
    normalizeDispersionParams,
    dispersionChannels,
    displacementMapKey,
    buildDisplacementMapDataUri,
    canUseSvgBackdropFilter,
} from './dispersionModel';
export type {
    DispersionParams,
    DispersionChannel,
    DisplacementMapOptions,
} from './dispersionModel';
