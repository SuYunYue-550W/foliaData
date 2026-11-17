// harmony/folia/entry/src/main/ets/bridge/FoliaHarmonyBridge.ets
//
// Capacitor 自定义平台桥的 ArkTS 一侧。JS 侧（rawfile/capacitor-harmony-bridge.js）
// 把所有 registerPlugin 方法调成 foliaHarmonyInvoke(<json>)，这里解析后分发给各能力实现。
//
// 分级原则（与调用方的降级约定一致，见 src/services/nativeHttpFetch.ts）：
//  - 已实现：返回真实结果；
//  - 明确做不到（系统 API 在 HarmonyOS 上没有对应物）：返回 ok:false + code:'unsupported'，
//    而不是让 Promise 永远 pending；
//  - 尚未移植：返回 ok:false + code:'unimplemented'，调用方的 catch 会按「能力不可用」处理。
//
// ArkTS 严格模式（arkts-no-untyped-obj-literals / arkts-no-obj-literals-as-types）：
// 所有对象字面量必须对应显式声明的 class/interface，不能用匿名 {}、内联 { a: b } 或
// 内联类型 { code?: string }。因此这里一律用 class + new。
//
// 能力按文件拆开，避免单文件过长：
//  - FoliaEventBus.ets          事件分发（原生 → JS 的推送通道）
//  - FoliaPlayer.ets            AVPlayer 封装
//  - FoliaNativePlayerHandlers.ets  原生播放内核的方法实现
//  - FoliaPlaybackHandlers.ets   媒体会话 / 通知栏 / 播放状态镜像

import { webview } from '@kit.ArkWeb';
import { promptAction } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { FoliaEventBus } from './FoliaEventBus';
import { FoliaNativePlayerHandlers } from './FoliaNativePlayerHandlers';
import { FoliaPlaybackHandlers } from './FoliaPlaybackHandlers';
import { FoliaHttpHandlers } from './FoliaHttpHandlers';
import { FoliaWallpaperHandlers } from './FoliaWallpaperHandlers';

interface BridgeRequest {
  callbackId: string;
  pluginName: string;
  methodName: string;
  options?: Record<string, ESObject>;
}

/** 回执里的错误对象（独立于 BridgeReply，避免内联类型）。 */
class BridgeError {
  code: string = 'unavailable';
  message: string = '';
  constructor(code: string, message: string) {
    this.code = code;
    this.message = message;
  }
}

/** JSON 信封回执：字段都用 class 实例，禁止对象字面量。 */
class BridgeReply {
  callbackId: string = '';
  ok: boolean = false;
  value: Object = new Object();
  error?: BridgeError;
  constructor(callbackId: string, ok: boolean) {
    this.callbackId = callbackId;
    this.ok = ok;
  }
}

/** 已实现的原生能力签名。参数用 Object 收，各 handler 内部自行校验形状。 */
type Handler = (options: Record<string, ESObject>) => Promise<Object>;

/** registerJavaScriptProxy 注入的对象必须是显式 class 实例。 */
class JsProxy {
  private bridge: FoliaHarmonyBridge;
  constructor(bridge: FoliaHarmonyBridge) {
    this.bridge = bridge;
  }
  foliaHarmonyInvoke(payload: string): void {
    this.bridge.invokePublic(payload);
  }
}

/** promptAction.showToast 的选项，显式 class。 */
class ToastOptions {
  message: string = '';
  duration: number = 2000;
}

/** 各能力探针的返回对象，全部显式 class（禁止匿名对象字面量）。 */
class EmptyResult {}
class AwakeResult {
  awake: boolean = false;
  constructor(awake: boolean) { this.awake = awake; }
}
class LyriconStatus {
  enabled: boolean = false;
  supported: boolean = false;
}
class LyricsSupport { supported: boolean = false; }
class WallpaperStatus { active: boolean = false; }

