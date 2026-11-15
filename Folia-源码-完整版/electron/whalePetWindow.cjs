// Folia 桌面端「系统级置顶桌宠」窗口。
//
// 与 Android 的 FloatingWhaleService 对等：桌宠渲染在一个独立的 BrowserWindow 里，
// 该窗口 alwaysOnTop('screen-saver') + transparent + skipTaskbar，因此能浮在其他应用之上。
//
// 与 Android 的实现**完全独立**：桌面端不复用 floating.ts / init.ts / splash.ts 的浮层代理链路。
// 主 WebView 保留原有真实桌宠实例（只由 desktop.ts 注入 visibility:hidden 隐身），
// 本文件在主进程自包含管理：建窗、开屏、3 秒后的窗口几何过渡、拖拽、漫游、位置持久化。
// 不依赖渲染进程心跳，主窗口最小化到托盘或重建都不会让鲸鱼卡在放大态。
//
// 开屏 → 落位过渡是同一个窗口 x/y/width/height 的连续插值，全程只有一个渲染源。
//
// 位置持久化在 userData/whale-pet-window.json；Web 侧设置通过 invokeWhale 实时转发。

const { BrowserWindow, screen, ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULT_SIZE = 240;
const ASPECT = 0.5625;          // 鲸鱼宽高比，与 pet.js 一致
const NOTIF_FALLBACK = { ok: true, running: true, granted: true, notify: true, opened: true };

function createWhalePetHost() {
    let win = null;
    let settings = {};
    let splashMode = false;
    let animating = false;
    let dragging = false;
    let dragStartBounds = null;
    let ready = false;
    let pendingInvoke = [];
    let roamTimer = null;
    let lastFlip = false;
    let persisted = null;
    let registered = false;
    let splashTimer = null;
    let restTimer = null;       // 几何过渡 interval：模块级，stop/reveal/start 都必须清理
    let reuseTimer = null;      // 复用窗口后主动 flush 的兜底定时器
    let displayListenerBound = false;

    const statePath = () => path.join(app.getPath('userData'), 'whale-pet-window.json');
    function loadPersisted() {
        try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')) || {}; } catch { return {}; }
    }
    function savePersisted(bounds) {
        try { fs.writeFileSync(statePath(), JSON.stringify({ x: bounds.x, y: bounds.y })); } catch { /* 忽略 */ }
    }
    function workArea() {
        try {
            // 用窗口所在显示器的工作区，而不是恒取主屏：副屏漫游不会被拉回主屏。
            if (win && !win.isDestroyed()) {
                const d = screen.getDisplayMatching(win.getBounds());
                if (d && d.workArea && d.workArea.width > 0) return d.workArea;
            }
            return screen.getPrimaryDisplay().workArea;
        } catch { return { x: 0, y: 0, width: 1920, height: 1080 }; }
    }
    function clampBounds(b) {
        const a = workArea();
        const bw = Number(b.width), bh = Number(b.height);
        const w = Math.max(40, Math.min(Number.isFinite(bw) && bw > 0 ? bw : DEFAULT_SIZE, a.width));
        const h = Math.max(24, Math.min(Number.isFinite(bh) && bh > 0 ? bh : w * ASPECT, a.height));
        const bx = Number(b.x), by = Number(b.y);
        // Number(x) || a.x 会把合法坐标 0 当成缺失；用 Number.isFinite 判定。
        const x = Math.round(Math.max(a.x, Math.min(a.x + a.width - w, Number.isFinite(bx) ? bx : a.x)));
        const y = Math.round(Math.max(a.y, Math.min(a.y + a.height - h, Number.isFinite(by) ? by : a.y)));
        return { x, y, width: Math.round(w), height: Math.round(h) };
    }
    function restBounds() {
        const size = Number(settings.size) || DEFAULT_SIZE;
        const w = Math.round(size), h = Math.round(size * ASPECT);
        const a = workArea();
        let x, y;
        if (persisted && typeof persisted.x === 'number' && typeof persisted.y === 'number') {
            x = persisted.x; y = persisted.y;
        } else if (typeof settings.initFracX === 'number' && typeof settings.initFracY === 'number') {
            // 首启继承「应用内桌宠」上次拖拽的位置（Web 层换算成屏幕比例传入）
            x = a.x + a.width * settings.initFracX - w / 2;
            y = a.y + a.height * settings.initFracY - h / 2;
        } else {
            x = a.x + a.width - w - 24; y = a.y + 24;
        }
        return clampBounds({ x, y, width: w, height: h });
    }
    function splashBounds() {
        const a = workArea();
        const short = Math.min(a.width, a.height);
        const w = Math.round(short * 0.74), h = Math.round(w * ASPECT);
        return {
            x: Math.round(a.x + (a.width - w) / 2),
            y: Math.round(a.y + (a.height - h) / 2),
            width: w, height: h,
        };
    }
    function settingsForPet() {
        const out = Object.assign({}, settings);
        delete out.initFracX; delete out.initFracY; delete out.reduceMotion;
        return out;
    }

    function forward(method, args) {
        const payload = { method, args: Array.isArray(args) ? args : [] };
        if (win && !win.isDestroyed() && ready) {
            try { win.webContents.send('whale-pet:invoke', payload); return; } catch { /* 落到缓存 */ }
        }
        if (pendingInvoke.length < 40) pendingInvoke.push(payload);
    }
    function flushPending() {
        if (!win || win.isDestroyed() || !ready) return;
        const list = pendingInvoke; pendingInvoke = [];
        for (const p of list) {
            try { win.webContents.send('whale-pet:invoke', p); } catch { /* 忽略 */ }
        }
    }

    function clearAnim() {
        if (restTimer) { clearInterval(restTimer); restTimer = null; }
        animating = false;
    }
    function stopRoam() {
        if (roamTimer) { clearInterval(roamTimer); roamTimer = null; }
        if (lastFlip) { lastFlip = false; forward('setFlip', [false]); }
    }
    function startRoam() {
        stopRoam();
        if (!settings.roam || !win || win.isDestroyed() || animating) return;
        const speed = Math.max(10, Math.min(400, Number(settings.roamSpeed) || 60));  // px/s
        let vx = speed / 60, vy = vx * 0.45;   // 按 ~60fps 折算每帧位移
        let last = Date.now();
        roamTimer = setInterval(() => {
            if (!win || win.isDestroyed() || dragging || animating) { last = Date.now(); return; }
            const now = Date.now(), dt = Math.min(50, now - last); last = now;
            const b = win.getBounds(), a = workArea(), step = dt / 16.67;
            let nx = b.x + vx * step, ny = b.y + vy * step;
            if (nx <= a.x || nx + b.width >= a.x + a.width) {
                vx = -vx; nx = Math.max(a.x, Math.min(a.x + a.width - b.width, nx));
            }
            if (ny <= a.y || ny + b.height >= a.y + a.height) {
                vy = -vy; ny = Math.max(a.y, Math.min(a.y + a.height - b.height, ny));
            }
            const x = Math.round(nx), y = Math.round(ny);
            if (x !== b.x || y !== b.y) {
                try { win.setBounds({ x, y, width: b.width, height: b.height }); } catch { /* 忽略 */ }
            }
            const flip = vx < 0;
            if (flip !== lastFlip) { lastFlip = flip; forward('setFlip', [flip]); }
        }, 16);
    }

    function bindDisplayChanges() {
        if (displayListenerBound) return;
        displayListenerBound = true;
        try {
            // 分辨率变化 / 拔掉外接显示器：把窗口夹回当前可用的工作区，避免「看不见的鲸鱼」。
            screen.on('display-metrics-changed', () => {
                if (!win || win.isDestroyed()) return;
                try { applyBounds(win.getBounds()); } catch { /* 忽略 */ }
            });
        } catch { /* 忽略 */ }
    }

    function createWindow(initial) {
        const preload = path.join(__dirname, 'whalePetPreload.cjs');
        const html = path.join(__dirname, '../dist/whale-pet-float.html');
        win = new BrowserWindow({
            ...initial,
            frame: false,
            transparent: true,
            hasShadow: false,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            alwaysOnTop: true,
            show: false,
            backgroundColor: '#00000000',
            webPreferences: {
                preload,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false,
                backgroundThrottling: false,
                webSecurity: true,
            },
        });
        // screen-saver 层级：浮在普通窗口与大多数全屏窗口之上，但仍受系统 UI 约束
        try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* 忽略 */ }
        win.setMenuBarVisibility(false);
        ready = false;
        pendingInvoke = [];
        bindDisplayChanges();

        const inject = () => {
            if (!win || win.isDestroyed()) return;
            const js = 'window.__WHALE_SETTINGS = ' + JSON.stringify(settingsForPet()) + ';';
            try { win.webContents.executeJavaScript(js).catch(() => {}); } catch { /* 忽略 */ }
        };
        win.webContents.on('dom-ready', inject);
        win.webContents.on('did-finish-load', inject);
        win.on('closed', () => {
            win = null; ready = false; pendingInvoke = []; stopRoam();
        });
        try {
            win.loadFile(html).catch((e) => console.error('[whalePet] 无法加载桌宠页面', e));
        } catch (e) {
            console.error('[whalePet] 无法加载桌宠页面', e);
        }
        try { win.showInactive(); } catch { try { win.show(); } catch { /* 忽略 */ } }
    }

    function start(args) {
        const incoming = args || {};
        try { settings = JSON.parse(incoming.settings || '{}') || {}; } catch { settings = {}; }
        if (typeof incoming.initFracX === 'number') settings.initFracX = incoming.initFracX;
        if (typeof incoming.initFracY === 'number') settings.initFracY = incoming.initFracY;
        persisted = loadPersisted();

        // 系统「减弱动态效果」：跳过放大态开屏，直接以落点尺寸/位置建窗。
        const reduceMotion = !!incoming.reduceMotion || !!settings.reduceMotion;
        const wantsSplash = !!incoming.splash && !reduceMotion;

        if (splashTimer) { clearTimeout(splashTimer); splashTimer = null; }
        if (reuseTimer) { clearTimeout(reuseTimer); reuseTimer = null; }
        clearAnim();
        stopRoam();
        splashMode = wantsSplash;
        dragging = false;

        // 已常驻的窗口不重播开屏。主窗口重建（透明/壁纸模式切换）会重跑渲染层启动逻辑，
        // 这里只同步一次设置、保持当前位置与动画，避免鲸鱼弹回屏幕中央放大态。
        if (win && !win.isDestroyed()) {
            if (ready) {
                try { win.setIgnoreMouseEvents(false); } catch { /* 忽略 */ }
                forward('applySettings', [settingsForPet()]);
                return Object.assign({}, NOTIF_FALLBACK, { running: true });
            }
            // 窗口存在但尚未 ready（启动竞态）：等它 ready，不重复建窗、不重设几何。
            reuseTimer = setTimeout(() => {
                reuseTimer = null;
                if (win && !win.isDestroyed()) { ready = true; flushPending(); }
            }, 120);
            return Object.assign({}, NOTIF_FALLBACK, { running: true });
        }

        const initial = splashMode ? splashBounds() : restBounds();
        createWindow(initial);
        try { win.setIgnoreMouseEvents(splashMode); } catch { /* 忽略 */ }

        // 开屏 → 落位全过程由**主进程自己**驱动，不依赖渲染进程的定时器 / 心跳 /
        // 前后台状态。这也是桌面端与 Android 最大的实现差异：Android 由 Web 层
        // splash.ts 触发 animateWhaleToRest，桌面端完全不经过 Web 层。
        if (splashMode) {
            splashTimer = setTimeout(() => {
                splashTimer = null;
                if (!splashMode || !win || win.isDestroyed()) return;
                try { animateToRest(700); }
                catch { try { reveal(); } catch { /* ignore */ } }
            }, 3000);
        } else {
            try { win.setIgnoreMouseEvents(false); } catch { /* 忽略 */ }
        }
        return Object.assign({}, NOTIF_FALLBACK, { running: true });
    }

    function stop() {
        // 先记下退出时是否处于放大态/过渡中：那一刻的 bounds 不是用户落点，不能持久化。
        const transient = splashMode || animating;
        stopRoam();
        if (splashTimer) { clearTimeout(splashTimer); splashTimer = null; }
        if (reuseTimer) { clearTimeout(reuseTimer); reuseTimer = null; }
        clearAnim();
        dragging = false;
        splashMode = false;
        if (win && !win.isDestroyed()) {
            if (!transient) {
                try { savePersisted(win.getBounds()); } catch { /* 忽略 */ }
            }
            try { win.destroy(); } catch { /* 忽略 */ }
        }
        win = null; ready = false; pendingInvoke = [];
        return { running: false };
    }

    function isRunning() { return Boolean(win && !win.isDestroyed()); }

    function applyBounds(b) {
        if (!win || win.isDestroyed()) return;
        const next = clampBounds(b);
        const cur = win.getBounds();
        if (next.x === cur.x && next.y === cur.y && next.width === cur.width && next.height === cur.height) return;
        try { win.setBounds(next); } catch { /* 忽略 */ }
    }

    function animateToRest(duration) {
        if (splashTimer) { clearTimeout(splashTimer); splashTimer = null; }
        clearAnim();
        if (!win || win.isDestroyed()) return { ok: false, running: false };
        const from = win.getBounds();
        const to = restBounds();
        const d = Math.max(120, Math.min(2000, Number(duration) || 680));
        const t0 = Date.now();
        animating = true;
        stopRoam();
        const ease = (t) => 1 - Math.pow(1 - t, 3);   // easeOutCubic，接近 Android 的 PathInterpolator
        restTimer = setInterval(() => {
            if (!win || win.isDestroyed()) { clearAnim(); return; }
            const t = Math.min(1, (Date.now() - t0) / d), q = ease(t);
            applyBounds({
                x: from.x + (to.x - from.x) * q,
                y: from.y + (to.y - from.y) * q,
                width: Math.max(1, from.width + (to.width - from.width) * q),
                height: Math.max(1, from.height + (to.height - from.height) * q),
            });
            if (t >= 1) {
                clearAnim();
                splashMode = false;
                applyBounds(to);
                try { win.setIgnoreMouseEvents(false); } catch { /* 忽略 */ }
                savePersisted(to);
                startRoam();
            }
        }, 16);
        return { ok: true, running: true };
    }

    function reveal() {
        if (splashTimer) { clearTimeout(splashTimer); splashTimer = null; }
        clearAnim();
        if (!win || win.isDestroyed()) return { ok: false, running: false };
        splashMode = false;
        const to = restBounds();
        applyBounds(to);
        try { win.setIgnoreMouseEvents(false); } catch { /* 忽略 */ }
        savePersisted(to);
        startRoam();
        return { ok: true, running: true };
    }

    function resetPos() {
        const a = workArea(), b = win && !win.isDestroyed() ? win.getBounds() : restBounds();
        const next = clampBounds({ x: a.x + (a.width - b.width) / 2, y: a.y + 24, width: b.width, height: b.height });
        applyBounds(next);
        savePersisted(next);
        forward('resetPos', []);
    }

    function invoke(method, args) {
        if (method === 'applySettings') {
            const patch = (args && args[0]) || {};
            Object.assign(settings, patch);
            if (patch.size !== undefined && !animating) {
                const b = win && !win.isDestroyed() ? win.getBounds() : restBounds();
                const w = Math.round(Number(patch.size) || DEFAULT_SIZE);
                applyBounds({ x: b.x, y: b.y, width: w, height: Math.round(w * ASPECT) });
                if (win && !win.isDestroyed()) savePersisted(win.getBounds());
            }
            if (patch.roam !== undefined || patch.roamSpeed !== undefined) startRoam();
            forward('applySettings', [patch]);
            return { ok: true };
        }
        if (method === 'resetPos') { resetPos(); return { ok: true }; }
        if (method === 'setFlip') { forward('setFlip', args); return { ok: true }; }
        forward(method, args);
        return { ok: true };
    }

    function restRect() {
        const b = win && !win.isDestroyed() ? win.getBounds() : restBounds();
        const a = workArea();
        return { ready: isRunning(), x: b.x, y: b.y, w: b.width, h: b.height, sw: a.width, sh: a.height };
    }

    function registerIpc() {
        if (registered) return;
        registered = true;
        // ipcMain.on 的 listener 签名是 (event, ...args)；必须剥掉 event，
        // 否则 'whale-pet:drag' 的 handler 收到的是 IpcMainEvent，dx/dy 恒为 undefined。
        // 同时校验 sender 必须是桌宠窗口自己，避免其它渲染进程伪造拖拽消息。
        const trusted = (e) => {
            try { return Boolean(win && !win.isDestroyed() && e && e.sender === win.webContents); }
            catch { return false; }
        };
        const on = (channel, handler) => ipcMain.on(channel, (e, a) => {
            if (trusted(e)) handler(a || {});
        });
        const handle = (channel, handler) => ipcMain.handle(channel, (_e, a) => handler(a || {}));

        handle('whale-pet:can-draw-overlay', () => ({ granted: true }));           // 桌面端无需系统授权
        handle('whale-pet:open-overlay-settings', () => ({ opened: true }));
        handle('whale-pet:open-notification-settings', () => ({ opened: true }));
        handle('whale-pet:start', (a) => start(a));
        handle('whale-pet:stop', () => stop());
        handle('whale-pet:running', () => ({ running: isRunning() }));
        handle('whale-pet:invoke', (a) => {
            try { return invoke(a.method, JSON.parse(a.args || '[]')); } catch { return { ok: false }; }
        });
        handle('whale-pet:rest-rect', () => restRect());
        handle('whale-pet:animate-to-rest', (a) => animateToRest(a.duration));
        handle('whale-pet:reveal', () => reveal());

        on('whale-pet:ready', () => { ready = true; flushPending(); if (!splashMode && !animating) startRoam(); });
        on('whale-pet:drag-start', () => {
            dragging = true;
            dragStartBounds = win && !win.isDestroyed() ? win.getBounds() : null;
            stopRoam();
        });
        on('whale-pet:drag', (d) => {
            if (!dragging || !dragStartBounds || animating) return;
            const dx = Number(d && d.dx), dy = Number(d && d.dy);
            applyBounds({
                x: dragStartBounds.x + (Number.isFinite(dx) ? dx : 0),
                y: dragStartBounds.y + (Number.isFinite(dy) ? dy : 0),
                width: dragStartBounds.width, height: dragStartBounds.height,
            });
        });
        on('whale-pet:drag-end', () => {
            dragging = false;
            if (win && !win.isDestroyed()) savePersisted(win.getBounds());
            startRoam();
        });
        on('whale-pet:drag-anim', () => { forward('dragAnim', []); });
    }

    return { registerIpc, stop, isRunning };
}

let singleton = null;
function getWhalePetHost() {
    if (!singleton) singleton = createWhalePetHost();
    return singleton;
}
function registerWhalePetIpc() { getWhalePetHost().registerIpc(); }

module.exports = { createWhalePetHost, getWhalePetHost, registerWhalePetIpc };
