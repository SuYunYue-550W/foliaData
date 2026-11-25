import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, Play } from 'lucide-react';
import type { UnifiedSong } from '../../../types';
import { Button } from '../../ui';
import { useBilibiliVideoStore } from '../../../stores/useBilibiliVideoStore';
import { getBilibiliModule, type BilibiliModuleId } from '../../../services/onlineMusic/bilibili/bilibiliModules';
import { useLibraryHomeSources } from '../../../library/core/home/useLibraryHomeSources';
import { useLibraryHomeSurfaceStore } from '../../../library/core/home/useLibraryHomeSurfaceStore';
import { openLoginWindow } from '../../login/loginWindowStore';
import { useThemeSettingsStore } from '../../../stores/useThemeSettingsStore';
import { useEscapeClose } from '../../../hooks/useEscapeClose';
import type { LibraryHomeData } from '../../../library/core/home/home.contract';
import type { LibraryAccountController } from '../../../library/core/account/account.contract';
import { isCommandPaletteShortcut, isTextEntryTarget } from '../../../utils/keyboardTargets';

// src/components/app/home/BilibiliHomePage.tsx
// B站内容页：作为**首页的一级页签**存在，与「歌单 / 电台 / 专辑」同一层。
//
// 为什么不再做成播放面板里的独立页签：
//   之前 B站是整个项目里唯一特殊的一个 —— 除了 provider，还自带一套播放面板页签、
//   独立内容区、独立状态层和独占画面层，而别的音乐平台都只作为 provider 出现在
//   首页页签里。两套体系并行，用户看到的就像「B站跟播放器不是一家的」。
//   现在 B站回到首页页签这一层，页面骨架与模组页（FoliumHomePage）一致：
//   顶部一行是原生页签 + 本页签，内容区自己画。
//
// 页面里不再有那个语义不对的「关闭」按钮：它原来只是把播放面板切回封面页签，
// 并不关面板。现在的返回按钮（左上角）与 Esc 都真正离开这一页。

const MODULES: { id: BilibiliModuleId; labelKey: string }[] = [
    { id: 'recommend', labelKey: 'home.biliModuleRecommend' },
    { id: 'popular', labelKey: 'home.biliModulePopular' },
    { id: 'anime', labelKey: 'home.biliModuleAnime' },
    { id: 'film', labelKey: 'home.biliModuleFilm' },
    { id: 'live', labelKey: 'home.biliModuleLive' },
    { id: 'favorites', labelKey: 'home.biliModuleFavorites' },
    { id: 'history', labelKey: 'home.biliModuleHistory' },
];

