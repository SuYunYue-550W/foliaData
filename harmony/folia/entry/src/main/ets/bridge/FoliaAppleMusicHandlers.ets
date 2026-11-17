// harmony/folia/entry/src/main/ets/bridge/FoliaAppleMusicHandlers.ets
//
// FoliaAppleMusic 的方法实现：鸿蒙上的 Apple Music 宿主。
//
// 对应前端 src/services/onlineMusic/appleMusic/harmony/appleMusicHarmonyBridge.ts，
// 协议与安卓侧完全一致（页面运行时 pageScript.ts 整个注入宿主 WebView）：
//
//   prepare({script})     注入页面运行时，等页面就绪
//   request({operation, params})  把一次操作交给页面里的 window.__foliaHandle，
//                              页面算完经 foliaHostNative.result(nonce, payload) 带回
//   setForeground({active})      前台保持（鸿蒙上不需要前台服务，只是对齐协议）
//   logout()                    清 cookie 并让页面重新就绪
//   dispose()                   丢弃宿主
//
// 页面里的操作名与安卓共用一套（showWindow / hideWindow / accountStatus / search …）。

import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { FoliaWebHost } from './FoliaWebHost';
import { Handler } from './FoliaNativePlayerHandlers';
import { optString } from './FoliaBridgeOptions';

/** Apple Music 的起点页面。 */
const START_URL: string = 'https://music.apple.com/';

/** 页面只许去的四个 Apple 域（与桌面 companion 的 navigationPolicy 同一张表）。 */
const ALLOWED_DOMAINS: string[] = [
  'music.apple.com', 'account.apple.com', 'appleid.apple.com', 'idmsa.apple.com'
];

/** 登出时要清的 cookie 地址。 */
const ERASE_COOKIE_URLS: string[] = [
  'https://music.apple.com/', 'https://account.apple.com/',
  'https://appleid.apple.com/', 'https://idmsa.apple.com/'
];

/** prepare 的返回形状。 */
class PrepareResult {
  ready: boolean = false;
}

/** request 的返回形状（信封与桌面同构）。 */
class RequestResult {
  ok: boolean = false;
  data: Object = new Object();
  error: string = '';
  httpStatus: number = -1;
  playbackStage: string = '';
}

/** request 的入参（operation + params）。 */
class RequestOptions {
  operation: string = '';
  params: string = '{}';
}

/** setForeground 的入参。 */
class ForegroundOptions {
  active: boolean = false;
}

export class FoliaAppleMusicHandlers {
  private host: FoliaWebHost;
  private script: string = '';
  private ready: boolean = false;
  /** 页面就绪的等待者：宿主页面加载完并注入了脚本时翻牌。 */
  private readyWaiters: Array<() => void> = [];
  /** Index.ets 提供的回调：请求把宿主 Web 显示出来（用户点了登录时才需要）。 */
  private showRequest: (() => void) | undefined = undefined;

  constructor(context: common.UIAbilityContext) {
    this.host = new FoliaWebHost(context);
  }

  /** Index.ets 挂上：宿主 Web 要显示时调用它。 */
  setShowHandler(handler: () => void): void {
    this.showRequest = handler;
  }

  /** 宿主页面的脚本由前端 prepare 带过来（与安卓同一套：前端把 pageScript 的源码送进来）。 */
  private setScript(script: string): void {
    this.script = script;
  }

