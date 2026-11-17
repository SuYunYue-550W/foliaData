// test/unit/harmony/harmonyBridgeContract.test.ts
// HarmonyOS 壳工程的桥契约护栏。
// 本机没有 DevEco SDK 时无法编译 HAP，因此用静态断言钉住「前端 JS 桥」与「ArkTS 原生桥」
// 之间不会漂移的契约：方法名与前端接口同源、事件通道完整、播放能力已接线、
// 返回字段与前端期望的形状一致、以及 ArkTS 严格模式的硬性写法。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 测试在 Folia-源码-完整版 下运行，harmony 工程在上一级工作区。
const workspaceRoot = resolve(__dirname, '../../../..');
const harmonyRoot = resolve(workspaceRoot, 'harmony/folia');
const srcRoot = resolve(workspaceRoot, 'Folia-源码-完整版');
const read = (rel: string): string => readFileSync(resolve(harmonyRoot, rel), 'utf8');
const readSrc = (rel: string): string => readFileSync(resolve(srcRoot, rel), 'utf8');

const jsBridge = (): string => read('entry/src/main/resources/rawfile/capacitor-harmony-bridge.js');
const etsBridge = (): string => read('entry/src/main/ets/bridge/FoliaHarmonyBridge.ets');

describe('HarmonyOS 前端桥（capacitor-harmony-bridge.js）', () => {
    it('声明 Capacitor 自定义平台为 harmony 并接管平台判定', () => {
        const js = jsBridge();
        expect(js).toContain("window.CapacitorCustomPlatform = { name: 'harmony'");
        expect(js).toContain("cap.getPlatform = function () { return 'harmony'; }");
        expect(js).toContain('cap.nativePromise');
        expect(js).toContain('cap.nativeCallback');
    });

    it('注入 ArkTS 期望的 foliaHarmonyInvoke 与回执函数', () => {
        const js = jsBridge();
        expect(js).toContain('window.foliaHarmonyInvoke(payload)');
        expect(js).toContain('window.__foliaHarmonyResolve = function');
    });

    it('JSON 信封字段与 ArkTS BridgeRequest 对齐', () => {
        const js = jsBridge();
        ['callbackId', 'pluginName', 'methodName', 'options'].forEach((field) => {
            expect(js, `前端信封缺 ${field}`).toContain(field);
        });
    });

    it('原生未就绪时明确拒绝，不留 pending Promise', () => {
        const js = jsBridge();
        expect(js).toContain("typeof window.foliaHarmonyInvoke !== 'function'");
        expect(js).toContain("err.code = 'unavailable'");
        expect(js).toContain('reject(err)');
    });
});

describe('HarmonyOS 事件通道（原生 → JS 的单向推送）', () => {
    it('addListener/removeListener 必须声明为 callback 类型', () => {
        // Capacitor core 的 createPluginMethod 只在 rtype !== 'promise' 时才把 listener
        // 透传给 nativeCallback；声明成 promise 的话 listener 会被丢掉，前端永远收不到事件。
        const js = jsBridge();
        expect(js).toContain("var isListener = m === 'addListener' || m === 'removeListener'");
        expect(js).toContain("rtype: isListener ? 'callback' : 'promise'");
    });

    it('JS 侧替 listener 编号并提供 emit 入口', () => {
        const js = jsBridge();
        expect(js).toContain('window.__foliaHarmonyEmit = function');
        expect(js).toContain('var listenerId =');
        expect(js).toContain('listeners[listenerId]');
        expect(js).toContain('entry.callback(payload)');
    });

    it('addListener 回执带 callbackId（Capacitor 用它调 removeListener 退订）', () => {
        const js = jsBridge();
        expect(js).toContain('return { callbackId: listenerId };');
    });

    it('removeListener 会清掉 JS 侧的订阅表', () => {
        const js = jsBridge();
        expect(js).toContain("if (methodName === 'removeListener')");
        expect(js).toContain('delete listeners[ropts.callbackId];');
    });

    it('ArkTS 侧有对应的事件总线实现', () => {
        const bus = read('entry/src/main/ets/bridge/FoliaEventBus.ets');
        expect(bus).toContain('class FoliaEventBus');
        expect(bus).toContain('window.__foliaHarmonyEmit');
        expect(bus).toContain('emit(pluginName: string, eventName: string, payload: Object): void');
    });
});

