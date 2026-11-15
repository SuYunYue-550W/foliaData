// src/services/jam/useJamBridge.ts
// 把 Jam 会话层接上真实播放器：在这里注册 jamGateway（useAppPlaybackBridges 调用）。
//
// 注册的网关两条路都走：
//   host — 差分读取 snapshot()（usePlaybackStore + 音频元素/原生引擎的位置）→ 发事件；
//   guest — playSong / resume / pause / seek / applyQueue 应用房主事件。
//
// 防回环说明（实现取舍）：
//   客机端会话层没有任何 publish 调用（见 jamSession），加入后本地的播放控制
//   天然不会广播出去；应用房主事件期间置 applyingRemote 标记（jamSession），
//   供未来双向能力做保险。客机手动切歌/暂停不拦 UI（拦 UI 要动 transport 组件，
//   侵入面大），而是靠对齐检查「自动回跳」：歌与房主快照不同即重放快照歌，
//   进度漂移超过 1.5s 即 seek 回房主位置，并提示「跟随房主中」。
//
// 播放事件的唯一来源是 jamSession 的差分循环（hostTick，1s）：play/pause/切歌
// 由状态差分捕捉、seek 由外推位置 vs 真实位置的偏差捕捉，这里不做第二份发布。

import { useEffect, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { PlayerState, type SongResult } from '../../types';
import { nativePlaybackEngine } from '../playbackEngine/nativePlaybackEngine';
import { currentTime } from '../../stores/motionSignals';
import { replacePlayQueue, usePlaybackStore } from '../../stores/usePlaybackStore';
import type { JamSnapshot } from './jamProtocol';
import { setJamGateway } from './jamGateway';

type UseJamBridgeParams = {
    playSong: (song: SongResult, queue?: SongResult[], isFmCall?: boolean) => Promise<unknown> | unknown;
    resumePlayback: () => Promise<void> | void;
    pausePlayback: () => void;
    audioRef: RefObject<HTMLAudioElement | null>;
    nativeTakesRef: MutableRefObject<boolean>;
};

export const useJamBridge = ({ playSong, resumePlayback, pausePlayback, audioRef, nativeTakesRef }: UseJamBridgeParams): void => {
    // 最新值进 ref：网关注册一次，闭包里的回调永远读到当前的播放器。
    const latest = useRef({ playSong, resumePlayback, pausePlayback, audioRef, nativeTakesRef });
    latest.current = { playSong, resumePlayback, pausePlayback, audioRef, nativeTakesRef };

    useEffect(() => {
        const readPosition = (): number => (
            latest.current.nativeTakesRef.current
                ? nativePlaybackEngine.getPositionSec()
                : currentTime.get()
        );

        const snapshot = (): JamSnapshot | null => {
            const state = usePlaybackStore.getState();
            const song = state.currentSong;
            if (!song) return null;
            return {
                song,
                playing: state.playerState === PlayerState.PLAYING,
                position: readPosition(),
                queue: state.playQueue,
                ts: Date.now(),
            };
        };

        setJamGateway({
            playSong: (song, queue) => {
                void latest.current.playSong(song, queue, false);
            },
            resume: () => {
                void latest.current.resumePlayback();
            },
            pause: () => {
                latest.current.pausePlayback();
            },
            seek: (positionSeconds) => {
                if (latest.current.nativeTakesRef.current) {
                    void nativePlaybackEngine.seek(positionSeconds);
                    return;
                }
                const audio = latest.current.audioRef.current;
                if (audio && Number.isFinite(positionSeconds)) {
                    audio.currentTime = Math.max(0, positionSeconds);
                }
            },
            applyQueue: (queue) => {
                // 只换队列不动歌：客机的队列跟随。FM 标志保持本地现状。
                replacePlayQueue(queue, usePlaybackStore.getState().isFmMode);
            },
            snapshot,
        });
        return () => setJamGateway(null);
    }, []);
};
