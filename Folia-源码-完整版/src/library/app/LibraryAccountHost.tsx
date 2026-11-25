import React, { useEffect } from 'react';
import type { Theme } from '../../types';
import type { LibraryAccountController } from '../core/account/account.contract';
import { useLibrarySuiteStore } from '../core/suite/useLibrarySuiteStore';
import { resolveLibrarySurface } from '../registry';
import { useThemeSettingsStore } from '../../stores/useThemeSettingsStore';

// src/library/app/LibraryAccountHost.tsx
// 在线账户的界面宿主（Library v2 · A4，A5 起按 suite 解析）：挂在首页外壳里（寿命与首页相同，换 suite 不卸载），
// 经 registry 按当前选中的 suite 解析 account surface 并渲染——选中的 suite 没有它就整体回退网格的
// GridAccountSurface（切换确认框）。宿主只交出 controller、主题、可交互标记与声明的动作，
// portal 位置由 suite 决定；宿主不 import 任何 suite 的组件，也不 import 组件：
// 登录窗口（src/components/login 的 LoginHost）挂在 App 最外层，换 suite、离开首页都不卸载。
// 宿主卸载（首页整个藏起）时关闭登录、取消待确认切换。换 suite 只换 surface 组件，controller 里的登录会话与
// 待确认切换不受影响，新 suite 接着显示。

type LibraryAccountHostProps = {
    account: LibraryAccountController;
    theme: Theme;
    /** 首页外壳的可交互标记（account surface 的键盘只在它为真时生效）。 */
    isInteractive: boolean;
};

const LibraryAccountHost: React.FC<LibraryAccountHostProps> = ({ account, theme, isInteractive }) => {
    // 只在切换 suite 时变；同一个回退结果是同一个组件，在两个都回退到网格的 suite 之间切换不会让弹窗重新挂载。
    const suiteId = useLibrarySuiteStore(state => state.suite);
    const isDaylight = useThemeSettingsStore(state => state.isDaylight);

    // 这个宿主会随首页隐藏/显示反复卸载挂载（进播放页、打开模组整屏页等），
    // 而登录窗口挂在 App 根部、不随它卸载。原来这里无条件 closeLogin()，
    // 于是首页一藏就把正在扫码的会话停掉了，用户看着窗口却怎么扫都没反应。
    // 登录会话的寿命交给 LoginHost（用户关窗口/取消时才清）；这里只处理
    // 属于「资料库这一层」的待确认账号切换。
    useEffect(() => () => {
        const pending = account.getSnapshot().pendingSwitch;
        if (pending) account.cancelSwitch(pending.id);
    }, [account]);

    const accountSurface = resolveLibrarySurface('account', suiteId);
    const AccountSurface = accountSurface.component;

    return (
        <React.Suspense fallback={null}>
            <AccountSurface
                account={account}
                theme={theme}
                isDaylight={isDaylight}
                isInteractive={isInteractive}
                declaredActions={accountSurface.declaredActions}
            />
        </React.Suspense>
    );
};

export default LibraryAccountHost;
