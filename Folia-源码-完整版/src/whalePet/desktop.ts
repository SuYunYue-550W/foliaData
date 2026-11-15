// 桌面端（Electron）系统级置顶桌宠的**独立入口**。
//
// 与 Android 浮层方案（floating.ts 宿主 + init.ts 代理 + splash.ts 全屏黑幕）完全解耦：
//   1. 主 WebView 保留原有真实桌宠实例 window.__whalePet —— 播放联动、设置页、托盘、
//      后台唤起等所有既有代码路径原样运行，绝不替换成转发代理；
//   2. 主 WebView 不铺全屏开屏黑幕 —— 桌面端开屏由置顶窗口自己在中央放大态播放，
//      避免遮罩在「最小化到托盘 / 后台」时挡住「显示窗口」等按键；
//   3. 置顶窗口由 electron/whalePetWindow.cjs 在主进程自包含管理：建窗、开屏、
//      3 秒后的窗口几何过渡、拖拽、漫游、位置持久化全在主进程完成，不依赖渲染进程
//      心跳或 Web 层定时器 —— 主窗口被后台节流也不会让鲸鱼卡在放大态；
//   4. 所有 IPC 一律 fire-and-forget，主窗口启动绝不 await 桌宠窗口。
//
// 与 Android 唯一共享的是静态资源（pet.js / catalog.js / webm），不共享任何运行时链路。
// 拖拽走的是「独立窗口 #hit 层 → whalePetPreload → 主进程 setBounds」的短链路，
// 不经过任何 WebView 代理，因此不会因主窗口状态而失效。

const SETTINGS_KEY = 'whale-pet-settings';

type DesktopHost = {
    startFloatingWhale: (args: Record<string, unknown>) => Promise<unknown>;
    stopFloatingWhale: () => Promise<unknown>;
    invokeWhale: (args: { method: string; args: string }) => Promise<unknown>;
};

function host(): DesktopHost | null {
    try {
        // 手机上不生效（同一份前端也会打进 Capacitor 包）
        const cap = (window as any).Capacitor;
        if (cap && cap.getPlatform?.() === 'android') return null;
        const h = (window as any).electron?.whalePet;
        return h && typeof h.startFloatingWhale === 'function' ? (h as DesktopHost) : null;
    } catch {
        return null;
    }
}

/** 当前是否为支持独立置顶桌宠窗口的 Electron 宿主。 */
export function isDesktopPetHost(): boolean {
    return host() !== null;
}

/**
 * 只把主窗口内那只 DOM 鲸鱼「隐身」，不销毁、不改成 display:none。
 * visibility:hidden 保留布局尺寸，pet.js 的 getBoundingClientRect / --pet-size 计算
 * 不会退化成 0，避免拖动与漫游坐标出现显示性错误。
 */
export function hideInlinePetForDesktop(): void {
    if (typeof document === 'undefined' || document.getElementById('whale-desktop-inline-hide')) return;
    const style = document.createElement('style');
    style.id = 'whale-desktop-inline-hide';
    style.textContent = '.whale-pet{visibility:hidden!important;pointer-events:none!important}';
    document.head.appendChild(style);
}

/**
 * 读取「应用内桌宠」上次拖拽的位置，换算成屏幕中心比例作为置顶窗口的首启落点。
 * 与 Android 的 initFracX/Y 语义一致，但这里是桌面端独立实现，不 import floating.ts。
 */
function readSeedFraction(): { x: number; y: number } | null {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (typeof s.x !== 'number' || typeof s.y !== 'number') return null;
        const W = window.innerWidth || 1, H = window.innerHeight || 1;
        const size = typeof s.size === 'number' ? s.size : 240;
        const fx = (W / 2 + s.x) / W;
        const fy = (s.y + size * 0.5625 / 2) / H;
        return isFinite(fx) && isFinite(fy) ? { x: fx, y: fy } : null;
    } catch {
        return null;
    }
}

/** 启动置顶窗口。fire-and-forget：主窗口不等待，IPC 失败也不影响主界面。 */
export function startDesktopPet(settings: Record<string, unknown>, opts?: { splash?: boolean }): void {
    const h = host();
    if (!h) return;
    const args: Record<string, unknown> = {
        settings: JSON.stringify(settings),
        splash: !!opts?.splash,
    };
    // 系统「减弱动态效果」偏好：主进程跳过放大态开屏，直接以落点尺寸/位置建窗。
    try {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) args.reduceMotion = true;
    } catch { /* ignore */ }
    const seed = readSeedFraction();
    if (seed) { args.initFracX = seed.x; args.initFracY = seed.y; }
    try { void Promise.resolve(h.startFloatingWhale(args)).catch(() => {}); } catch { /* ignore */ }
}

/** 单向同步：把一次桌宠方法调用转发到置顶窗口。 */
export function syncDesktopPet(method: string, args: unknown[] = []): void {
    const h = host();
    if (!h) return;
    try {
        void Promise.resolve(h.invokeWhale({ method, args: JSON.stringify(args) })).catch(() => {});
    } catch { /* ignore */ }
}

export function stopDesktopPet(): void {
    const h = host();
    if (!h) return;
    try { void Promise.resolve(h.stopFloatingWhale()).catch(() => {}); } catch { /* ignore */ }
}

// 记录**已被镜像的那个实例**：桌宠实例可能被 destroy 后重建（ensureWhalePet 幂等挡板放行），
// 只靠实例上的标记会导致重建后镜像永久失效。用引用比较，每次调用都重新判断。
let mirroredPet: unknown = null;

/**
 * 单向镜像：仅在真实实例的方法执行完之后，额外转发一份到置顶窗口。
 * 不替换实例、不改 settings 引用、不订阅全局浮层模式 —— 主 WebView 行为完全不变。
 * 只镜像设置与联动类方法，不镜像 play/takeOver，避免干扰置顶窗口自己的开屏动画。
 */
export function mirrorDesktopPet(): void {
    const pet = (window as any).__whalePet;
    if (!pet || pet === mirroredPet) return;
    mirroredPet = pet;
    const wrap = (name: string) => {
        const orig = pet[name];
        if (typeof orig !== 'function') return;
        pet[name] = function (this: unknown, ...a: unknown[]) {
            try { return orig.apply(this, a); } finally { syncDesktopPet(name, a); }
        };
    };
    // resetPos 必须镜像：否则桌面端点「回到顶部居中」只有隐身的 DOM 鲸鱼在动。
    ['applySettings', 'react', 'showTip', 'pulse', 'resetPos'].forEach(wrap);
}