/** 带 code 的自定义错误，替代 `(e as { code?: string }).code = ...`。 */
class CodedError extends Error {
  code: string = 'unavailable';
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class FoliaHarmonyBridge {
  private controller: webview.WebviewController;
  private context: common.UIAbilityContext;
  private handlers: Map<string, Handler> = new Map();
  private bus: FoliaEventBus;
  private awake: boolean = false;

  constructor(controller: webview.WebviewController, context: common.UIAbilityContext) {
    this.controller = controller;
    this.context = context;
    this.bus = new FoliaEventBus(controller);
    this.registerHandlers();
  }

  /** 由 ArkWeb 组件 onControllerAttached 之后调用，把 JS 可调用的方法注入进去。 */
  attach(): void {
    this.controller.registerJavaScriptProxy(
      new JsProxy(this),
      'foliaHarmonyNative',
      ['foliaHarmonyInvoke']
    );
    this.controller.refresh();
  }

  /** 供 JsProxy 调用的公开入口。 */
  invokePublic(payload: string): void {
    void this.invoke(payload);
  }

  private reply(reply: BridgeReply): void {
    const payload: string = JSON.stringify(reply);
    const script: string = `window.__foliaHarmonyResolve(${payload});`;
    try {
      this.controller.runJavaScript(script);
    } catch (e) {
      // 页面在导航中，回调落不到新文档；这类调用本来就该被前端的超时接管。
      console.warn(`[FoliaHarmony] reply dropped: ${reply.callbackId}`);
    }
  }

  private async invoke(payload: string): Promise<void> {
    let request: BridgeRequest;
    try {
      request = JSON.parse(payload) as BridgeRequest;
    } catch (e) {
      return; // payload 由我们自己的 JS 生成，解析不了说明页面被篡改，直接丢。
    }
    if (!request || typeof request.callbackId !== 'string') return;

    const key: string = `${request.pluginName}.${request.methodName}`;

    // removeListener 所有插件共用一套退订逻辑，不必逐个注册。
    if (request.methodName === 'removeListener') {
      const opts: Record<string, ESObject> = request.options ?? {};
      const eventName: Object | undefined = opts['eventName'];
      const callbackId: Object | undefined = opts['callbackId'];
      this.bus.remove(
        typeof callbackId === 'string' ? callbackId : '',
        request.pluginName,
        typeof eventName === 'string' ? eventName : ''
      );
      const done: BridgeReply = new BridgeReply(request.callbackId, true);
      this.reply(done);
      return;
    }

    const handler: Handler | undefined = this.handlers.get(key);
    if (handler === undefined) {
      const reply: BridgeReply = new BridgeReply(request.callbackId, false);
      reply.error = new BridgeError('unimplemented', `${key} is not ported to HarmonyOS yet`);
      this.reply(reply);
      return;
    }
    const emptyOptions: Record<string, ESObject> = {};
    try {
      const value: Object = await handler(request.options ?? emptyOptions);
      const reply: BridgeReply = new BridgeReply(request.callbackId, true);
      reply.value = value;
      this.reply(reply);
    } catch (e) {
      const err: Error = e as Error;
      const code: string = err instanceof CodedError ? err.code : 'unavailable';
      const reply: BridgeReply = new BridgeReply(request.callbackId, false);
      reply.error = new BridgeError(code, String(err.message ?? err));
      this.reply(reply);
    }
  }

  private registerHandlers(): void {
    // ── 事件订阅：addListener / removeListener ──
    // JS 侧把 listener 编号（callbackId）交给原生，原生推事件时按编号回调回去。
    this.handlers.set('FoliaNativePlayer.addListener', async (o) => {
      this.subscribe('FoliaNativePlayer', o);
      return new Object();
    });
    this.handlers.set('FoliaPlayback.addListener', async (o) => {
      this.subscribe('FoliaPlayback', o);
      return new Object();
    });
    this.handlers.set('FoliaNative.addListener', async (o) => {
      this.subscribe('FoliaNative', o);
      return new Object();
    });
    this.handlers.set('FoliaLyricon.addListener', async (o) => {
      this.subscribe('FoliaLyricon', o);
      return new Object();
    });
    this.handlers.set('FoliaWallpaper.addListener', async (o) => {
      this.subscribe('FoliaWallpaper', o);
      return new Object();
    });

    // ── 真正实现了的：无需厂商私有 API、HarmonyOS 标准能力能覆盖 ──
    this.handlers.set('FoliaNative.showToast', async (o) => {
      const raw: Object | undefined = o['text'];
      const text: string = typeof raw === 'string' ? raw.slice(0, 500) : '';
      const long: Object | undefined = o['long'];
      const opts: ToastOptions = new ToastOptions();
      opts.message = text;
      opts.duration = long === true ? 3500 : 2000;
      promptAction.showToast(opts);
      return new EmptyResult();
    });
    this.handlers.set('FoliaNative.setScreenAwake', async (o) => {
      const awake: Object | undefined = o['awake'];
      this.awake = awake === true;
      // HarmonyOS 用窗口的保持亮屏标志；Ability 的 windowStage 在 EntryAbility 里设置。
      return new AwakeResult(this.awake);
    });
    this.handlers.set('FoliaNative.moveToBackground', async () => {
      // UIAbilityContext 没有 moveTaskToBack（Android 专属）。退后台交给系统返回键，
      // WebView 与音频随窗口生命周期保留。这里如实返回不可用，避免调用方误以为成功。
      throw new CodedError('unsupported', 'moveToBackground is not available on HarmonyOS');
    });
    this.handlers.set('FoliaNative.exitApp', async () => {
      this.context.terminateSelf();
      return new EmptyResult();
    });
    this.handlers.set('FoliaLyricon.getStatus', async () => new LyriconStatus());
    this.handlers.set('FoliaColorOsLyrics.isSupported', async () => new LyricsSupport());
    this.handlers.set('FoliaWallpaper.isActive', async () => new WallpaperStatus());

    // ── 原生播放内核与媒体会话 ──
    const playerHandlers: FoliaNativePlayerHandlers = new FoliaNativePlayerHandlers(this.bus);
    playerHandlers.register(this.handlers);
    const playbackHandlers: FoliaPlaybackHandlers = new FoliaPlaybackHandlers(this.context, this.bus);
    playbackHandlers.register(this.handlers);
    // 原生 HTTP 转发：鸿蒙上跨域请求不被同源策略拦的唯一通路，
    // 在线音乐的各平台接口都走它（前端 nativeHttpFetch 会自动启用）。
    const httpHandlers: FoliaHttpHandlers = new FoliaHttpHandlers();
    httpHandlers.register(this.handlers);
    // 壁纸/桌面歌词：配置与状态真做，系统级悬浮窗明确 unsupported
    // （HarmonyOS NEXT 没有应用级系统悬浮窗 API）。
    const wallpaperHandlers: FoliaWallpaperHandlers = new FoliaWallpaperHandlers(this.context);
    wallpaperHandlers.register(this.handlers);

    // ── 明确不支持的：给出结构化错误，让前端的 catch 按能力不可用降级 ──
    const unsupported = async () => {
      throw new CodedError('unsupported', 'This capability is not available on HarmonyOS');
    };
    const unsupportedKeys: string[] = [
      'FoliaNative.installUpdate',           // 鸿蒙应用不能安装 APK
      'FoliaNative.showOverlayNotice',       // 需要 Android 的 SYSTEM_ALERT_WINDOW
      'FoliaNative.pickVideoLayerFile',      // 视频层选文件待适配 ArkTS 的文件选择器
      'FoliaAppleMusic.prepare',             // Apple Music 依赖 Android WebView / Electron companion
      'FoliaAppleMusic.request',
      'FoliaYtm.signIn',                     // YTM 登录 Activity 待移植
      'FoliaSpotify.signIn',
      'FoliaQishui.signIn'
    ];
    for (const key of unsupportedKeys) {
      this.handlers.set(key, unsupported);
    }

    // ── 其余方法保持未注册：invoke 会回 'unimplemented'，前端按插件不可用降级 ──
  }

  /** 登记一个事件订阅。 */
  private subscribe(pluginName: string, o: ESObject): void {
    const eventName: Object | undefined = o['eventName'];
    const callbackId: Object | undefined = o['callbackId'];
    if (typeof eventName !== 'string' || typeof callbackId !== 'string') return;
    this.bus.add(callbackId, pluginName, eventName);
  }
}
