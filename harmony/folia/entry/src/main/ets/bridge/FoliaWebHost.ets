// harmony/folia/entry/src/main/ets/bridge/FoliaWebHost.ets
//
// 通用 ArkWeb 宿主：给「需要在真实浏览器页面里完成登录/取数」的平台用。
//
// 为什么需要它：Spotify 的 OAuth 回调、汽水的签名组件、YTM 的 cookie 登录、
// Apple Music 的 companion 窗口，这四家都要「一个真的浏览器页面」才能登录 —
// 纯 HTTP 请求替代不了（回调地址、页面内的签名脚本、跨域 cookie 串联）。
// Android 那边是每家起一座 Activity（AppleMusicHostActivity / QishuiSignHost …），
// 鸿蒙这边改成同一页面里两个 Web 组件：主 Web 跑 Folia，宿主 Web 跑平台页面。
//
// 通信方式（与 Android 的 HostBridge 同一套思路）：
//   宿主页面 → 原生：Web 组件的 javaScriptProxy 注入一个对象，页面调用它的方法
//   原生 → 宿主页面：webviewController.runJavaScript('window.__foliaHandle(...)')
// 原生 → 主 Web（Folia）：走现有的 Capacitor 桥回执
//
// 凭据：登录完成后从 ArkWeb 的 cookie 罐取（webview.WebCookieManager.getCookie），
// 页面自己的 localStorage 由 domStorageAccess 保持。

import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';

/** 宿主页面回给原生的一条消息。 */
export class HostMessage {
  /** 这次请求的编号，用来把回执对回原请求。 */
  id: string = '';
  /** 页面给出的结果（JSON 字符串）。 */
  payload: string = '';
  /** 页面遇到的问题（空串 = 没出错）。 */
  error: string = '';
}

/** javaScriptProxy 注入给宿主页面的对象：页面只能调这两个方法。 */
export class HostBridge {
  private resolve: (message: HostMessage) => void = () => {};
  private reject: (message: HostMessage) => void = () => {};

  constructor(resolve: (message: HostMessage) => void, reject: (message: HostMessage) => void) {
    this.resolve = resolve;
    this.reject = reject;
  }

  /** 页面交回一次请求的结果。 */
  foliaHostResult(id: string, payload: string): void {
    const message: HostMessage = new HostMessage();
    message.id = id;
    message.payload = payload;
    this.resolve(message);
  }

  /** 页面报告一次请求失败。 */
  foliaHostError(id: string, error: string): void {
    const message: HostMessage = new HostMessage();
    message.id = id;
    message.error = error;
    this.reject(message);
  }
}

/** 一次待回的请求。 */
class PendingRequest {
  id: string = '';
  resolve: (payload: string) => void = () => {};
  reject: (error: string) => void = () => {};
  constructor(id: string, resolve: (payload: string) => void, reject: (error: string) => void) {
    this.id = id;
    this.resolve = resolve;
    this.reject = reject;
  }
}

export class FoliaWebHost {
  private controller: webview.WebviewController = new webview.WebviewController();
  private context: common.UIAbilityContext;
  private pending: Map<string, PendingRequest> = new Map();
  private seq: number = 0;
  private pageReady: boolean = false;
  /** 注入页面的脚本源码（一个 function 表达式，定义 window.__foliaHandle）。 */
  private script: string = '';
  private proxy: HostBridge;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
    this.proxy = new HostBridge(
      (message: HostMessage): void => {
        const request: PendingRequest | undefined = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        request.resolve(message.payload);
      },
      (message: HostMessage): void => {
        const request: PendingRequest | undefined = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        request.reject(message.error);
      }
    );
  }

  get webController(): webview.WebviewController {
    return this.controller;
  }

  /** 页面是否已加载并注入了脚本。 */
  get isReady(): boolean {
    return this.pageReady;
  }

  /** javaScriptProxy 的注册对象（ArkTS 严格模式：要显式 class 实例）。 */
  get javaScriptProxy(): JavaScriptProxy {
    const proxy: JavaScriptProxy = {
      object: this.proxy,
      name: 'foliaHostNative',
      methodList: ['foliaHostResult', 'foliaHostError'],
      controller: this.controller
    };
    return proxy;
  }

  /** 宿主页面加载完成时调用：注入脚本并翻就绪。 */
  onPageLoaded(script: string): void {
    this.script = script;
    this.pageReady = false;
    this.controller.runJavaScript('window.__foliaHandle = ' + script + '; void 0;');
    this.pageReady = true;
  }

  /**
   * 向宿主页面发一次请求，等它的回执。
   *
   * operation 与 params 的形状由页面自己的脚本决定（各平台不同），这里只负责
   * 把它们原样送过去并把回执带回来。
   */
  request(operation: string, params: string, timeoutMs: number = 30000): Promise<string> {
    if (!this.pageReady) {
      return Promise.reject('host page is not ready');
    }
    const id: string = 'host_' + (++this.seq);
    const script: string = `window.__foliaHandle(${JSON.stringify(id)}, ${JSON.stringify(operation)}, ${params});`;
    return new Promise<string>((resolve, reject) => {
      const request: PendingRequest = new PendingRequest(id, resolve, reject);
      this.pending.set(id, request);
      try {
        this.controller.runJavaScript(script);
      } catch (e) {
        this.pending.delete(id);
        reject('failed to run script in the host page');
        return;
      }
      // 超时兜底：页面脚本可能自己都不回了，不能让调用方永远等。
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject('host page did not answer in time');
      }, timeoutMs);
    });
  }

  /**
   * 取宿主页面所在域的 cookie（登录凭据）。
   *
   * ArkWeb 的 cookie 罐是全应用共享的：宿主页登录过的凭据就在这里，
   * 主 Web 需要带凭据的请求（<img> / <audio>）也吃这一份。
   */
  cookiesFor(url: string): string {
    try {
      return webview.WebCookieManager.getCookie(url);
    } catch (e) {
      return '';
    }
  }

  /** 清掉某个域的 cookie（登出用）。 */
  clearCookiesFor(url: string): void {
    try {
      webview.WebCookieManager.clearAllCookiesSync();
    } catch (e) {
      // 清不掉就算了：登出失败不该把登录流程整个打断。
    }
  }
}
