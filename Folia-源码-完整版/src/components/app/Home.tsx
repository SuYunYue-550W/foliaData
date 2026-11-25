import React, { useEffect, useLayoutEffect } from 'react';
import GridViewOverlayHost from '../../library/app/GridViewOverlayHost';
import LibraryAccountHost from '../../library/app/LibraryAccountHost';
import { resolveLibrarySurface } from '../../library/registry';
import { useLibrarySuiteStore } from '../../library/core/suite/useLibrarySuiteStore';
import { useLibraryDirectoryBatchController } from '../../library/app/useLibraryDirectoryBatchController';
import { useLibraryHomeResources } from '../../library/app/useLibraryHomeResources';
import type { HomeViewModel } from './home/buildHomeModel';
import { useFoliumHomeNavigation } from './home/useFoliumHomeNavigation';
import { closeFoliumHomeTab } from '../../mods/folium/registries/homeTabs';
import { FoliumHomePage } from './home/FoliumHomePage';
import { BilibiliHomePage } from './home/BilibiliHomePage';
import { closeBilibiliHome, useBilibiliHomeOpen, useBilibiliHomeTab } from './home/useBilibiliHomeNavigation';
import { countRender } from '../../dev/renderCount';

// App-level entry for the home surface backed by a view model.
// 首页 surface 经 Library registry 解析：选中的 suite 实现了首页就用它，否则回退默认 suite（网格的 Grid3D）。
// 外壳只交出首页模型与打开集合的入口，不直接 import 任何 suite。
type AppHomeProps = {
    model: HomeViewModel;
    isHomeFullyHidden?: boolean;
    isInteractive?: boolean;
};

const Home: React.FC<AppHomeProps> = ({ model, isHomeFullyHidden, isInteractive = true }) => {
    countRender('Home');
    // 模组的首页页面：外壳只订阅生成扩展页签必需的条目与选中态；页面自己要的订阅随 FoliumHomePage 挂载。
    const { extraTabs, activeEntry } = useFoliumHomeNavigation();
    // B站作为首页的一级页签：与原生页签、模组页并列，同一时刻只开一个。
    const bilibiliOpen = useBilibiliHomeOpen();
    const bilibiliTab = useBilibiliHomeTab();
    const homeExtraTabs = [...extraTabs, bilibiliTab];
    // 两个整屏页面（B站页、模组页）不叠着：开一个关另一个。互斥放在组装层做 ——
    // mods 目录不依赖 components，反过来也一样，扯不清谁该管谁。
    // 用 useLayoutEffect 而不是 useEffect：useEffect 在浏览器画完那一帧后才跑，
    // 两个 z-[60] 的整屏页会同时露出一帧再关掉一个（切页时闪一下）。
    // layout effect 在 DOM 提交后、绘制前同步跑完，那一帧用户根本看不到。
    useLayoutEffect(() => {
        if (bilibiliOpen) closeFoliumHomeTab();
    }, [bilibiliOpen]);
    useLayoutEffect(() => {
        if (activeEntry) closeBilibiliHome();
    }, [activeEntry]);
    // 只在切换 suite 时变（开发版浮层）；同一个回退结果是同一个组件，首页不会因此重新挂载。
    const suiteId = useLibrarySuiteStore(state => state.suite);
    // 目录批量动作（本地文件夹 / 专辑 / 歌手的播放、入队、建歌单、删除、重扫）：首页一个控制器，不随渲染重建。
    const directoryActions = useLibraryDirectoryBatchController(model.surfaceProps);
    // 首页资源（在线收藏专辑、电台 feed、Navidrome 概览、文件夹树、导入与打开等首页动作）：首页一份，任何 suite 的
    // 首页都订阅同一份，换 suite 不重新请求；首页整个藏起或卸载时才作废（回来重新读）。
    const homeResources = useLibraryHomeResources(model.surfaceProps, { active: !isHomeFullyHidden });
    if (isHomeFullyHidden) {
        return null;
    }

    const homeSurface = resolveLibrarySurface('home', suiteId);
    const HomeSurface = homeSurface.component;
    // 模组页开着时把 B站页关掉，反之亦然：两个整屏页面不叠着。
    const anyOwnedPageOpen = Boolean(activeEntry) || bilibiliOpen;

    return (
        <>
            {/* 模组页面开着时原生首页整层 inert，并且自成层叠上下文（isolate）：集合层（GridView / GridMap / TUI 的
                z-[110]）、宿主对话框（z-[120]/[140]）、开发版 suite 切换浮层只在这一层里比高低，整层压在页面（z-[60]）
                下面——集合开着时 openHomeTab 打开的页面不会被它盖住。就地渲染的登录弹窗不在这一层里，仍在页面之上。 */}
            <div className={anyOwnedPageOpen ? 'absolute inset-0 isolate' : 'absolute inset-0'} inert={anyOwnedPageOpen}>
                <GridViewOverlayHost
                    surfaceProps={model.surfaceProps}
                    onOpenCollection={model.onOpenCollection}
                    onPushCollection={model.onPushCollection}
                    onPopCollectionTo={model.onPopCollectionTo}
                    onBackCollection={model.onBackCollection}
                    isInteractive={isInteractive && !anyOwnedPageOpen}
                >
                    {(openGridView, isHomeGridInteractive) => (
                        <React.Suspense fallback={null}>
                            <HomeSurface
                                {...model.surfaceProps}
                                account={model.account}
                                extraTabs={homeExtraTabs}
                                onNativeTabSelected={() => { closeFoliumHomeTab(); closeBilibiliHome(); }}
                                onOpenGridView={openGridView}
                                isInteractive={isHomeGridInteractive}
                                declaredActions={homeSurface.declaredActions}
                                directoryActions={directoryActions}
                                homeResources={homeResources}
                            />
                        </React.Suspense>
                    )}
                </GridViewOverlayHost>
            </div>
            {activeEntry && (
                <FoliumHomePage entry={activeEntry} extraTabs={homeExtraTabs}
                    account={model.account} surfaceProps={model.surfaceProps} />
            )}
            {bilibiliOpen && (
                <BilibiliHomePage
                    onClose={closeBilibiliHome}
                    onPlay={song => model.surfaceProps.onPlaySong(song, [], false)}
                    account={model.account}
                    surfaceProps={model.surfaceProps}
                />
            )}
            {/* 登录弹窗与切换确认框：寿命与首页 surface 相同（首页整个藏起时卸载），换 suite 不卸载。 */}
            <LibraryAccountHost
                account={model.account}
                theme={model.surfaceProps.theme}
                isInteractive={isInteractive}
            />
        </>
    );
};

// Memoised because App re-renders on every store write anywhere in the app, while `homeModel`
// only changes for the 35 values it is actually built from. Without this the whole home tree
// re-runs for a volume drag.
export default React.memo(Home);
