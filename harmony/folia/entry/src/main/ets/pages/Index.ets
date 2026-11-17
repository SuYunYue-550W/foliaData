// harmony/folia/entry/src/main/ets/pages/Index.ets
// ArkWeb 容器：加载打进 rawfile 的 Folia 前端产物（dist），把原生能力桥注入页面。
// 整个 UI 都是 Web 层，这里只做壳与原生能力桥。
//
// 两个 Web 组件：
//  - 主 Web：Folia 自己的界面（dist/index.html），一直可见；
//  - 宿主 Web：Apple Music 的登录页（music.apple.com）。默认不渲染，只有用户真的
//    去登录 Apple Music 时才显示 —— 平时它不占地方、不抢前台。
//
// 流程（与安卓侧同一套协议）：
//   前端 prepare({script}) → 原生存下脚本并请求显示宿主 → 宿主页面加载完 → 注入脚本
//   → prepare 的 promise 才 resolve → 前端才能发 request。

import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';

import { FoliaHarmonyBridge } from '../bridge/FoliaHarmonyBridge';
import { FoliaAppleMusicHandlers } from '../bridge/FoliaAppleMusicHandlers';

/** 宿主还没建好时用的空代理：方法列表是空的，页面调不到东西。 */
const EMPTY_PROXY: JavaScriptProxy = {
  object: new Object(),
  name: 'foliaHostNative',
  methodList: [],
  controller: new webview.WebviewController()
};

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge?: FoliaHarmonyBridge;
  /** 宿主 Web 要不要渲染（Apple Music 登录时打开）。 */
  @State private hostVisible: boolean = false;
  /** 宿主 Web 的控制器与代理（来自桥里那座宿主）。 */
  private hostController: webview.WebviewController = new webview.WebviewController();
  private hostProxy?: JavaScriptProxy;

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    this.bridge = new FoliaHarmonyBridge(this.controller, ctx);
    const host: FoliaAppleMusicHandlers | undefined = this.bridge?.appleMusicHost;
    if (host) {
      this.hostController = host.controller;
      this.hostProxy = host.javaScriptProxy;
      // 用户点了「登录」→ 把宿主 Web 显示出来。
      host.setShowHandler(() => {
        this.hostVisible = true;
      });
    }
  }

  build() {
    Column() {
      Web({ src: $rawfile('dist/index.html'), controller: this.controller })
        .width('100%')
        .height('100%')
        .domStorageAccess(true)                       // 登录态 / Capacitor 偏好
        .javaScriptAccess(true)                       // React 必须
        .databaseAccess(true)
        .fileAccess(false)
        .mixedMode(MixedMode.All)                     // 在线音源与封面的 http 回退
        // mediaPlaybackRequiresUserGesture 在 API 26 的 WebAttribute 上已移除；
        // 是否允许自动播放交给 ArkWeb 默认策略与前端的用户手势恢复逻辑。
        .onControllerAttached(() => {
          // registerJavaScriptProxy 必须在页面脚本运行前完成。桥脚本本身由构建脚本
          // 作为 index.html 的第一个 <script> 注入，它只负责把调用转发到这里注入的方法。
          this.bridge?.attach();
        })
      // 宿主 Web：Apple Music 的登录页。默认不渲染（if 条件渲染）。
      if (this.hostVisible) {
        Web({ src: FoliaAppleMusicHandlers.startUrl(), controller: this.hostController })
          .width('100%')
          .height('100%')
          .domStorageAccess(true)                     // 登录态与页面自己的会话
          .javaScriptAccess(true)
          .databaseAccess(true)
          .fileAccess(false)
          .mixedMode(MixedMode.All)
          .javaScriptProxy(this.hostProxy ?? EMPTY_PROXY)       // 页面 → 原生：回执通道
          .onControllerAttached(() => {
            this.bridge?.appleMusicHost?.onHostPageLoaded();
          })
          .onPageEnd(() => {
            // Apple 会重定向几次，每次落地都要重新拿到脚本。
            this.bridge?.appleMusicHost?.onHostPageLoaded();
          })
      }
    }
    .width('100%')
    .height('100%')
  }
}