describe('HarmonyOS 原生播放内核（FoliaNativePlayer）', () => {
    it('用 AVPlayer 实现播放控制', () => {
        const player = read('entry/src/main/ets/bridge/FoliaPlayer.ets');
        expect(player).toContain("import { media } from '@kit.MediaKit'");
        expect(player).toContain('media.createAVPlayer()');
        ['prepare', 'play', 'pause', 'stop', 'seek', 'setVolume', 'setSpeed', 'setRepeatMode', 'release']
            .forEach((m) => expect(player, `AVPlayer 封装缺 ${m}`).toContain(`${m}(`));
    });

    it('播放方法已注册到桥的 handler 表', () => {
        const handlers = read('entry/src/main/ets/bridge/FoliaNativePlayerHandlers.ets');
        [
            'FoliaNativePlayer.prepare',
            'FoliaNativePlayer.play',
            'FoliaNativePlayer.pause',
            'FoliaNativePlayer.stop',
            'FoliaNativePlayer.seek',
            'FoliaNativePlayer.setVolume',
            'FoliaNativePlayer.setSpeed',
            'FoliaNativePlayer.setRepeatMode',
            'FoliaNativePlayer.getSnapshot',
            'FoliaNativePlayer.release',
        ].forEach((key) => expect(handlers, `缺 ${key}`).toContain(`'${key}'`));
    });

    it('鸿蒙没有的能力如实回 unsupported，而不是返回假数据', () => {
        const handlers = read('entry/src/main/ets/bridge/FoliaNativePlayerHandlers.ets');
        ['FoliaNativePlayer.setEqualizer', 'FoliaNativePlayer.getEqualizerState',
         'FoliaNativePlayer.setSpectrumEnabled', 'FoliaNativePlayer.getSpectrum']
            .forEach((key) => expect(handlers, `缺 ${key}`).toContain(`'${key}'`));
        expect(handlers).toContain('This capability is not available on HarmonyOS');
    });

    it('能力探测返回前端期望的字段名', () => {
        // 前端 DolbyDeviceCapabilities 期望 eac3/ac4/ac3/flac/available，
        // AudioOutputCapabilities 期望 outputSampleRate/floatPcmOutput/available。
        const player = read('entry/src/main/ets/bridge/FoliaPlayer.ets');
        expect(player).toContain('class DolbyDeviceCapabilities');
        expect(player).toContain('class AudioOutputCapabilities');
        ['eac3', 'ac4', 'ac3', 'flac', 'available'].forEach((f) =>
            expect(player, `Dolby 缺 ${f}`).toContain(`${f}: boolean = false;`));
        ['outputSampleRate', 'floatPcmOutput', 'available'].forEach((f) =>
            expect(player, `AudioOutput 缺 ${f}`).toContain(`${f}:`));
    });

    it('播放事件名与前端一致（foliaNativePlayer）', () => {
        const handlers = read('entry/src/main/ets/bridge/FoliaNativePlayerHandlers.ets');
        expect(handlers).toContain("const EVENT: string = 'foliaNativePlayer'");
    });
});

