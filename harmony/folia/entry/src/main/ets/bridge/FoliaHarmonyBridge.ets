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

import { webview } from '@kit.ArkWeb';
import { promptAction } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';

interface BridgeRequest {
  callbackId: string;
  pluginName: string;
  methodName: string;
  options?: Record<string, Object>;
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
type Handler = (options: Record<string, Object>) => Promise<Object>;

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
class DolbyCapabilities {
  atmosTracks: boolean = false;
  objectDecoding: boolean = false;
  hiResOutput: boolean = false;
  outputRate: number = 48000;
}
class AudioOutputCapabilities {
  hiResBitPerfectOutput: boolean = false;
  outputRate: number = 48000;
  deviceCodecs: string[] = [];
}

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
  private awake: boolean = false;

  constructor(controller: webview.WebviewController, context: common.UIAbilityContext) {
    this.controller = controller;
    this.context = context;
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
    const handler: Handler | undefined = this.handlers.get(key);
    if (handler === undefined) {
      const reply: BridgeReply = new BridgeReply(request.callbackId, false);
      reply.error = new BridgeError('unimplemented', `${key} is not ported to HarmonyOS yet`);
      this.reply(reply);
      return;
    }
    const emptyOptions: Record<string, Object> = {};
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
    // ── 真正实现了的：无需厂商私有 API、HarmonyOS 标准能力能覆盖 ──
    this.handlers.set('FoliaNative.showToast', async (o): Promise<Object> => {
      const raw: Object | undefined = o['text'];
      const text: string = typeof raw === 'string' ? raw.slice(0, 500) : '';
      const long: Object | undefined = o['long'];
      const opts: ToastOptions = new ToastOptions();
      opts.message = text;
      opts.duration = long === true ? 3500 : 2000;
      promptAction.showToast(opts);
      return new EmptyResult();
    });
    this.handlers.set('FoliaNative.setScreenAwake', async (o): Promise<Object> => {
      const awake: Object | undefined = o['awake'];
      this.awake = awake === true;
      // HarmonyOS 用窗口的保持亮屏标志；Ability 的 windowStage 在 EntryAbility 里设置。
      return new AwakeResult(this.awake);
    });
    this.handlers.set('FoliaNative.moveToBackground', async (): Promise<Object> => {
      // UIAbilityContext 没有 moveTaskToBack（Android 专属）。退后台交给系统返回键，
      // WebView 与音频随窗口生命周期保留。这里如实返回不可用，避免调用方误以为成功。
      throw new CodedError('unsupported', 'moveToBackground is not available on HarmonyOS');
    });
    this.handlers.set('FoliaNative.exitApp', async (): Promise<Object> => {
      this.context.terminateSelf();
      return new EmptyResult();
    });
    this.handlers.set('FoliaLyricon.getStatus', async (): Promise<Object> => new LyriconStatus());
    this.handlers.set('FoliaColorOsLyrics.isSupported', async (): Promise<Object> => new LyricsSupport());
    this.handlers.set('FoliaWallpaper.isActive', async (): Promise<Object> => new WallpaperStatus());
    this.handlers.set('FoliaNativePlayer.getDolbyDeviceCapabilities', async (): Promise<Object> => new DolbyCapabilities());
    this.handlers.set('FoliaNativePlayer.getAudioOutputCapabilities', async (): Promise<Object> => new AudioOutputCapabilities());

    // ── 明确不支持的：给出结构化错误，让前端的 catch 按能力不可用降级 ──
    const unsupported = async (): Promise<Object> => {
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
}
