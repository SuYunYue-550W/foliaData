import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '../ui/Button';
import { useShallow } from 'zustand/react/shallow';
import { selectBilibiliPlaybackMode, useBilibiliVideoStore } from '../../stores/useBilibiliVideoStore';

// src/components/bilibili/BilibiliVideoSurface.tsx
// 嵌在现有播放页里的 B站画面（VideoLayer 位置）。
// 路线 A（dash）：B站 DASH 是视频/音频分离的 m4s。这里只放**画面**（静音的 <video>），
//   声音由主播放引擎出——它拿的是同一次 getAudioSource 的音频地址，与画面同一个时刻开始，
//   不在这里再放一个音频元素（那会双份出声）。
// 路线 B（iframe）：A 拿不到流或用户强制时，回退官方 player.bilibili.com。合规稳定，
//   但播放器是 B站界面，Folia 无法控制内部进度/音量。

interface BilibiliVideoSurfaceProps {
    /** 播放页的暂停信号：窗口隐藏等情况下连 B站视频也停。 */
    paused: boolean;
}

const BilibiliVideoSurface: React.FC<BilibiliVideoSurfaceProps> = ({ paused }) => {
    const { bvid, videoUrl, mode, setMode, stop } = useBilibiliVideoStore(useShallow(state => ({
        bvid: state.bvid,
        videoUrl: state.videoUrl,
        mode: selectBilibiliPlaybackMode(state),
        setMode: state.setMode,
        stop: state.stop,
    })));
    const { t } = useTranslation();
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const failedRef = useRef(false);

    useEffect(() => {
        failedRef.current = false;
    }, [bvid, videoUrl]);

    // 路线 A 出错时自动回退 B：这是 A+B 混合的关键——B站接口一变，用户仍能看到视频。
    //
    // 带上出错时的 bvid：切视频后旧视频的 play() 拒绝可能迟到（AbortError 等），
    // 那时 failedRef 已经被新视频重置成 false，不带 bvid 判断就会把**新**视频
    // 误切成 iframe。
    const handleDashError = (failedBvid: string) => {
        if (failedBvid !== bvid) return;
        if (failedRef.current) return;
        failedRef.current = true;
        setMode(true);
    };

    // 只有「媒体真的加载不出来」才回退 iframe：
    //   - AbortError：切 src / 卸载打断的，不是失败；
    //   - NotAllowedError：自动播放被浏览器策略拦了，切 iframe 也没用（iframe 同样会被拦），
    //     反而让画面变成两个都不出声。
    const onMediaError = () => handleDashError(bvid);

    const onPlayRejected = (error: unknown) => {
        const name = error instanceof Error ? error.name : '';
        if (name === 'AbortError' || name === 'NotAllowedError') return;
        handleDashError(bvid);
    };

    // 画面与主引擎的音频同时开始：主引擎给 audioUrl，画面给 videoUrl，两边各自播自己的流。
    useEffect(() => {
        if (paused) {
            videoRef.current?.pause();
        } else {
            void videoRef.current?.play().catch(onPlayRejected);
        }
    }, [paused, mode, videoUrl]);

    if (!bvid) return null;

    if (mode === 'iframe') {
        return (
            <div className="absolute inset-0 overflow-hidden" data-bilibili-surface="iframe">
                {/* muted=1：官方外链播放器的静音参数。
                    声音永远由主播放引擎出（这条 DASH 音频已经交给它了）。iframe 自己再出声
                    就是两份声音叠在一起 —— 用户在 iframe 里点一下播放就能听到回声。
                    静音掉它，画面照旧，声音不分叉。
                    autoplay=0：不自动播，用户在应用里点了播放才动画面。 */}
                <iframe
                    title="Bilibili player"
                    className="h-full w-full border-0"
                    src={`https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&autoplay=0&muted=1&danmaku=0&high_quality=1`}
                    allow="autoplay; fullscreen; encrypted-media"
                    referrerPolicy="no-referrer"
                />
                <Button
                    variant="quiet"
                    size="sm"
                    icon={X}
                    tip={t('home.biliCloseVideo')}
                    className="absolute right-2 top-2 bg-black/60 text-white"
                    onClick={stop}
                />
            </div>
        );
    }

    return (
        <div className="absolute inset-0 overflow-hidden" data-bilibili-surface="dash">
            <video
                ref={videoRef}
                className="h-full w-full object-contain"
                src={videoUrl || undefined}
                muted
                playsInline
                preload="auto"
                onError={onMediaError}
            />
                <Button
                    variant="quiet"
                    size="sm"
                    icon={X}
                    tip={t('home.biliCloseVideo')}
                    className="absolute right-2 top-2 bg-black/60 text-white"
                    onClick={stop}
                />
        </div>
    );
};

export default BilibiliVideoSurface;
