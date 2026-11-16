import { Buffer } from 'buffer';
import { ensureBackgroundRenderGateInstalled } from './utils/backgroundRenderGate';
import { installGlobalVisualizerFrameRateLimiter } from './utils/frameRateLimiter';
import { installRenderPixelRatioLimit } from './utils/renderPixelRatio';
import { installConsoleLogCapture } from './utils/consoleLogBuffer';
import { installDebugModule } from './services/debug/debugModule';
import { installMemorySampleFeed } from './services/debug/memorySamples';
import { installNativeAndroidBridge } from './services/nativeAndroidBridge';
import { installPerfDiagnosticsSwitch } from './utils/frameTimingDiagnostics';
import { createMicroRenderPort } from './stores/useMicroRenderStore';
import { installMicroRenderScheduler, registerRenderClient } from './utils/microRender';
import { ensureWhalePet, bindWhaleSplashTakeover } from './whalePet/init';
import { playWhaleSplash, pickWhaleSplashAnim } from './whalePet/splash';
import { isFloatingReady, startWhalePet, revealWhalePet, stopWhalePet, setSplashFloatingMode } from './whalePet/floating';
import { isDesktopPetHost, hideInlinePetForDesktop, startDesktopPet, stopDesktopPet, mirrorDesktopPet } from './whalePet/desktop';
import { setMediaDiagnosticsEnabledReader } from './utils/mediaDiagnostics';
import { usePerfDiagnosticsStore } from './stores/usePerfDiagnosticsStore';
import { installAndroidPhoneFitPreference, installDeviceProfilePreference } from './services/androidPhoneLayout';
import { installHdrProjectionPreference } from './services/hdrProjection';
// import { installCoverSizeAudit } from './services/debug/coverSizeSamples';
// @ts-ignore
globalThis.Buffer = Buffer;

// 挂载 React 必须万无一失：下面的顶层副作用（microRender / 调试 / 限帧 / 手机适配等）任意一个
// 若同步抛错，模块执行就会中断，写在文件中间的 `import('./bootstrap')` 便不会运行，React 永不
// 挂载，index.html 的 #app-splash 遮罩也就永久停在首屏动画上（表现为「卡在启动页」）。
// 用微任务在最顶部就把 bootstrap 排队：它在本轮全部同步初始化之后才执行（顺序不变，所有 shim
// 都先装好），而 JS 语义保证即便中途有同步代码抛错，已排队的微任务依然会被清空执行。
// 这是治本的一道；index.html 里另有一道纯内联看门狗兜底，两道都不依赖对方。
queueMicrotask(() => { void import('./bootstrap'); });

// First, so the debug overlay's console tab has the startup lines too - they are where a failure
// to reach a library or restore a session shows up.
installConsoleLogCapture();
// Right after it, so the startup lines reach the runtime log file too and not only the in-memory
// buffer. Both no-op off Electron. See services/debug/debugModule.ts.
installDebugModule();
installMemorySampleFeed();
// Cover size audit, left wired but switched off: it answered whether the provider CDNs honour the
// size in a cover URL - they do - and that is not a question worth re-asking every session. The
// collector and its panel are still in the tree, and `?probe=coverSizeAudit` still reaches them.
// To bring the tab back, uncomment this line and the four sites in DevDebugOverlay.tsx. It was dev
// only even then: a packaged build has nothing to do with the answer, so it should not pay the
// observer or the rows it retains.
// if (import.meta.env.DEV) installCoverSizeAudit();
/*
 * 后台渲染总闸。必须装在下面那个帧率限制器**之前**：限制器会把「当时的」原生 rAF 存起来
 * 当底层用，装在它后面就只能拦到没被限制的那部分循环。
 *
 * 装了不等于暂停 —— 只是把 rAF 过一道闸，真正翻转开关的是 useBackgroundRenderPause
 * （挂在主界面上）。壁纸叠层是另一个入口（wallpaper.html），不经过这里，所以它在桌面
 * 上照常渲染。
 */
ensureBackgroundRenderGateInstalled();
installGlobalVisualizerFrameRateLimiter();
installRenderPixelRatioLimit();
/*
 * 微渲染引擎 GPU 调度。必须装在上面两个总闸之后：采样走 requestUncappedAnimationFrame
 * 取的是限帧器安装时收好的原生 rAF，装在前面会把「限帧后的节奏」误读成掉帧。
 *
 * 端口每秒读一次 localStorage，不订阅 useVisualizerSettingsStore：用户改帧率/分辨率时
 * 那个 store 的 action 已经即时应用并写盘，下一窗口自然跟上；壁纸等独立 document 也能
 * 复用同一份端口。调度器只把预算往下让，用户手选档位始终是天花板。
 */
