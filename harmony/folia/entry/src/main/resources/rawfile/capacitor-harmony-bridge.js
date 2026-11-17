/* eslint-disable */
// harmony/folia/entry/src/main/resources/rawfile/capacitor-harmony-bridge.js
//
// Capacitor 的「自定义平台」桥。要在 ArkWeb 加载 index.html **之前**注入（见 EntryAbility.ets）。
//
// 为什么这样做：Capacitor core 的 registerPlugin() 读 `window.CapacitorCustomPlatform.name`
// 决定当前平台，再按 `window.Capacitor.PluginHeaders[].methods[].rtype` 决定走 nativePromise
// 还是 nativeCallback。把这两样和 nativePromise/nativeCallback  ourselves 提供好，前端那
// 30+ 个 registerPlugin 调用一行都不用改，FoliaNative / FoliaPlayback / FoliaYtm 等所有
// 插件的方法都会变成对 ArkTS 侧 FoliaHarmonyBridge 的一次调用。
//
// 与 Android 的 androidBridge 协议保持一致：JSON 信封 {callbackId, pluginName, methodName, options}，
// 回执 {callbackId, ok, value?, error?}。ArkTS 侧用 WebViewController.runJavaScript 回调
// `window.__foliaHarmonyResolve(<json>)`。

(function () {
    if (window.__foliaHarmonyBridgeInstalled) return;
    window.__foliaHarmonyBridgeInstalled = true;

    window.CapacitorCustomPlatform = { name: 'harmony', plugins: {} };

    // 插件方法表：此处只声明 method 名与返回类型（promise/callback）。原生侧没有实现的方法，
    // ArkTS 会回一个结构化的 `unimplemented` 错误；前端的 registerPlugin 代理捕获后按
    // 「插件不可用」降级（各插件调用方本来就写了 catch，见 nativeHttpFetch.ts 的约定）。
var METHOD_TABLE = {
        FoliaAppleMusic: ['addListener','dispose','logout','prepare','removeListener','request','setForeground'],
        FoliaColorOsLyrics: ['addListener','clear','isSupported','publish','removeListener'],
        FoliaLyricon: ['addListener','clear','getStatus','publish','removeListener','setEnabled','setPosition'],
        FoliaNative: ['addListener','clearVideoLayerFile','cookiesRemove','cookiesSet','downloadUpdate','exitApp','getVideoLayerFile','httpRequest','installUpdate','moveToBackground','pickVideoLayerFile','removeListener','setAudioFocusPolicy','setDisplayBoost','setImmersive','setScreenAwake','setSystemBarsPolicy','showOverlayNotice','showToast'],
        FoliaNativePlayer: ['addListener','getAudioOutputCapabilities','getDolbyDeviceCapabilities','getEqualizerState','getSnapshot','getSpectrum','pause','play','prepare','release','removeListener','seek','setEqualizer','setRepeatMode','setSpectrumEnabled','setSpeed','setVolume','stop'],
        FoliaPlayback: ['addListener','consumeLikeOverrides','getPlaybackSnapshot','playFromQueue','removeListener','requestSkip','setQueueMirror','setQueueMirrorIndex','setState','stop','update'],
        FoliaQishui: ['addListener','dispose','removeListener','request','status'],
        FoliaSpotify: ['addListener','refresh','removeListener','signIn','status'],
        FoliaWallpaper: ['addListener','clear','clearImage','clearVideo','getBackground','getFont','getLockScreenStatus','getOverlayEventLog','getVideo','hasOverlayPermission','heartbeat','isActive','openOverlaySettings','openPicker','openRomPermission','pickFont','pickVideo','publish','publishCappellaImages','removeListener','resetFloatingLyrics','setAppearance','setFloatingPreview','setFollowFont','setFont'],
        FoliaYtm: ['addListener','clearSession','removeListener','restoreSession','saveSession']
    };
    var headers = [];
    Object.keys(METHOD_TABLE).forEach(function (name) {
        headers.push({
            name: name,
            methods: METHOD_TABLE[name].map(function (m) {
                // ⚠️ addListener/removeListener 必须是 'callback'：
                // Capacitor core 的 createPluginMethod 只在 rtype !== 'promise' 时才把
                // listener 透传给 nativeCallback（rtype='promise' 会把它丢掉）。
                // 声明成 'promise' 的话前端订阅收不到任何原生事件。
                var isListener = m === 'addListener' || m === 'removeListener';
                return { name: m, rtype: isListener ? 'callback' : 'promise' };
            })
        });
    });

    var cap = window.Capacitor || (window.Capacitor = {});
    cap.PluginHeaders = headers;
    cap.isNativePlatform = function () { return true; };
    cap.getPlatform = function () { return 'harmony'; };
    cap.convertFileSrc = function (url) { return url; };

    var seq = 0;
    var waiters = Object.create(null);
    window.__foliaHarmonyResolve = function (json) {
        var reply;
        try { reply = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return; }
        var pending = waiters[reply.callbackId];
        if (!pending) return;
        delete waiters[reply.callbackId];
        if (reply.ok) pending.resolve(reply.value);
        else {
            var err = new Error((reply.error && reply.error.message) || 'Harmony bridge error');
            err.code = (reply.error && reply.error.code) || 'unavailable';
            err.data = reply.error && reply.error.data;
            pending.reject(err);
        }
    };

    function invoke(pluginName, methodName, options) {
        return new Promise(function (resolve, reject) {
            var callbackId = 'hcb_' + (++seq);
            waiters[callbackId] = { resolve: resolve, reject: reject };
            var payload = JSON.stringify({
                callbackId: callbackId,
                pluginName: pluginName,
                methodName: methodName,
                options: options || {}
            });
            // ArkTS 侧用 registerJavaScriptProxy 注入这个方法；原生未就绪时明确拒绝，
            // 不把调用挂成永远不 settle 的 Promise（前端有几处 await 会一直等）。
            if (typeof window.foliaHarmonyInvoke !== 'function') {
                delete waiters[callbackId];
                var err = new Error('Harmony native bridge is not ready');
                err.code = 'unavailable';
                reject(err);
                return;
            }
            try {
                window.foliaHarmonyInvoke(payload);
            } catch (e) {
                delete waiters[callbackId];
                reject(e);
            }
        });
    }

    // ── 事件通道 ──
    // 原生事件没法直接带函数回来（要过 JSON），所以：JS 侧替 listener 编号，
    // 把编号（callbackId）交给原生；原生推事件时回调 window.__foliaHarmonyEmit，
    // 由这里查表转交给真正的 listener。
    var listenerSeq = 0;
    var listeners = Object.create(null);

    window.__foliaHarmonyEmit = function (callbackId, json) {
        var entry = listeners[callbackId];
        if (!entry) return;
        var payload = json;
        try {
            payload = typeof json === 'string' ? JSON.parse(json) : json;
        } catch (e) { return; }
        try {
            entry.callback(payload);
        } catch (e) {
            console.warn('[Harmony] listener threw', e);
        }
    };

    cap.nativePromise = function (pluginName, methodName, options) {
        return invoke(pluginName, methodName, options);
    };

    cap.nativeCallback = function (pluginName, methodName, options, callback) {
        // Capacitor core 的 addListenerNative 会 `await call` 拿 callbackId，
        // 再用它调 removeListener 退订 —— 所以这里必须 resolve 出 { callbackId }。
        if (methodName === 'addListener') {
            var opts = options || {};
            var eventName = opts.eventName;
            var listenerId = 'hl_' + (++listenerSeq);
            listeners[listenerId] = {
                pluginName: pluginName,
                eventName: eventName,
                callback: callback
            };
            return invoke(pluginName, methodName, { eventName: eventName, callbackId: listenerId })
                .then(function () {
                    return { callbackId: listenerId };
                })
                .catch(function (err) {
                    delete listeners[listenerId];
                    throw err;
                });
        }
        if (methodName === 'removeListener') {
            var ropts = options || {};
            if (ropts.callbackId) {
                delete listeners[ropts.callbackId];
            }
            return invoke(pluginName, methodName, {
                eventName: ropts.eventName,
                callbackId: ropts.callbackId
            });
        }
        // 其它 callback 型方法：按普通调用处理，回调风格返回。
        return invoke(pluginName, methodName, options).then(
            function (value) { callback(null, value); },
            function (error) { callback(error, null); }
        );
    };

    // WebView 里没有 Android 的 androidBridge / iOS 的 webkit.messageHandlers，
    // Capacitor core 自己会通过 CapacitorCustomPlatform 认出我们，这里无需再伪造它们。
})();