/** 页面里的 F6 / Shift+F6：往后 / 往前切原生页签（与首页其它套件同一对键）。 */
const resolveHomePageCycleKey = (event: KeyboardEvent): 1 | -1 | null => {
    if (event.key !== 'F6' || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return null;
    if (isTextEntryTarget(event.composedPath()[0] ?? event.target)) return null;
    return event.shiftKey ? -1 : 1;
};

/** 直播的媒体 id 带 room: 前缀，取流只认后面的房间号。两处比较都要用同一个归一化。 */
const bvidOf = (sourceRef: UnifiedSong['sourceRef']): string => {
    const mediaId = sourceRef?.mediaId;
    if (!mediaId) return '';
    return mediaId.startsWith('room:') ? mediaId.slice(5) : mediaId;
};

/** 收藏夹目录的一行；bilibiliModules 的 getBilibiliFavorites 在 collections 里返回它。 */
type BiliCollection = { id: string; title: string; count: number };

type BilibiliHomePageProps = {
    /** 关掉这一页，回到原生首页页签。 */
    onClose: () => void;
    /** 播放一个 B站视频：音频走主播放引擎，画面进歌词背后的画面层。 */
    onPlay: (song: UnifiedSong) => void;
    account: LibraryAccountController;
    surfaceProps: Pick<LibraryHomeData, 'theme' | 'user' | 'playlists' | 'cloudPlaylist' | 'navidromeEnabled'>;
};

export function BilibiliHomePage({ onClose, onPlay, account, surfaceProps }: BilibiliHomePageProps) {
    const { t, i18n } = useTranslation();
    const { theme, user, playlists, cloudPlaylist, navidromeEnabled } = surfaceProps;
    const isDaylight = useThemeSettingsStore(state => state.isDaylight);
    // 原生页签条的数据来源与首页 surface 同一套 core 绑定：切过去就退出这一页。
    const nativeSources = useLibraryHomeSources({ account, user, playlists, cloudPlaylist, navidromeEnabled });

    const module = useBilibiliVideoStore(state => state.module);
    const setModule = useBilibiliVideoStore(state => state.setModule);
    const playVideo = useBilibiliVideoStore(state => state.play);
    const currentBvid = useBilibiliVideoStore(state => state.bvid);
    // 收藏模块有两层：先是收藏夹目录（collections），点进去才是夹里的视频。
    const mediaId = useBilibiliVideoStore(state => state.mediaId);
    const setMediaId = useBilibiliVideoStore(state => state.setMediaId);

    const [songs, setSongs] = useState<UnifiedSong[]>([]);
    const [collections, setCollections] = useState<BiliCollection[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [needsLogin, setNeedsLogin] = useState(false);
    const sectionRef = useRef<HTMLElement>(null);
    const openerRef = useRef<HTMLElement | null>(null);
    // 请求序号：连点模块时，只有最后一次请求的结果算数。早先那个慢响应回来后
    // 若照写 setSongs，界面显示的就是推荐内容却停在「热门」这一格 —— 列表与
    // 选中项对不上。同一套序号模式在 useSearchNavigationStore 里也在用。
    const requestIdRef = useRef(0);
    // tab / tabpanel 双向关联 —— 多开几个页面时 ID 也不能撞。
    const modulesId = useId();

    const load = useCallback(async () => {
        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;
        setLoading(true);
        setError(null);
        setNeedsLogin(false);
        try {
            const page = await getBilibiliModule(module, mediaId ? { mediaId } : {});
            if (requestId !== requestIdRef.current) return;
            setSongs(page.items as UnifiedSong[]);
            // 收藏夹目录不是歌曲页，它在 collections 里（见 bilibiliModules 的注释）。
            setCollections((page as { collections?: unknown }).collections as BiliCollection[] ?? []);
        } catch (err) {
            if (requestId !== requestIdRef.current) return;
            // 收藏/历史要登录：给一句人话和一个登录入口，别把平台的原文抛给用户。
            const message = err instanceof Error ? err.message : String(err);
            if (/需要登录|not logged in|auth/i.test(message)) {
                setNeedsLogin(true);
                setError(null);
                setSongs([]);
                setCollections([]);
            } else {
                setError(message);
                setSongs([]);
                setCollections([]);
            }
        } finally {
            // 已经被更新的请求取代时不动 loading：新的那一轮自己会收尾。
            if (requestId === requestIdRef.current) setLoading(false);
        }
    }, [mediaId, module]);

    useEffect(() => {
        void load();
    }, [load]);

    // Esc 离开这一页。
    //
    // 用项目统一的 useEscapeClose，而不是自己挂 window 监听：
    //   - 它维护一个「后注册的压在上面」的栈，一次 Esc 只关最上面那一个。这里原来
    //     自己挂的是 **捕获阶段**（addEventListener 的第三个参数 true）+ stopPropagation，
    //     于是命令面板、设置、登录 Sheet 这些冒泡阶段监听 ESC 的层全部收不到事件 ——
    //     按 Esc 关掉的是 B站页，弹窗留在原地。
    //   - 它在原生返回键（安卓返回/边缘手势派发的 Escape）时会 preventDefault，
    //     让 App 知道自己处理了这次返回；原来那版没调，App 会以为没人接管，直接退到后台。
    useEscapeClose(onClose);

    // 打开时记住来处，关掉还给它。
    useEffect(() => {
        openerRef.current = document.activeElement as HTMLElement | null;
        return () => {
            openerRef.current?.focus?.();
        };
    }, []);

    const select = useCallback((song: UnifiedSong) => {
        const ref = song.sourceRef;
        if (!ref || ref.kind !== 'online') return;
        // 先起画面（画面层等取流回来的 videoUrl），再走标准播放：音频走主播放引擎。
        // 声音不重复：画面层只放画面，声音始终由主播放引擎出。
        const bvid = bvidOf(ref);
        if (!bvid) return;
        playVideo(bvid);
        onPlay(song);
    }, [onPlay, playVideo]);

    const activeLabel = useMemo(() => t('home.biliPanelTitle'), [t]);

    return (
        <section
            ref={sectionRef}
            aria-label={activeLabel}
            // 与 FoliumHomePage 一致：这一层接管键盘，全局热键与悬停探针让它先处理。
            // 少了这个标记，页内的空格/方向键会被全局播放控制抢走。
            data-folia-keyboard-window="true"
            className="absolute inset-0 z-[60] flex min-h-0 flex-col overflow-hidden pt-8 pointer-events-auto"
            style={{ backgroundColor: theme.backgroundColor, color: theme.primaryColor }}
            onKeyDown={event => {
                if (isCommandPaletteShortcut(event.nativeEvent)) return;
                event.stopPropagation();
                // 首页自己的页签循环键：切到下一个原生页签（随之离开这一页）。
                const delta = resolveHomePageCycleKey(event.nativeEvent);
                if (delta && !event.defaultPrevented && useLibraryHomeSurfaceStore.getState().tabs?.cycleTab?.(delta)) {
                    event.preventDefault();
                    onClose();
                }
            }}
        >
            <header className="flex shrink-0 items-center gap-4 px-4 py-3 md:px-8 border-b border-current/10">
                <Button onClick={onClose} tip={t('home.biliBack')} aria-label={t('home.biliBack')}
                    className="rounded-full p-2 hover:bg-current/10">
                    <ChevronLeft size={20} />
                </Button>
                <nav className="flex flex-1 flex-wrap items-center gap-1" aria-label={t('home.biliPanelTitle')}>
                    {nativeSources.tabs.map(tab => (
                        <Button key={tab.key} disabled={Boolean(tab.disabledReason)}
                            title={tab.disabledReason || tab.label}
                            onClick={() => {
                                nativeSources.setTab(tab.key);
                                onClose();
                            }}
                            className="rounded-full px-3 py-1.5 text-sm opacity-70 hover:opacity-100 disabled:opacity-30">
                            {tab.label}
                        </Button>
                    ))}
                    <Button aria-pressed
                        className="rounded-full px-3 py-1.5 text-sm bg-current/10 font-semibold">
                        {activeLabel}
                    </Button>
                </nav>
            </header>

            {/* 模块切换：胶囊按钮组，选中项有底色 —— 与首页其它页签同一种语言。 */}
            <div className="flex shrink-0 items-center gap-2 overflow-x-auto px-4 py-3 md:px-8" role="tablist">
                {MODULES.map(item => (
                    <Button
                        key={item.id}
                        role="tab"
                        id={`${modulesId}-tab-${item.id}`}
                        aria-controls={`${modulesId}-panel`}
                        aria-selected={module === item.id}
                        variant={module === item.id ? 'primary' : 'quiet'}
                        size="sm"
                        onClick={() => setModule(item.id)}
                    >
                        {t(item.labelKey)}
                    </Button>
                ))}
            </div>

            <div id={`${modulesId}-panel`} role="tabpanel" aria-labelledby={`${modulesId}-tab-${module}`}
                className="flex min-h-0 flex-1 flex-col px-4 pb-6 md:px-8">
                {loading && <div className="text-sm opacity-60">{t('home.biliLoading')}</div>}
                {error && <div className="text-sm text-red-400">{error}</div>}
                {needsLogin && (
                    <div className="flex items-center gap-3 rounded-lg border border-current/15 px-3 py-2 text-sm">
                        <span>{t('home.biliFavoritesNeedLogin')}</span>
                        <Button size="sm" variant="primary"
                            onClick={event => openLoginWindow('bilibili', event.currentTarget)}>
                            {t('home.biliFavoritesOpenLogin')}
                        </Button>
                    </div>
                )}
                {/* 收藏有两层：目录（collections）→ 夹里的视频。原来只取 items，
                    目录被丢掉，七个模块里的「收藏」永远显示「这里还没有内容」。 */}
                {module === 'favorites' && !mediaId && collections.length > 0 && (
                    <>
                        <div className="pb-2 text-sm opacity-70">{t('home.biliFavoritesFolders')}</div>
                        <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-3 overflow-y-auto md:grid-cols-3 lg:grid-cols-4">
                            {collections.map(folder => (
                                <Button key={folder.id} variant="bare"
                                    className="flex h-auto flex-col items-start gap-1 rounded-xl border border-current/10 p-3 text-left hover:border-current/30"
                                    onClick={() => setMediaId(folder.id)}>
                                    <span className="line-clamp-2 text-[13px]">{folder.title}</span>
                                    <span className="text-xs opacity-60">{t('home.biliFavoritesFolderCount', { count: folder.count })}</span>
                                </Button>
                            ))}
                        </div>
                    </>
                )}
                <div className={`grid min-h-0 flex-1 grid-cols-2 content-start gap-3 overflow-y-auto md:grid-cols-3 lg:grid-cols-4 ${module === 'favorites' && !mediaId && collections.length > 0 ? 'hidden' : ''}`}>
                {module === 'favorites' && mediaId && (
                    <Button variant="quiet" size="sm" className="col-span-full justify-self-start"
                        onClick={() => setMediaId(null)}>
                        {t('home.biliBack')}
                    </Button>
                )}
                {songs.map(song => {
                    // 用与 select 相同的归一化：直播的 mediaId 是 "room:<id>"，而 store 里
                    // 存的是剥掉前缀的 bvid。直接拿原始 mediaId 去比，两边永不相等，
                    // 正在播的直播间就不会亮起来。
                    const isCurrent = currentBvid !== null && bvidOf(song.sourceRef) === currentBvid;
                        return (
                            <Button
                                key={song.id}
                                variant="bare"
                                className={`group flex h-auto flex-col items-start gap-2 rounded-xl p-0 text-left ${isCurrent ? 'opacity-100' : 'opacity-90 hover:opacity-100'}`}
                                onClick={() => select(song)}
                            >
                                <span className="relative block w-full overflow-hidden rounded-lg">
                                    {song.album.coverUrl && (
                                        <img
                                            src={song.album.coverUrl}
                                            alt=""
                                            className="aspect-video w-full object-cover"
                                            loading="lazy"
                                        />
                                    )}
                                    {isCurrent && (
                                        <span className="absolute bottom-1 right-1 grid h-7 w-7 place-items-center rounded-full bg-black/70 text-white">
                                            <Play size={13} fill="currentColor" />
                                        </span>
                                    )}
                                </span>
                                <span className="line-clamp-2 text-[13px]">{song.name}</span>
                                <span className="truncate text-xs opacity-60">{song.artists[0]?.name || ''}</span>
                            </Button>
                        );
                    })}
                </div>
                {!loading && songs.length === 0 && !error && !needsLogin
                    && !(module === 'favorites' && !mediaId && collections.length > 0) && (
                    <div className="text-sm opacity-60">{t('home.biliEmpty')}</div>
                )}
            </div>
        </section>
    );
}

export default BilibiliHomePage;
