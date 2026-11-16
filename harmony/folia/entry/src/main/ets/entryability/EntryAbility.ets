import { UIAbility, Want, AbilityConstant } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';

// 鸿蒙应用的入口 Ability：只负责建窗口、设全屏与常亮策略，UI 全在 ArkWeb（Index.ets）里。
export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 前端产物与桥脚本都已由 scripts/sync-web-assets.sh 打进 rawfile。
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err: BusinessError) => {
      if (err.code) {
        console.error(`[FoliaHarmony] loadContent failed: ${JSON.stringify(err)}`);
        return;
      }
      windowStage.getMainWindowSync().setWindowLayoutFullScreen(true);
    });
  }

  onForeground(): void { /* WebView 与桥随窗口生命周期走，无需额外处理。 */ }
  onBackground(): void { /* 后台播放由 WebView 的媒体会话维持；原生侧不销毁页面。 */ }
  onDestroy(): void { /* 系统回收时 WebView 自然释放。 */ }
}
