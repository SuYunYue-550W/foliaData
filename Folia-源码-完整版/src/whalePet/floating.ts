// 鲸鱼桌宠「系统级浮层」的 Web 桥接层（**仅 Android 生效**）。
//
// 设计：桌宠本体只渲染在 FloatingWhaleService 的独立 WebView（WindowManager
// TYPE_APPLICATION_OVERLAY）里，因此它能浮在其他应用之上（含 Folia 自身）。
// 主 WebView 不再渲染桌宠 DOM —— 全局只有「一只鲸鱼」。
// 主 WebView 里所有对桌宠的操作（设置页 applySettings、联动 pulse/showTip/react）
// 都经此桥接转发给浮层 WebView，由 init.ts 的 getWhalePet() 代理统一出口。
//
// 桌面端（Electron）**不走这里**：它使用 src/whalePet/desktop.ts 的独立入口，
// 主 WebView 保持原有真实桌宠实例与全部既有逻辑，置顶窗口由主进程自包含管理。
// 两端不共用运行时链路，避免主窗口 / 托盘 / 后台唤起被浮层代理牵连。
//
// 调用约定：Capacitor 插件方法返回 Promise，解析为标准 JS 对象。

type WhaleResult = { granted?: boolean; running?: boolean; opened?: boolean; notify?: boolean };

/** 浮层宿主：仅 Android 的 FoliaNative 插件。桌面端绝不返回宿主。 */
function foliaNative(): any | null {
    try {
        const cap = (window as any).Capacitor;
        if (cap && cap.getPlatform?.() === 'android' && cap.Plugins?.FoliaNative) {
            return cap.Plugins.FoliaNative;
        }
    } catch { /* ignore */ }
    return null;
}

/** 当前是否运行在支持系统级浮层的平台（仅 Android）。 */
export function isWhalePetSupported(): boolean {
    return foliaNative() !== null;
}

/**
 * 等待「浮层能力」就绪：Capacitor 桥 / FoliaNative 插件在开屏那一刻可能尚未注册完成，
 * 若此刻就用 isWhalePetSupported() 决策，会误判为非浮层 → 主屏多建一只鲸鱼，与稍后起来的
 * 浮层鲸鱼重叠成「两只」。这里最多轮询 ~1s，一旦插件可用立即返回 true；超时未就绪则 false
 * （走非浮层兜底）。调用一次、结果全程复用，避免「先非浮层后浮层」的竞态。
 */
export function isFloatingReady(): Promise<boolean> {
    return new Promise((resolve) => {
        if (isWhalePetSupported()) { resolve(true); return; }
        let tries = 0;
        const tick = () => {
            if (isWhalePetSupported()) { resolve(true); return; }
            if (++tries > 20) { resolve(false); return; }   // 20 * 50ms ≈ 1s
            setTimeout(tick, 50);
        };
        tick();
    });
}

/**
 * 本次启动的开屏模式标记。由 index.tsx 在 isFloatingReady() 一次性判定后写入，接管钩子
 * 据此分流，避免到接管时再靠 isWhalePetSupported() 猜（那时浮层服务可能已停但插件仍在）。
 */
let splashFloatingMode = false;
export function setSplashFloatingMode(v: boolean): void { splashFloatingMode = v; }
export function isSplashFloatingMode(): boolean { return splashFloatingMode; }

/** 是否已获得「显示在其他应用上层」权限。 */
export async function canDrawOverlay(): Promise<boolean> {
    const p = foliaNative();
    if (!p) return false;
    try {
        const r: WhaleResult = await p.canDrawOverlay();
        return !!r?.granted;
    } catch {
        return false;
    }
}

/** 跳转到系统设置页，引导用户授予悬浮窗权限。 */
export async function openOverlaySettings(): Promise<void> {
    const p = foliaNative();
    if (!p) return;
    try {
        await p.openOverlaySettings();
    } catch {
        /* 跳转失败（如 ROM 无此设置项）静默忽略 */
    }
}

/** 跳转到本应用通知设置页，引导用户授予通知权限（Android 13+ 前台服务必需）。 */
export async function openNotificationSettings(): Promise<void> {
    const p = foliaNative();
    if (!p) return;
    try {
        await p.openNotificationSettings();
    } catch {
        /* 跳转失败静默忽略 */
    }
}

/** 启动桌宠浮层（前台服务 + WindowManager OVERLAY），并透传当前桌宠设置。 */
export async function startWhalePet(settings: Record<string, unknown>, opts?: { splash?: boolean }): Promise<{
    running: boolean;
    granted: boolean;
    notify: boolean;
}> {
    const p = foliaNative();
    if (!p) return { running: false, granted: false, notify: false };
    try {
        // 浮层首启（原生尚无拖拽记忆）时，继承「应用内桌宠」上次拖拽到的位置，
        // 把开屏过渡落到用户习惯的位置，而不是固定角落。以「屏幕比例」传入，与分辨率无关。
        const seed = readInAppWhaleCenterFraction();
        const args: Record<string, unknown> = {
            settings: JSON.stringify(settings),
            splash: !!opts?.splash,
        };
        if (seed) {
            args.initFracX = seed.x;
            args.initFracY = seed.y;
        }
        const r: WhaleResult = await p.startFloatingWhale(args);
        return {
            running: !!r?.running,
            granted: r?.granted !== false,
            notify: r?.notify !== false,
        };
    } catch {
        return { running: false, granted: false, notify: false };
    }
}