describe('HarmonyOS 媒体会话（FoliaPlayback）', () => {
    it('用 AVSession 做通知栏/锁屏控制', () => {
        const playback = read('entry/src/main/ets/bridge/FoliaPlaybackHandlers.ets');
        expect(playback).toContain("import { avSession } from '@kit.AVSessionKit'");
        expect(playback).toContain('avSession.createAVSession');
        expect(playback).toContain('setAVMetadata');
        expect(playback).toContain('setAVPlaybackState');
    });

    it('订阅了通知栏与锁屏的播放命令事件', () => {
        const playback = read('entry/src/main/ets/bridge/FoliaPlaybackHandlers.ets');
        ['play', 'pause', 'stop', 'seek', 'playNext', 'playPrevious'].forEach((evt) =>
            expect(playback, `缺 on('${evt}')`).toContain(`session.on('${evt}'`));
    });

    it('FoliaPlayback 的方法名与前端接口一致', () => {
        const playback = read('entry/src/main/ets/bridge/FoliaPlaybackHandlers.ets');
        [
            'FoliaPlayback.update',
            'FoliaPlayback.setState',
            'FoliaPlayback.stop',
            'FoliaPlayback.getPlaybackSnapshot',
            'FoliaPlayback.setQueueMirror',
            'FoliaPlayback.setQueueMirrorIndex',
            'FoliaPlayback.playFromQueue',
            'FoliaPlayback.requestSkip',
            'FoliaPlayback.consumeLikeOverrides',
        ].forEach((key) => expect(playback, `缺 ${key}`).toContain(`'${key}'`));
    });

    it('没有平台地址解析能力时如实回 false，让前端回退 Web 流程', () => {
        const playback = read('entry/src/main/ets/bridge/FoliaPlaybackHandlers.ets');
        expect(playback).toContain('result.ok = false;');
        expect(playback).toContain('result.skipped = false;');
    });
});

describe('HarmonyOS ArkTS 严格模式约束', () => {
    it('不用 Object 作泛型实参（ArkTS 不允许）', () => {
        // Record<string, Object> 在函数参数标注处会直接编译失败，
        // 动态 JSON 一律用 Record<string, ESObject>。
        for (const file of ['FoliaHarmonyBridge.ets', 'FoliaNativePlayerHandlers.ets', 'FoliaPlaybackHandlers.ets']) {
            expect(read(`entry/src/main/ets/bridge/${file}`), `${file} 用了 Record<string, Object>`)
                .not.toContain('Record<string, Object>');
        }
    });

    it('动态取值走 ESObject 辅助函数', () => {
        const options = read('entry/src/main/ets/bridge/FoliaBridgeOptions.ets');
        expect(options).toContain('export function optString(o: ESObject, key: string): string');
        expect(options).toContain('export function optNumber(o: ESObject, key: string): number');
        expect(options).toContain('export function optBool(o: ESObject, key: string): boolean');
    });

    it('主桥用显式 class 而不是对象字面量', () => {
        const ets = etsBridge();
        expect(ets).toContain('class BridgeError');
        expect(ets).toContain('class BridgeReply');
        expect(ets).toContain('class JsProxy');
        expect(ets).toContain('class CodedError');
        // 回执序列化走 class 实例
        expect(ets).toContain('JSON.stringify(reply)');
    });

    it('三级降级语义仍然保留', () => {
        const ets = etsBridge();
        expect(ets).toContain("new BridgeError('unimplemented'");
        expect(ets).toContain("new CodedError('unsupported'");
    });

    it('已实现能力覆盖关键方法', () => {
        const ets = etsBridge();
        [
            'FoliaNative.showToast',
            'FoliaNative.setScreenAwake',
            'FoliaNative.exitApp',
        ].forEach((key) => expect(ets, `ArkTS 缺 ${key}`).toContain(`'${key}'`));
    });
});

describe('HarmonyOS 桥方法表与前端契约同源', () => {
    it('METHOD_TABLE 覆盖前端实际调用的 FoliaPlayback 方法', () => {
        // 这几个是前端真的在调的：之前手写桥表时漏了它们，调用会直接落空。
        const js = jsBridge();
        ['playFromQueue', 'requestSkip', 'getPlaybackSnapshot', 'consumeLikeOverrides']
            .forEach((m) => expect(js, `METHOD_TABLE 缺 ${m}`).toContain(`'${m}'`));
    });

    it('METHOD_TABLE 不含前端接口里没有的方法', () => {
        const js = jsBridge();
        ['setLiked', 'setPlaying'].forEach((m) =>
            expect(js, `METHOD_TABLE 多了 ${m}`).not.toContain(`'${m}'`));
    });

    it('提取脚本存在且能跑（方法表不靠手写维护）', () => {
        const script = resolve(srcRoot, 'dev/tools/extract-harmony-plugin-methods.mjs');
        expect(existsSync(script)).toBe(true);
        expect(readFileSync(script, 'utf8')).toContain('--check');
    });
});

