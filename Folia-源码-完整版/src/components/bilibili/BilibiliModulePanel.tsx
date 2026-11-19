import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UnifiedSong } from '../../types';
import { Button } from '../ui/Button';
import { useBilibiliVideoStore } from '../../stores/useBilibiliVideoStore';
import { getBilibiliModule, type BilibiliModuleId } from '../../services/onlineMusic/bilibili/bilibiliModules';

// src/components/bilibili/BilibiliModulePanel.tsx
// 七个模块的面板：推荐 / 热门 / 动画 / 影视 / 直播 / 收藏 / 历史。
// 只做展示与触发；数据经 bilibiliModules（平台目录），播放经 store → VideoSurface。

const MODULES: { id: BilibiliModuleId; labelKey: string }[] = [
    { id: 'recommend', labelKey: 'home.biliModuleRecommend' },
    { id: 'popular', labelKey: 'home.biliModulePopular' },
    { id: 'anime', labelKey: 'home.biliModuleAnime' },
    { id: 'film', labelKey: 'home.biliModuleFilm' },
    { id: 'live', labelKey: 'home.biliModuleLive' },
    { id: 'favorites', labelKey: 'home.biliModuleFavorites' },
    { id: 'history', labelKey: 'home.biliModuleHistory' },
];

interface BilibiliModulePanelProps {
    /** 关闭面板。 */
    onClose: () => void;
    /** 播放一个 B站视频：音频走主播放引擎，画面由播放链接管（见 onlinePlayback.ts）。 */
    onPlay: (song: UnifiedSong) => void;
    /** 正在播的 B 站视频（bvid）；面板据此标出当前这一条。 */
    currentBvid?: string | null;
}

const BilibiliModulePanel: React.FC<BilibiliModulePanelProps> = ({ onClose, onPlay, currentBvid }) => {
    const { t } = useTranslation();
    const module = useBilibiliVideoStore(state => state.module);
    const setModule = useBilibiliVideoStore(state => state.setModule);
    const playVideo = useBilibiliVideoStore(state => state.play);
    const [songs, setSongs] = useState<UnifiedSong[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const page = await getBilibiliModule(module, {});
            setSongs(page.items as UnifiedSong[]);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setSongs([]);
        } finally {
            setLoading(false);
        }
    }, [module]);

    useEffect(() => {
        void load();
    }, [load]);

    const select = (song: UnifiedSong) => {
        const ref = song.sourceRef;
        if (!ref || ref.kind !== 'online') return;
        // 先起画面（画面层等取流回来的 videoUrl），再走标准播放：音频走主播放引擎。
        // 声音不重复：画面层只放画面，声音始终由主播放引擎出。
        const bvid = ref.mediaId.startsWith('room:') ? ref.mediaId.slice(5) : ref.mediaId;
        playVideo(bvid);
        onPlay(song);
    };

    return (
        <div className="flex h-full flex-col gap-3 p-4" data-bilibili-panel>
            <div className="flex flex-wrap items-center gap-2">
                {MODULES.map(item => (
                    <Button
                        key={item.id}
                        variant={module === item.id ? 'primary' : 'quiet'}
                        size="sm"
                        onClick={() => setModule(item.id)}
                    >
                        {t(item.labelKey)}
                    </Button>
                ))}
                <Button variant="quiet" size="sm" onClick={onClose}>
                    {t('home.biliClose')}
                </Button>
            </div>
            {loading && <div className="text-sm opacity-60">{t('home.biliLoading')}</div>}
            {error && <div className="text-sm text-red-400">{error}</div>}
            <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-y-auto md:grid-cols-3 lg:grid-cols-4">
                {songs.map(song => (
                    <Button
                        key={song.id}
                        variant="bare"
                        className={`group flex h-auto flex-col items-start gap-2 rounded-xl p-0 text-left ${currentBvid === song.id ? 'opacity-100' : ''}`}
                        onClick={() => select(song)}
                    >
                        {song.album.coverUrl && (
                            <img
                                src={song.album.coverUrl}
                                alt=""
                                className="aspect-video w-full rounded-lg object-cover"
                                loading="lazy"
                            />
                        )}
                        <span className="line-clamp-2 text-[13px]">{song.name}</span>
                        <span className="text-xs opacity-60">{song.artists[0]?.name || ''}</span>
                    </Button>
                ))}
            </div>
            {!loading && songs.length === 0 && !error && (
                <div className="text-sm opacity-60">{t('home.biliEmpty')}</div>
            )}
        </div>
    );
};

export default BilibiliModulePanel;