/**
 * 读取「应用内桌宠」上次拖拽到的位置，换算为「屏幕中心比例」。
 * in-app 鲸鱼的 x 是相对视口居中的偏移（由 takeOver 反推：centerX = W/2 + x），
 * y 是鲸鱼顶部像素；这里取鲸鱼中心、再除以视口宽高，得到 0~1 的比例。
 * 浮层原生侧据此把窗口摆到同一处。读不到则返回 null（让原生走角落兜底）。
 */
function readInAppWhaleCenterFraction(): { x: number; y: number } | null {
    try {
        const raw = localStorage.getItem('whale-pet-settings');
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (typeof s.x !== 'number' || typeof s.y !== 'number') return null;
        const W = window.innerWidth || 1;
        const H = window.innerHeight || 1;
        const size = typeof s.size === 'number' ? s.size : 240;
        const h = size * 0.5625;                 // 鲸鱼高 ≈ 宽 * 9/16
        const centerX = W / 2 + s.x;             // 由 takeOver 反推
        const centerY = s.y + h / 2;             // y 为顶部像素
        const fx = centerX / W;
        const fy = centerY / H;
        if (!isFinite(fx) || !isFinite(fy)) return null;
        return { x: fx, y: fy };
    } catch {
        return null;
    }
}

/** 关闭桌宠浮层。 */
export async function stopWhalePet(): Promise<void> {
    const p = foliaNative();
    if (!p) return;
    try {
        await p.stopFloatingWhale();
    } catch {
        /* ignore */
    }
}

/** 桌宠浮层当前是否正在运行。 */
export async function isWhalePetRunning(): Promise<boolean> {
    const p = foliaNative();
    if (!p) return false;
    try {
        const r: WhaleResult = await p.isFloatingWhaleRunning();
        return !!r?.running;
    } catch {
        return false;
    }
}

/**
 * 把对桌宠实例的方法调用桥接到浮层 WebView（主 WebView 的 getWhalePet 代理会用到）。
 * 例如 invokeWhale('applySettings', [{ size: 240 }]) 会让浮层鲸鱼实时改大小。
 */
export async function invokeWhale(method: string, args: unknown[] = []): Promise<void> {
    const p = foliaNative();
    if (!p) return;
    try {
        await p.invokeWhale({ method, args: JSON.stringify(args) });
    } catch {
        /* 浮层未运行时静默忽略 */
    }
}

/** 浮层窗口的落点矩形，主 WebView 的 CSS px 口径（含屏幕 CSS 尺寸用于比例校正）。 */
export interface WhaleRestRect {
    x: number; y: number; w: number; h: number;
    sw: number; sh: number;
}

/**
 * 查询浮层窗口的落点矩形（主 WebView CSS px 口径）。**保留兼容，新的开屏链路已不再调用**：
 * 过渡的起点与终点都在原生侧用同一套坐标算好，主 WebView 无需知道落点，也就没有换算误差。
 *
 * 浮层服务是 startForegroundService 异步拉起的，窗口可能晚几十到几百毫秒才建好，
 * 这里重试到就绪为止（~1.6s），拿到的是原生 clamp 后的真实落点（含用户拖拽记忆）。
 */
export async function getWhaleRestRect(timeoutMs = 1600): Promise<WhaleRestRect | null> {
    const p = foliaNative();
    if (!p) return null;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await p.getWhaleRestRect();
            if (r?.ready && r.w > 0 && r.h > 0) {
                return { x: r.x, y: r.y, w: r.w, h: r.h, sw: r.sw, sh: r.sh };
            }
        } catch { /* 服务未就绪，继续重试 */ }
        await new Promise((res) => setTimeout(res, 80));
    }
    return null;
}

/**
 * 开屏播放结束：让浮层窗口（**屏幕上唯一的鲸鱼**）从「屏幕中央放大态」连续变换到常驻落点。
 *
 * 现在没有第二个渲染源：主 WebView 只铺黑幕、不渲染开屏 video；开屏动画就是浮层窗口在
 * 放大态播放的那一段。过渡 = 同一个窗口的 x/y/width/height 插值，视频全程不中断。
 * 因此不存在「接管」「交叉淡化」「坐标换算」，动画终点精确等于用户上次拖到的位置，
 * 旧方案里「过渡结束后鲸鱼又向下移动一段距离」的问题从根上消失。
 *
 * 返回 Promise 让主 WebView 等「动画已确认启动」再渐隐黑幕，保证界面浮现与鲸鱼飞行同步。
 */
export async function animateWhaleToRest(duration = 680): Promise<void> {
    const p = foliaNative();
    if (!p) return;
    // 服务可能尚未建窗，重试到成功或超时（~2s）。
    for (let i = 0; i < 20; i++) {
        try {
            const r = await p.animateWhaleToRest({ duration });
            if (r?.ok && r?.running) return;
        } catch { /* 服务未就绪 */ }
        await new Promise((res) => setTimeout(res, 100));
    }
    // 重试耗尽兜底：立即落位，绝不让窗口停在「放大态 + NOT_TOUCHABLE」。
    await revealWhalePet();
}

/**
 * 跳过开屏 / 用户关闭开屏 / 异常兜底：让浮层窗口**立即**落到常驻位并恢复可触摸。
 * 正常启动不再走这里（走 animateWhaleToRest），仅用于不能播放过渡的场景，
 * 避免窗口停在放大态或 NOT_TOUCHABLE 状态。
 */
export async function revealWhalePet(): Promise<void> {
    const p = foliaNative();
    if (!p) return;
    for (let i = 0; i < 20; i++) {
        try {
            const r = await p.revealFloatingWhale();
            if (r?.ok && r?.running) return;
        } catch { /* 服务未就绪 */ }
        await new Promise((res) => setTimeout(res, 100));
    }
}
