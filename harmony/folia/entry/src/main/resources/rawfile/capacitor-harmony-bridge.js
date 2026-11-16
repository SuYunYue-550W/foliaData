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
        FoliaNative: ['exitApp','moveToBackground','setImmersive','setSystemBarsPolicy','setScreenAwake','setDisplayBoost','setAudioFocusPolicy','downloadUpdate','installUpdate','httpRequest','cookiesSet','cookiesRemove','showToast','showOverlayNotice','pickVideoLayerFile','getVideoLayerFile','clearVideoLayerFile','addListener','removeListener'],
        FoliaPlayback: ['update','setState','stop','setQueueMirror','setQueueMirrorIndex','setPlaying','setLiked','addListener','removeListener'],
        FoliaNativePlayer: ['prepare','play','pause','stop','seek','setVolume','setSpeed','setRepeatMode','setEqualizer','getEqualizerState','setSpectrumEnabled','getSpectrum','getSnapshot','getDolbyDeviceCapabilities','getAudioOutputCapabilities','release','addListener','removeListener'],
        FoliaYtm: ['signIn','restoreSession','saveSession','clearSession'],
        FoliaAppleMusic: ['prepare','request','setForeground','logout','dispose'],
        FoliaSpotify: ['signIn','refresh','status'],
        FoliaQishui: ['signIn','refresh','status','request'],
        FoliaLyricon: ['setEnabled','getStatus','publish','setPosition','clear'],
        FoliaColorOsLyrics: ['isSupported','publish','clear'],
        FoliaWallpaper: ['publish','setAppearance','publishCappellaImages','clearImage','pickFont','getFont','setFont','setFollowFont','setFloatingPreview','getBackground','resetFloatingLyrics','clear','heartbeat','isActive','openPicker','hasOverlayPermission','openOverlaySettings','pickVideo','getVideo','clearVideo','getLockScreenStatus','openRomPermission','getOverlayEventLog']
    };
    var headers = [];
    Object.keys(METHOD_TABLE).forEach(function (name) {
        headers.push({
            name: name,
            methods: METHOD_TABLE[name].map(function (m) { return { name: m, rtype: 'promise' }; })
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

    cap.nativePromise = function (pluginName, methodName, options) {
        return invoke(pluginName, methodName, options);
    };
    cap.nativeCallback = function (pluginName, methodName, options, callback) {
        invoke(pluginName, methodName, options).then(
            function (value) { callback(null, value); },
            function (error) { callback(error, null); }
        );
    };

    // WebView 里没有 Android 的 androidBridge / iOS 的 webkit.messageHandlers，
    // Capacitor core 自己会通过 CapacitorCustomPlatform 认出我们，这里无需再伪造它们。
})();
