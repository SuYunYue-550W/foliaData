// src/services/audioEffects/spatialObjectMath.ts
//
// 自研「空间对象」的纯计算层：把一个声源的方位 / 仰角 / 距离，折成 Web Audio
// PannerNode 能吃的坐标与增益。
//
// 这不是杜比全景声，也不是对象式音频解码 —— 输入是已经混合好的立体声，
// 这里只是把中/侧分离出的「准对象」重新摆进一个虚拟空间，产生真实可测的
// 双耳差异（ITD / ILD）。项目在 playbackCapabilities.ts / dolbyDecodeBackend.ts
// 明确划过线：不许把 HRTF 虚拟环绕冒充成 Dolby Atmos，本文件遵守这条纪律。
//
// 纯函数，无 DOM / AudioContext 依赖，方便单测钉住数值。

import { SURROUND_PARAMS } from './immersiveParams';

/** 一个空间对象的摆位。 */
export interface SpatialObjectPlacement {
    /** PannerNode 的笛卡尔坐标（米），Y 为仰角方向，负 Z 为听者前方。 */
    x: number;
    y: number;
    z: number;
    /** 对象直达声增益（0~1）。 */
    gain: number;
}

/** 计算摆位用的输入。角度单位为度：azimuth 0=正前，正=右；elevation 正=上。 */
export interface SpatialObjectInput {
    /** 方位角，-180~180。 */
    azimuthDeg: number;
    /** 仰角，-90~90。默认 0。 */
    elevationDeg?: number;
    /** 距听者的距离（米），必须 > 0。默认 SURROUND_PARAMS.speakerDistance。 */
    distance?: number;
    /** 对象相对 bed 的强度（0~1）。默认 1。 */
    depth?: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const DEG_TO_RAD = Math.PI / 180;

/**
 * 球坐标 → PannerNode 笛卡尔坐标。
 *
 * Web Audio 的听者默认朝 -Z、上方 +Y。方位角 0 放正前方 (0,0,-d)，
 * 90 度放正右方 (d,0,0)，仰角直接用 sin 抬升，水平半径乘 cos。
 */
export const spatialObjectPlacement = (input: SpatialObjectInput): SpatialObjectPlacement => {
    // clamp 用的是 Math.min/max，遇到 NaN 会原样漏过去 —— 角度必须先挡一次。
    const rawAzimuth = Number.isFinite(input.azimuthDeg) ? input.azimuthDeg : 0;
    const rawElevation = input.elevationDeg !== undefined && Number.isFinite(input.elevationDeg)
        ? input.elevationDeg : 0;
    const azimuth = clamp(rawAzimuth, -180, 180) * DEG_TO_RAD;
    const elevation = clamp(rawElevation, -90, 90) * DEG_TO_RAD;
    const distance = input.distance !== undefined && Number.isFinite(input.distance) && input.distance > 0
        ? input.distance
        : SURROUND_PARAMS.speakerDistance;
    const depth = clamp(input.depth !== undefined && Number.isFinite(input.depth) ? input.depth : 1, 0, 1);

    const horizontal = distance * Math.cos(elevation);
    return {
        x: horizontal * Math.sin(azimuth),
        y: distance * Math.sin(elevation),
        // 负号：听者前方是 -Z。
        z: -horizontal * Math.cos(azimuth),
        gain: depth,
    };
};

/**
 * 两个对象之间的声像差，用来在测试里证明「真的产生了空间差异」而不是只有 EQ 染色。
 * 返回 0~1：0 = 完全同点，1 = 完全相反方向。
 */
export const spatialSeparation = (a: SpatialObjectPlacement, b: SpatialObjectPlacement): number => {
    const lengthA = Math.hypot(a.x, a.y, a.z);
    const lengthB = Math.hypot(b.x, b.y, b.z);
    if (lengthA === 0 || lengthB === 0) return 0;
    const dot = (a.x * b.x + a.y * b.y + a.z * b.z) / (lengthA * lengthB);
    return (1 - clamp(dot, -1, 1)) / 2;
};
