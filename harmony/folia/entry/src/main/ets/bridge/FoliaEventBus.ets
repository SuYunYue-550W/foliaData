// harmony/folia/entry/src/main/ets/bridge/FoliaEventBus.ets
//
// 事件分发：原生 → JS 的单向推送通道。
//
// 为什么需要单独一个文件：Capacitor 的 addListener 把 listener 当函数传给原生，
// 而我们与原生之间只走 JSON（runJavaScript 的字符串），函数过不去。所以：
//   JS 侧（capacitor-harmony-bridge.js）替 listener 编号，把 callbackId 交给原生；
//   原生推事件时回调 window.__foliaHarmonyEmit(callbackId, json)；
//   JS 侧查表转交给真正的 listener。
// 原生这边只管记住「哪个 callbackId 订阅了哪个事件」，以及怎么把事件推回去。

import { webview } from '@kit.ArkWeb';

/** 一个订阅：哪个 callbackId、哪个插件、哪个事件名。 */
class Subscription {
  callbackId: string = '';
  pluginName: string = '';
  eventName: string = '';
  constructor(callbackId: string, pluginName: string, eventName: string) {
    this.callbackId = callbackId;
    this.pluginName = pluginName;
    this.eventName = eventName;
  }
}

export class FoliaEventBus {
  private controller: webview.WebviewController;
  private subscriptions: Map<string, Subscription> = new Map();
  /** 插件 + 事件名 → 该组下的 callbackId 列表（推送时按这个分组取）。 */
  private groups: Map<string, string[]> = new Map();

  constructor(controller: webview.WebviewController) {
    this.controller = controller;
  }

  private static keyOf(pluginName: string, eventName: string): string {
    return `${pluginName}::${eventName}`;
  }

  /** 注册订阅。返回 false 表示原生侧没有 callbackId（JS 没走我们的事件通道）。 */
  add(callbackId: string, pluginName: string, eventName: string): boolean {
    if (!callbackId || !pluginName || !eventName) return false;
    this.subscriptions.set(callbackId, new Subscription(callbackId, pluginName, eventName));
    const key: string = FoliaEventBus.keyOf(pluginName, eventName);
    const list: string[] = this.groups.get(key) ?? [];
    list.push(callbackId);
    this.groups.set(key, list);
    return true;
  }

  /** 退订。callbackId 为空时退订该插件该事件下的全部订阅。 */
  remove(callbackId: string, pluginName: string, eventName: string): void {
    if (callbackId) {
      this.subscriptions.delete(callbackId);
      const key: string = FoliaEventBus.keyOf(pluginName, eventName);
      const list: string[] = this.groups.get(key) ?? [];
      const next: string[] = list.filter((id: string) => id !== callbackId);
      if (next.length) this.groups.set(key, next);
      else this.groups.delete(key);
      return;
    }
    const key: string = FoliaEventBus.keyOf(pluginName, eventName);
    for (const id of this.groups.get(key) ?? []) {
      this.subscriptions.delete(id);
    }
    this.groups.delete(key);
  }

  /** 该插件该事件下是否还有订阅者。 */
  has(pluginName: string, eventName: string): boolean {
    const list: string[] = this.groups.get(FoliaEventBus.keyOf(pluginName, eventName)) ?? [];
    return list.length > 0;
  }

  /**
   * 推事件给某个插件某个事件的所有订阅者。
   * payload 会被 JSON.stringify 成对象字面量注入 runJavaScript。
   */
  emit(pluginName: string, eventName: string, payload: Object): void {
    const key: string = FoliaEventBus.keyOf(pluginName, eventName);
    const list: string[] = this.groups.get(key) ?? [];
    if (!list.length) return;
    let body: string = '';
    try {
      body = JSON.stringify(payload);
    } catch (e) {
      return;
    }
    for (const id of list) {
      // callbackId 来自我们自己的 JS（'hl_' + 数字），不含引号；仍做一次基本转义。
      const script: string = `window.__foliaHarmonyEmit(${JSON.stringify(id)}, ${body});`;
      try {
        this.controller.runJavaScript(script);
      } catch (e) {
        // 页面正在导航，事件丢了；前端的轮询与超时逻辑会兜住。
      }
    }
  }
}
