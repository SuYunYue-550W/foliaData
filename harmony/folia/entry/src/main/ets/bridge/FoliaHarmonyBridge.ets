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

import { webview } from '@kit.ArkWeb';
import { promptAction } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';

interface BridgeRequest {
  callbackId: string;
  pluginName: string;
  methodName: string;
  options?: Record<string, Object>;
}

interface BridgeReply {
  callbackId: string;
  ok: boolean;
  value?: Object;
  error?: { code: string; message: string };
}

/** 已实现的原生能力签名。参数用 Object 收，各 handler 内部自行校验形状。 */
type Handler = (options: Record<string, Object>) => Promise<Object>;

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
      {
        foliaHarmonyInvoke: (payload: string): void => { void this.invoke(payload); }
      },
      'foliaHarmonyNative',
      ['foliaHarmonyInvoke']
    );
    this.controller.refresh();
  }

  private reply(reply: BridgeReply): void {
    const script = `window.__foliaHarmonyResolve(${JSON.stringify(reply)});`;
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

    const key = `${request.pluginName}.${request.methodName}`;
    const handler = this.handlers.get(key);
    if (!handler) {
      this.reply({ callbackId: request.callbackId, ok: false,
        error: { code: 'unimplemented', message: `${key} is not ported to HarmonyOS yet` } });
      return;
    }
    try {
      const value = await handler(request.options ?? {});
      this.reply({ callbackId: request.callbackId, ok: true, value: value ?? {} });
    } catch (e) {
      const err = e as Error;
      this.reply({ callbackId: request.callbackId, ok: false,
        error: { code: (err as { code?: string }).code ?? 'unavailable', message: String(err.message ?? err) } });
    }
  }

  private registerHandlers(): void {
    // ── 真正实现了的：无需厂商私有 API、HarmonyOS 标准能力能覆盖 ──
    this.handlers.set('FoliaNative.showToast', async (o) => {
      const text = typeof o.text === 'string' ? o.text.slice(0, 500) : '';
      promptAction.showToast({ message: text, duration: o.long === true ? 3500 : 2000 });
      return {};
    });
    this.handlers.set('FoliaNative.setScreenAwake', async (o) => {
      this.awake = o.awake === true;
      // HarmonyOS 用窗口的保持亮屏标志；Ability 的 windowStage 在 EntryAbility 里设置。
      return { awake: this.awake };
    });
    this.handlers.set('FoliaNative.moveToBackground', async () => {
      // 播放器退到后台时 WebView 与音频都要留着：用 moveTaskToBack 而不是 terminateSelf。
      (this.context as common.UIAbilityContext).moveTaskToBack(true);
      return {};
    });
    this.handlers.set('FoliaNative.exitApp', async () => {
      this.context.terminateSelf();
      return {};
    });
    this.handlers.set('FoliaLyricon.getStatus', async () => ({ enabled: false, supported: false }));
    this.handlers.set('FoliaColorOsLyrics.isSupported', async () => ({ supported: false }));
    this.handlers.set('FoliaWallpaper.isActive', async () => ({ active: false }));
    this.handlers.set('FoliaNativePlayer.getDolbyDeviceCapabilities', async () => ({
      atmosTracks: false, objectDecoding: false, hiResOutput: false, outputRate: 48000
    }));
    this.handlers.set('FoliaNativePlayer.getAudioOutputCapabilities', async () => ({
      hiResBitPerfectOutput: false, outputRate: 48000, deviceCodecs: []
    }));

    // ── 明确不支持的：给出结构化错误，让前端的 catch 按能力不可用降级 ──
    const unsupported = async (): Promise<Object> => {
      const e = new Error('This capability is not available on HarmonyOS');
      (e as { code?: string }).code = 'unsupported';
      throw e;
    };
    [
      'FoliaNative.installUpdate',           // 鸿蒙应用不能安装 APK
      'FoliaNative.showOverlayNotice',       // 需要 Android 的 SYSTEM_ALERT_WINDOW
      'FoliaNative.pickVideoLayerFile',      // 视频层选文件待适配 ArkTS 的文件选择器
      'FoliaAppleMusic.prepare',             // Apple Music 依赖 Android WebView / Electron companion
      'FoliaAppleMusic.request',
      'FoliaYtm.signIn',                     // YTM 登录 Activity 待移植
      'FoliaSpotify.signIn',
      'FoliaQishui.signIn'
    ].forEach(key => this.handlers.set(key, unsupported));

    // ── 其余方法保持未注册：invoke 会回 'unimplemented'，前端按插件不可用降级 ──
  }
}