registerRenderClient({ id: 'main-visualizer', priority: 'primary', kind: 'webgl2', usesGpu: true });
installMicroRenderScheduler({ port: createMicroRenderPort(), layerPriority: 'primary', label: 'main' });
/*
 * 帧耗时 / 长任务采样。用户报「卡顿」时靠它区分「我们的渲染开销」与「设备性能不足」，
 * 在调试面板的 Perf 页看。必须装在帧率限制器之后：它优先用限制器保存的原生 rAF，
 * 否则会把用户自己设的帧率上限当成掉帧。
 *
 * **默认不采样**，由开发者选项里的「性能采样」开关控制（见 usePerfDiagnosticsStore）：
 * 这条 rAF 循环是常驻开销，只有真在查问题的时候才该付。开关可以随时翻，
 * 这里订阅它做启停。
 *
 * 采样模块自己不 import store（utils → stores 是反的依赖方向），所以读值与订阅在这里
 * 接给它；媒体诊断那份计数用的是同一个开关，只要读值（每个音频事件问一次现值，
 * 不需要订阅）。
 */
const perfDiagnosticsPort = {
    isEnabled: () => usePerfDiagnosticsStore.getState().perfDiagnosticsEnabled,
    subscribe: (listener: (enabled: boolean) => void) => {
        usePerfDiagnosticsStore.subscribe((state) => listener(state.perfDiagnosticsEnabled));
    },
};
installPerfDiagnosticsSwitch(perfDiagnosticsPort);
setMediaDiagnosticsEnabledReader(perfDiagnosticsPort.isEnabled);
// 本地登录的地基：把内置的接口代码挂到页面与原生之间。它是异步的（要 import 那份 JS），
// 但装好之前页面发来的请求会被排队，装好后统一补发，所以不用 await。
void installNativeAndroidBridge();
// 手机适配的属性必须在首帧之前落到 <html> 上：否则用户开了开关后，React 挂载那一瞬
// 会先按桌面布局量一遍尺寸，再被 CSS 拉回手机布局，开屏那一下看得见跳变。
installAndroidPhoneFitPreference();

/*
 * 手机/窄屏自适应：上游把「手机适配」入口从设置里删掉了（那边认为桌面布局够用），
 * 但在手机上（宽度 < 600px）桌面布局会把内容压成一竖条 —— 侧栏 + 内容区硬挤。
 * 这里在窄视口上自动启用同一套 androidPhoneFit 样式；宽屏（桌面/平板）保持桌面布局不变。
 * 用 matchMedia 监听，旋转屏幕/拖动窗口时自动切换。
 */
if (typeof window !== 'undefined') {
    try {
        const phoneQuery = window.matchMedia('(max-width: 599px)');
        const applyNarrowLayout = () => {
            // 只在真正的触屏/窄屏上接管，桌面端缩窗口不受影响
            const coarse = window.matchMedia('(pointer: coarse)').matches;
            const shouldFit = phoneQuery.matches && coarse;
            document.documentElement.setAttribute('data-folia-phone-fit', shouldFit ? 'true' : 'false');
        };
        applyNarrowLayout();
        if (phoneQuery.addEventListener) phoneQuery.addEventListener('change', applyNarrowLayout);
        else phoneQuery.addListener(applyNarrowLayout);
    } catch { /* 静默 */ }
}
// 设备类型（手机 / 平板）：选了手机的话横屏整屏缩一档，同样要在首帧之前落到 <html> 上，
// 否则第一帧按原始尺寸铺完再缩，开屏那一下看得见跳变。
installDeviceProfilePreference();
// HDR 投影：上次开着的话，镜像要在首帧之前落到 <html> 上（理由同上），剩下的横屏与
// 亮度由它自己那 5 秒倒计时带过去 —— 那时 React 还没挂载，界面上没人看着。
installHdrProjectionPreference();

// bootstrap 已在本文件顶部用 queueMicrotask 排队挂载（见开头说明），此处不再重复 import。