describe('HarmonyOS 原生 HTTP 转发（FoliaNative.httpRequest）', () => {
    it('用 NetworkKit 的 http.createHttp 实现', () => {
        const http = read('entry/src/main/ets/bridge/FoliaHttpHandlers.ets');
        expect(http).toContain("import { http } from '@kit.NetworkKit'");
        expect(http).toContain('http.createHttp()');
        expect(http).toContain('request.request(url, options)');
    });

    it('注册了 httpRequest / cookiesSet / cookiesRemove', () => {
        const http = read('entry/src/main/ets/bridge/FoliaHttpHandlers.ets');
        ['FoliaNative.httpRequest', 'FoliaNative.cookiesSet', 'FoliaNative.cookiesRemove']
            .forEach((key) => expect(http, `缺 ${key}`).toContain(`'${key}'`));
    });

    it('响应体按契约给 base64（前端自己解）', () => {
        const http = read('entry/src/main/ets/bridge/FoliaHttpHandlers.ets');
        expect(http).toContain("import { buffer } from '@kit.ArkTS'");
        expect(http).toContain(".toString('base64')");
        expect(http).toContain('bodyBase64');
    });

    it('响应头按前端接受的数组形状给出', () => {
        const http = read('entry/src/main/ets/bridge/FoliaHttpHandlers.ets');
        expect(http).toContain('class HeaderEntry');
        expect(http).toContain('headers: HeaderEntry[] = []');
    });

    it('cookie 走 ArkWeb 的 cookie 罐（静态方法调用）', () => {
        const http = read('entry/src/main/ets/bridge/FoliaHttpHandlers.ets');
        expect(http).toContain("import { webview } from '@kit.ArkWeb'");
        expect(http).toContain('webview.WebCookieManager.setCookie(url, cookie)');
        expect(http).toContain('Max-Age=0');
    });

    it('前端无需改动即可启用：nativeHttpFetch 的判定与 isPluginAvailable 都成立', () => {
        // src/services/nativeHttpFetch.ts 的平台判定是「不是 native 平台 **且** 平台不是 android」
        // 才判不可用；鸿蒙的 isNativePlatform() 为 true，且 isPluginAvailable('FoliaNative')
        // 查的是本桥上报的 pluginHeaders —— 所以实现了 httpRequest 就自动生效。
        const fetchSrc = readSrc('src/services/nativeHttpFetch.ts');
        expect(fetchSrc).toContain("isNativePlatform?.() !== true && capacitor.getPlatform?.() !== 'android'");
        expect(fetchSrc).toContain("isPluginAvailable('FoliaNative')");
    });
});

describe('HarmonyOS 工程标准文件齐全（DevEco Sync 前置条件）', () => {
    it('具备工程级与模块级构建配置', () => {
        ['hvigor/hvigor-config.json5', 'build-profile.json5', 'entry/build-profile.json5',
         'oh-package.json5', 'entry/oh-package.json5', 'AppScope/app.json5',
         'entry/src/main/module.json5'].forEach((rel) => {
            expect(existsSync(resolve(harmonyRoot, rel)), `缺文件 ${rel}`).toBe(true);
        });
    });

    it('具备混淆规则与包装器（Windows + POSIX）', () => {
        ['entry/obfuscation-rules.txt', 'hvigorw', 'hvigorw.bat'].forEach((rel) => {
            expect(existsSync(resolve(harmonyRoot, rel)), `缺文件 ${rel}`).toBe(true);
        });
    });

    it('hvigor-config 走 all-in-one 模式（dependencies 为空，避免拉私有包失败）', () => {
        const cfg = read('hvigor/hvigor-config.json5');
        expect(cfg).toContain('"dependencies": {}');
        // 私有包不能作为依赖项出现（注释里可以解释为什么）。
        expect(cfg).not.toMatch(/"@ohos\/hvigor-ohos-plugin"\s*:/);
        expect(cfg).toContain('modelVersion');
    });

    it('build-profile 用新版字段（arkTSVersion，不含 signingConfigs）', () => {
        const cfg = read('build-profile.json5');
        expect(cfg).toContain('"arkTSVersion": "1.1"');
        expect(cfg).not.toContain('signingConfigs');
    });
});
