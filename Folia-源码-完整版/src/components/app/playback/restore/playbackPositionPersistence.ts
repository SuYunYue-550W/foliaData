import { currentTime } from '../../../../stores/motionSignals';
import { usePlaybackStore } from '../../../../stores/usePlaybackStore';
import { nativePlaybackEngine } from '../../../../services/playbackEngine/nativePlaybackEngine';
import { flushPlaybackPosition, savePlaybackPosition } from './playbackPositionCache';

// src/components/app/playback/restore/playbackPositionPersistence.ts
//
// 把「当前这首歌听到哪儿」按 5 秒节流写进缓存，页面隐藏 / 退出时补一次并立即落盘。
//
// 位置来源分两条链，不能只看 currentTime：
//   · Web `<audio>`：进度条与歌词由 rAF 写 currentTime；
//   · 原生 ExoPlayer：前台也由 rAF 从 getPositionSec() 读，但页面隐藏后 JS 定时器会被
//     系统挂起（见 useNativePlaybackRuntime 的注释），所以这里直接问引擎更可靠。
// `ownsPlayback()` 在桌面端恒 false，不会误用。

const TICK_MS = 5000;

export const startPlaybackPositionPersistence = (): (() => void) => {
    if (typeof window === 'undefined') return () => undefined;

    const tick = (): void => {
        const state = usePlaybackStore.getState();
        // 过渡冻结期间画面属于上一首，位置也是它的；不写，免得记到错误的歌上。
        if (!state.currentSong || state.transitionDisplay) return;
        const positionSec = nativePlaybackEngine.ownsPlayback()
            ? nativePlaybackEngine.getPositionSec()
            : currentTime.get();
        savePlaybackPosition(state.currentSong, positionSec);
    };

    const interval = window.setInterval(tick, TICK_MS);
    const settleBeforeSuspend = (): void => {
        // 隐藏 / 退出时补一帧再落盘；后台里定时器不保证还会跑。
        tick();
        flushPlaybackPosition();
    };
    const onVisibilityChange = (): void => {
        if (document.visibilityState === 'hidden') settleBeforeSuspend();
    };
    const onPageHide = (): void => settleBeforeSuspend();

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);

    return () => {
        window.clearInterval(interval);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('pagehide', onPageHide);
        flushPlaybackPosition();
    };
};