// 鲸鱼开屏：全屏纯黑 + 中央随机鲸鱼动画，播完鲸鱼飞到桌宠位置；
// 桌宠提前挂载并静默预载同一段动画，飞到位后 takeOver 瞬间接管（视觉连续，无跳变）
if (typeof window !== 'undefined') {
    (async () => {
        try {
            const splashAnim = pickWhaleSplashAnim();

            // ── 桌面端（Electron）独立路径：与 Android 浮层方案完全分开 ──
            // 不进入 isFloatingReady()（桌面端已无浮层宿主，会白等 1s）、不把
            // window.__whalePet 换成代理、不铺全屏开屏黑幕、不 await 任何桌宠 IPC。
            // 主 WebView 保持原有真实桌宠实例与全部既有逻辑（联动 / 设置页 / 托盘 /
            // 后台唤起），置顶窗口由主进程自包含驱动：建窗 → 中央放大态开屏 →
            // 3 秒后主进程自己做窗口几何过渡 → 落点。两端互不牵连。
            if (isDesktopPetHost()) {
                const pet = ensureWhalePet({ initialAnim: splashAnim.id });
                hideInlinePetForDesktop();
                let saved: Record<string, unknown> | null = null;
                let willSplash = true;
                try {
                    saved = JSON.parse(localStorage.getItem('whale-pet-settings') || 'null');
                    willSplash = !saved || (saved.enabled !== false && saved.splash !== false);
                } catch { /* 读不到按开启处理 */ }
                if (!saved || saved.enabled !== false) {
                    startDesktopPet({ ...(saved || {}), enabled: true, initialAnim: splashAnim.id }, { splash: willSplash });
                    if (pet) mirrorDesktopPet();
                } else {
                    stopDesktopPet();
                }
                return;
            }

            bindWhaleSplashTakeover();
            // 等 Capacitor 桥 / 浮层插件就绪再决策（通常即时，最长 ~1s）。
            // 一次性判定浮层模式并全程复用：避免「开屏瞬间误判非浮层→主屏多建一只鲸鱼」与浮层那只
            // 在屏幕中央重叠成「两只」的竞态。
            const floating = await isFloatingReady();
            setSplashFloatingMode(floating);

            if (floating) {
                // —— 浮层模式：屏幕上只有浮层窗口这一只鲸鱼 ——
                // 它以「屏幕中央放大态」建窗并播开屏动画；主 WebView 只铺黑幕，不渲染
                // 第二个 <video>。3 秒后原生把同一个窗口连续变换到常驻落点，无接管/无换算。
                ensureWhalePet({ initialAnim: splashAnim.id });   // 浮层模式 → 代理（主屏不建 DOM），并建立联动层
                // 兜底：主 WebView 里一律不显示任何应用内桌宠 DOM。即使别处因桥时序早于判定
                // 建出了真实桌宠，也不会与浮层那只同屏 —— 彻底杜绝「开屏两只鲸鱼」。
                // 注意这只作用于主 WebView；浮层是独立 WebView 加载 whale-float.html，不受影响。
                if (!document.getElementById('whale-no-inline-pet')) {
                    const guard = document.createElement('style');
                    guard.id = 'whale-no-inline-pet';
                    guard.textContent = '.whale-pet{display:none!important}';
                    document.head.appendChild(guard);
                }
                let saved: Record<string, unknown> | null = null;
                let willSplash = true;
                try {
                    saved = JSON.parse(localStorage.getItem('whale-pet-settings') || 'null');
                    willSplash = !saved || (saved.enabled !== false && saved.splash !== false);
                } catch { /* 读不到就按开启处理 */ }

                if (!saved || saved.enabled !== false) {
                    // splash=willSplash：要播开屏时窗口以「放大居中态」建窗；用户关了开屏
                    // 动画时窗口直接以落点尺寸/位置建好，不会停在放大态。
                    await startWhalePet({ ...(saved || {}), enabled: true, initialAnim: splashAnim.id }, { splash: willSplash });
                    if (willSplash) {
                        // 主 WebView 只铺黑幕（floating:true 绝不建开屏 video）。唯一的鲸鱼是
                        // 浮层窗口：它自己播开屏、自己通过窗口几何过渡飞到上次拖拽的位置。
                        // 不再查询/换算落点 —— 终点全在原生侧用同一套坐标算，误差恒为 0。
                        void playWhaleSplash(splashAnim, { floating: true })
                            .then((r) => { if (!r) void revealWhalePet(); });   // 开屏被跳过 → 立即落位
                    } else {
                        void revealWhalePet();
                    }
                }
            } else {
                // —— 非浮层兜底：主 WebView 自有桌宠 + 完整开屏过渡（原始单只动画） ——
                // 先停掉可能残留的浮层服务（START_STICKY 会自动拉起），否则会与应用内桌宠
                // 同时显示成「两只鲸鱼」。
                void stopWhalePet();
                const pet = ensureWhalePet({ initialAnim: splashAnim.id });
                void playWhaleSplash(splashAnim).then((result) => {
                    if (!result && pet && pet.settings.enabled && !(window as { __whaleSplashTookOver?: boolean }).__whaleSplashTookOver) pet.boot();
                });
            }
        } catch {
            // 桌面端无需兜底：主进程 splashTimer 会自行完成 3 秒后的落位，
            // 重复 start 反而会用只有 enabled 的 settings 覆盖用户设置（size/roam/splash 全丢）。
            // Android 仍走浮层立即落位。
            if (!isDesktopPetHost()) void revealWhalePet();
        }
    })();
}
