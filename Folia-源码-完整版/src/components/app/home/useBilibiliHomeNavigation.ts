import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useBilibiliVideoStore } from '../../../stores/useBilibiliVideoStore';
import type { LibraryHomeExtraTab } from '../../../library/core/suite/suite.contract';

// src/components/app/home/useBilibiliHomeNavigation.ts
// B站首页页签：选中态与开关都放在 B站自己的 store 里（useBilibiliVideoStore.homeOpen），
// 不进 HomeViewTab —— 那会让全项目的页签穷举检查都要跟着改，而 B站并不是某平台的
// 歌单/电台页签，它是自带内容的独立页面，性质更接近模组页。
//
// 与模组页（FoliumHomePage）的关系：两者共用同一套 extraTab 形状，但各自持有自己的
// 选中态。同一时刻只会开一个：切到模组页就把 B站页关掉，反之亦然。

export const BILIBILI_HOME_TAB_ID = 'bilibili';

/** B站首页页签是否开着。 */
export const useBilibiliHomeOpen = (): boolean => useBilibiliVideoStore(state => state.homeOpen);

export const openBilibiliHome = (): void => useBilibiliVideoStore.getState().setHomeOpen(true);

export const closeBilibiliHome = (): void => useBilibiliVideoStore.getState().setHomeOpen(false);

/** 在 extraTabs 列表里追加 B站这一项。 */
export const useBilibiliHomeTab = (): LibraryHomeExtraTab => {
    const { t } = useTranslation();
    const open = useBilibiliHomeOpen();
    const select = useCallback(() => {
        // 不动 homeViewTab：原生页签切到「歌单」会让用户以为歌单被选中了。
        // B站页开着自己是选中态（extraTab.active），原生那一排都不算选中。
        openBilibiliHome();
    }, []);
    // 用 hook 而不是 getI18n()：首渲染时 i18n 可能还没初始化，直接读会拿到空串，
    // 于是这个页签整个消失。useTranslation 会在语言就绪后重渲染。
    return useMemo(() => ({
        id: BILIBILI_HOME_TAB_ID,
        label: t('home.biliPanelTitle'),
        active: open,
        select,
    }), [open, select, t]);
};
