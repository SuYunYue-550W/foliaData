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
    const handleDashError = () => {
        if (failedRef.current) return;
        failedRef.current = true;
        setMode(true);
    };

    // 画面与主引擎的音频同时开始：主引擎给 audioUrl，画面给 videoUrl，两边各自播自己的流。
    useEffect(() => {
        if (paused) {
            videoRef.current?.pause();
        } else {
            void videoRef.current?.play().catch(handleDashError);
        }
    }, [paused, mode, videoUrl]);

    if (!bvid) return null;

    if (mode === 'iframe') {
        return (
            <div className="absolute inset-0 overflow-hidden" data-bilibili-surface="iframe">
                <iframe
                    title="Bilibili player"
                    className="h-full w-full border-0"
                    src={`https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&autoplay=0&danmaku=0&high_quality=1`}
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
                onError={handleDashError}
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