  /** 页面就绪时翻牌：把等着 prepare 的人放行。 */
  private markReady(): void {
    this.ready = true;
    const waiters: Array<() => void> = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  /** 等页面就绪（最多 20 秒，与安卓的 READY_TIMEOUT_MS 同值）。 */
  private whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled: boolean = false;
      const timer: number = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, 20000);
      this.readyWaiters.push(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** 宿主 Web 组件（Index.ets 把它挂上去）。 */
  get webHost(): FoliaWebHost {
    return this.host;
  }

  /** 宿主是否已就绪（页面加载完并注入了脚本）。 */
  get isReady(): boolean {
    return this.ready && this.host.isReady;
  }

  /**
   * 页面加载完成时由 Index.ets 调用：注入脚本并翻就绪。
   *
   * 脚本来自前端 prepare 带来的那份（pageScript.ts 的函数源码，自包含）。
   * 页面还没拿到脚本时（prepare 还没来）不注入 —— 那时页面里没有 window.__foliaHandle。
   */
  onHostPageLoaded(): void {
    if (!this.script) return;
    this.host.onPageLoaded(this.script);
    this.markReady();
  }

  /** 宿主 Web 的控制器（Index.ets 用它挂 Web 组件）。 */
  get controller(): webview.WebviewController {
    return this.host.webController;
  }

  /** javaScriptProxy（页面 → 原生）。 */
  get javaScriptProxy(): JavaScriptProxy {
    return this.host.javaScriptProxy;
  }

  /** 宿主要加载的地址。 */
  static startUrl(): string {
    return START_URL;
  }

  /** 页面导航是否放行（只许那几个 Apple 域，https-only）。 */
  static isAllowedUrl(url: string): boolean {
    if (url.startsWith('about:blank')) return true;
    const lower: string = url.toLowerCase();
    if (!lower.startsWith('https://')) return false;
    for (const domain of ALLOWED_DOMAINS) {
      if (lower.startsWith(`https://${domain}/`) || lower.startsWith(`https://${domain}?`)) return true;
    }
    return false;
  }

  register(handlers: Map<string, Handler>): void {
    handlers.set('FoliaAppleMusic.prepare', async (o) => {
      const script: string = optString(o, 'script');
      if (!script) throw new Error('prepare requires a script');
      this.setScript(script);
      // 宿主 Web 要显示出来（用户点了登录才走到这里）；已经就绪就不用再显示。
      if (!this.ready && this.showRequest) {
        this.showRequest();
      }
      await this.whenReady();
      if (!this.ready) throw new Error('not-ready');
      const result: PrepareResult = new PrepareResult();
      result.ready = true;
      return result;
    });

    handlers.set('FoliaAppleMusic.request', async (o) => {
      const operation: string = optString(o, 'operation');
      if (!operation) throw new Error('invalid-request');
      if (!this.isReady) throw new Error('not-ready');
      const params: string = this.paramsOf(o);
      let payload: string;
      try {
        payload = await this.host.request(operation, params, 25000);
      } catch (error) {
        const message: string = String((error as Error)?.message ?? error);
        throw new Error(message || 'request-failed');
      }
      return this.foldPayload(payload);
    });

    handlers.set('FoliaAppleMusic.setForeground', async (o) => {
      // 鸿蒙上不需要前台服务：宿主 WebView 就在应用内，随应用生命周期走。
      // 这个方法只是为了与安卓协议对齐，收到即忽略。
      const options: ForegroundOptions = new ForegroundOptions();
      options.active = o['active'] === true;
      return new Object();
    });

    handlers.set('FoliaAppleMusic.logout', async () => {
      // 登出：先清 cookie，再让页面重新加载起点（它会回到未登录的样子）。
      for (const url of ERASE_COOKIE_URLS) {
        this.host.clearCookiesFor(url);
      }
      this.host.webController.loadUrl(START_URL);
      return new Object();
    });

    handlers.set('FoliaAppleMusic.dispose', async () => {
      this.ready = false;
      this.host.webController.loadUrl('about:blank');
      return new Object();
    });
  }

  /** params 可能是对象也可能是字符串（个别调用方把整包序列化成字符串）。 */
  private paramsOf(o: ESObject): string {
    const params: ESObject = o['params'];
    if (params === undefined || params === null) return '{}';
    if (typeof params === 'string') {
      return params.length ? params : '{}';
    }
    try {
      return JSON.stringify(params);
    } catch (e) {
      return '{}';
    }
  }

  /** 页面带回的 payload 是 JSON 字符串，折成桥要的形状。 */
  private foldPayload(payload: string): RequestResult {
    const result: RequestResult = new RequestResult();
    let parsed: ESObject;
    try {
      parsed = JSON.parse(payload) as ESObject;
    } catch (e) {
      result.ok = false;
      result.error = 'invalid-response';
      return result;
    }
    result.ok = parsed['ok'] === true;
    if (result.ok) {
      const data: ESObject = parsed['data'];
      result.data = data === undefined || data === null ? new Object() : data;
      return result;
    }
    const error: ESObject = parsed['error'];
    result.error = typeof error === 'string' ? error : 'request-failed';
    const status: ESObject = parsed['httpStatus'];
    if (typeof status === 'number') result.httpStatus = status;
    const stage: ESObject = parsed['playbackStage'];
    if (typeof stage === 'string') result.playbackStage = stage;
    return result;
  }
}
