// harmony/folia/entry/src/main/ets/pages/Index.ets
// ArkWeb 容器：加载打进 rawfile 的 Folia 前端产物（dist），把原生能力桥注入页面。
// 整个 UI 都是 Web 层，这里只做壳与原生能力桥。
//
// ⚠️ 本工程未能在本机编译（无 DevEco Studio / HarmonyOS SDK），以下 ArkTS 在真机上首次
//    编译时如有个别 API 签名差异（不同 SDK 版本），按 DevEco 的报错微调即可，结构不变。

import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { FoliaHarmonyBridge } from '../bridge/FoliaHarmonyBridge';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge?: FoliaHarmonyBridge;

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    this.bridge = new FoliaHarmonyBridge(this.controller, ctx);
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
        .mediaPlaybackRequiresUserGesture(false)      // 恢复播放时不需要再次手势
        .onControllerAttached(() => {
          // registerJavaScriptProxy 必须在页面脚本运行前完成。桥脚本本身由构建脚本
          // 作为 index.html 的第一个 <script> 注入，它只负责把调用转发到这里注入的方法。
          this.bridge?.attach();
        })
    }
    .width('100%')
    .height('100%')
  }
}
