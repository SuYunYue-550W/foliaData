// src/services/hifi/hifiMediaShim.ts
// [apple-music] 外部播放器发声时，给只读的观察者（Media Session、遥控器、听歌上报、
// Navidrome scrobble……）一个长得像 <audio> 的对象。上游这里还挂着 hifi/mpv 引擎的
// HifiMediaShim；本 fork 没有那条引擎，所以只保留「外部路线注册」这一半。
//
// 注意：fork 目前还没有把读 <audio> 的调用方换成 getObservedMedia，也就是说这份 shim
// 注册进来了但观察者仍读原生元素。要接上属于独立改动，见 CHANGELOG 的限制说明。
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import type { ObservedMedia } from '../mediaShim';

export type { ObservedMedia } from '../mediaShim';

let otherRouteMedia: (() => ObservedMedia | null) | null = null;

/** 注册 `external` 路线发声时观察者该看的那份 shim。 */
export const setExternalRouteMedia = (reader: (() => ObservedMedia | null) | null) => {
    otherRouteMedia = reader;
};

/** 观察者该看的媒体：外部播放器发声时用它的 shim，否则用传入的原生 <audio>。 */
export const getObservedMedia = (fallback: HTMLAudioElement | null): ObservedMedia | null => (
    usePlaybackStore.getState().playbackRoute === 'external'
        ? otherRouteMedia?.() ?? null
        : fallback
);
