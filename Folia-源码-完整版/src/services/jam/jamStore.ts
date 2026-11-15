// src/services/jam/jamStore.ts
// 「一起听」的界面状态。协议与传输在 jamProtocol / jamClient，这里只放 UI 要读的东西。

import { create } from 'zustand';
import type { JamConnectionState } from './jamClient';

export type JamRole = 'host' | 'guest';

type JamStoreState = {
    /** 面板开关（挂载在设置弹窗的子窗口层）。 */
    uiOpen: boolean;
    role: JamRole | null;
    roomCode: string | null;
    connection: JamConnectionState;
    memberCount: number;
    lastError: string | null;
    /** 客机提示「跟随房主中」的节流戳，UI 不直接读。 */
    lastFollowNoticeAt: number;

    setUiOpen: (open: boolean) => void;
    setRole: (role: JamRole | null) => void;
    setRoomCode: (code: string | null) => void;
    setConnection: (state: JamConnectionState) => void;
    setMemberCount: (count: number) => void;
    setError: (error: string | null) => void;
    markFollowNotice: () => void;
    reset: () => void;
};

export const useJamStore = create<JamStoreState>((set) => ({
    uiOpen: false,
    role: null,
    roomCode: null,
    connection: 'idle',
    memberCount: 0,
    lastError: null,
    lastFollowNoticeAt: 0,

    setUiOpen: (uiOpen) => set({ uiOpen }),
    setRole: (role) => set({ role }),
    setRoomCode: (roomCode) => set({ roomCode }),
    setConnection: (connection) => set({ connection }),
    setMemberCount: (memberCount) => set({ memberCount }),
    setError: (lastError) => set({ lastError }),
    markFollowNotice: () => set({ lastFollowNoticeAt: Date.now() }),
    reset: () => set({ role: null, roomCode: null, connection: 'idle', memberCount: 0, lastError: null }),
}));

/** 给面板外部的入口（播放页面板里的按钮）用。 */
export const openJamPanel = () => useJamStore.getState().setUiOpen(true);
export const closeJamPanel = () => useJamStore.getState().setUiOpen(false);
