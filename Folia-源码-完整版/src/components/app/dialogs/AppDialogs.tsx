import React, { useDeferredValue } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'framer-motion';
import LyricMatchDialog from '../../modal/lyric-match/LyricMatchDialog';
import UnavailableReplacementDialog from '../../modal/UnavailableReplacementDialog';
import JamSettingsDialog from '../../jam/JamSettingsDialog';
import SettingsModal from '../../modal/SettingsModal';
import ConfirmDialog from '../../shared/ConfirmDialog';
import type { AppDialogsModel } from './buildAppDialogsModel';
import { StatusToast } from './StatusToast';
import { countRender } from '../../../dev/renderCount';

// Centralized app-level dialog and toast renderer for the player shell.
type AppDialogsProps = {
    model: AppDialogsModel;
};

const AppDialogs: React.FC<AppDialogsProps> = ({ model }) => {
    countRender('AppDialogs');
    const { statusToast, lyricMatchDialog, unavailableReplacementDialog, settingsDialog, wallpaperEntryConfirmDialog } = model;
    // The settings window is the largest tree the app mounts at a click. Read deferred, it is
    // rendered in slices between frames rather than in the click's own task, which held every frame
    // (the panel closing, the picture) until all of it was built. Closing is not deferred: the
    // window leaves with the click.
    const isSettingsShown = useDeferredValue(settingsDialog != null);

    return (
        <>
            {createPortal(
                <div className="pointer-events-none fixed inset-x-0 top-[30px] z-[210] grid justify-items-center px-4">
                    <AnimatePresence>
                        {statusToast && <StatusToast key={statusToast.toastKey} toast={statusToast} />}
                    </AnimatePresence>
                </div>,
                document.body,
            )}

            {lyricMatchDialog && <LyricMatchDialog {...lyricMatchDialog} />}
            {unavailableReplacementDialog && <UnavailableReplacementDialog {...unavailableReplacementDialog} />}
            {wallpaperEntryConfirmDialog && <ConfirmDialog {...wallpaperEntryConfirmDialog} />}
            {/* 「一起听」面板常驻全局层：入口在播放页面板 account 页，只置 uiOpen 即可打开，
                不依赖设置弹窗是否挂载（否则从播放页点击会毫无反应）。 */}
            <JamSettingsDialog />
            <AnimatePresence>
                {isSettingsShown && settingsDialog && <SettingsModal {...settingsDialog} />}
            </AnimatePresence>
        </>
    );
};

export default React.memo(AppDialogs);
