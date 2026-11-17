// harmony/folia/entry/src/main/ets/bridge/FoliaWallpaperHandlers.ets
//
// FoliaWallpaper 的方法实现。
//
// 对应前端 src/platform/foliaWallpaper.ts 的 FoliaWallpaperPlugin（22 个方法）。
//
// ⚠️ 能力边界（本文件最重要的一件事，说在前面）：
//
// Android 的「桌面悬浮窗」靠的是 SYSTEM_ALERT_WINDOW：应用可以在别的应用之上画一层
// 自己��窗口，桌宠与滚动歌词就画在那层上。**HarmonyOS NEXT 没有这套 API** ——
// SDK 里没有 createFloatingWindow / getFloatingWindowList，只有 TYPE_FLOAT 枚举与
// createSubWindow（应用内子窗口，不是系统级悬浮窗）；SYSTEM_FLOATING_WINDOW 权限
// 也只给系统应用与特定场景。
//
// 所以这里的做法是：
//  - **配置与状态类**：真做。字体、背景模式、外观这些本来就该落在原生侧持久化
//    （preferences），桌面端与鸿蒙侧语义一致，前端读到的值是一样的。
//  - **系统级交互**：如实回 unsupported（打开系统选择器、跳系统设置页）。
//  - **真正的悬浮窗渲染**：publish 明确回 unsupported —— 做不到的事不假装。
//
// 前端每个调用点都有 try/catch 兜底（见 foliaWallpaper.ts 的 hasWallpaperOverlayPermission
// / isLyricsWallpaperActive），原生如实返回后前端会按「能力不可用」收起入口，
// 不会出现「点进去才发现不行」。

import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { Handler } from './FoliaNativePlayerHandlers';
import { optString } from './FoliaBridgeOptions';

/** preferences 里的键。 */
const KEY_FONT: string = 'folia_wallpaper_font';
const KEY_FOLLOW_FONT: string = 'folia_wallpaper_follow_font';
const KEY_BACKGROUND: string = 'folia_wallpaper_background';
const KEY_IMAGE: string = 'folia_wallpaper_image';
const KEY_VISUALIZER: string = 'folia_wallpaper_visualizer';
const KEY_VIDEO: string = 'folia_wallpaper_video';
const KEY_PREVIEW: string = 'folia_wallpaper_preview';

/** getFont 的返回形状。 */
class FontResult {
  font: boolean = false;
}

/** getBackground 的返回形状。 */
class BackgroundResult {
  mode: string = 'cover';
}

/** getVideo 的返回形状。 */
class VideoResult {
  has: boolean = false;
}

/** isActive 的返回形状。 */
class ActiveResult {
  active: boolean = false;
}

/** hasOverlayPermission 的返回形状。 */
class OverlayPermissionResult {
  granted: boolean = false;
}

/** pickFont / pickVideo / openPicker 的返回形状。 */
class PickedResult {
  picked: boolean = false;
  rejected: boolean = false;
}

/** openRomPermission 的返回形状。 */
class OpenedResult {
  opened: boolean = false;
}

/** getLockScreenStatus 的返回形状。 */
class LockScreenStatus {
  started: boolean = false;
  blocked: boolean = false;
  hosted: boolean = false;
  attempts: number = 0;
  error: string = '';
  rom: string = '';
  overlayGranted: boolean = false;
}

/** getOverlayEventLog 的返回形状。 */
class OverlayEventLog {
  events: string[] = [];
}

export class FoliaWallpaperHandlers {
  private context: common.UIAbilityContext;
  private store: preferences.Preferences | undefined = undefined;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  /** 懒加载 preferences：只有真用到配置的方法才会碰它。 */
  private async prefs(): Promise<preferences.Preferences> {
    if (!this.store) {
      this.store = await preferences.getPreferences(this.context, 'folia_wallpaper');
    }
    return this.store;
  }

  register(handlers: Map<string, Handler>): void {
    // ── 配置类：真做（持久化在原生侧） ──
    handlers.set('FoliaWallpaper.setAppearance', async (o) => {
      const store: preferences.Preferences = await this.prefs();
      // 逐字段存：手工拼 JSON 字符串会被内容里的引号与反斜杠坑到。
      // 只写传了的字段 —— 前端约定「不传 = 不改」。
      const background: string = optString(o, 'background');
      if (background) {
        await store.put(KEY_BACKGROUND, background);
      }
      const image: string = optString(o, 'image');
      if (image) {
        await store.put(KEY_IMAGE, image);
      }
      const visualizer: string = optString(o, 'visualizer');
      if (visualizer) {
        await store.put(KEY_VISUALIZER, visualizer);
      }
      await store.flush();
      return new Object();
    });

    handlers.set('FoliaWallpaper.getBackground', async () => {
      const store: preferences.Preferences = await this.prefs();
      const mode: preferences.ValueType = await store.get(KEY_BACKGROUND, 'cover');
      const result: BackgroundResult = new BackgroundResult();
      result.mode = typeof mode === 'string' ? mode : 'cover';
      return result;
    });

    handlers.set('FoliaWallpaper.setFont', async (o) => {
      const store: preferences.Preferences = await this.prefs();
      const font: string = optString(o, 'font');
      await store.put(KEY_FONT, font);
      await store.flush();
      return new Object();
    });

    handlers.set('FoliaWallpaper.setFollowFont', async (o) => {
      const store: preferences.Preferences = await this.prefs();
      const font: string = optString(o, 'font');
      await store.put(KEY_FOLLOW_FONT, font);
      await store.flush();
      return new Object();
    });

    handlers.set('FoliaWallpaper.getFont', async () => {
      const store: preferences.Preferences = await this.prefs();
      const font: preferences.ValueType = await store.get(KEY_FONT, '');
      const result: FontResult = new FontResult();
      result.font = typeof font === 'string' && font.length > 0;
      return result;
    });

    handlers.set('FoliaWallpaper.setFloatingPreview', async (o) => {
      const store: preferences.Preferences = await this.prefs();
      const on: boolean = o['on'] === true;
      await store.put(KEY_PREVIEW, on);
      await store.flush();
      return new Object();
    });

    handlers.set('FoliaWallpaper.getVideo', async () => {
      const store: preferences.Preferences = await this.prefs();
      const video: preferences.ValueType = await store.get(KEY_VIDEO, '');
      const result: VideoResult = new VideoResult();
      result.has = typeof video === 'string' && video.length > 0;
      return result;
    });

    // ── 状态类：鸿蒙没有系统级悬浮窗，如实反映 ──
    handlers.set('FoliaWallpaper.isActive', async () => {
      // 鸿蒙上桌面悬浮窗不存在，自然没有「壁纸正在显示」这回事。
      const result: ActiveResult = new ActiveResult();
      result.active = false;
      return result;
    });

    handlers.set('FoliaWallpaper.hasOverlayPermission', async () => {
      const result: OverlayPermissionResult = new OverlayPermissionResult();
      result.granted = false;
      return result;
    });

    handlers.set('FoliaWallpaper.getLockScreenStatus', async () => {
      // 锁屏歌词与 ColorOS 的后台开关都是 Android 专属；这里给一份「什么都没发生」的快照。
      const result: LockScreenStatus = new LockScreenStatus();
      result.started = false;
      result.blocked = false;
      result.hosted = false;
      result.attempts = 0;
      result.rom = '';
      result.overlayGranted = false;
      return result;
    });

    handlers.set('FoliaWallpaper.getOverlayEventLog', async () => {
      const result: OverlayEventLog = new OverlayEventLog();
      result.events = [];
      return result;
    });

    // ── 清理类：真做（清掉自己存的东西） ──
    handlers.set('FoliaWallpaper.clearImage', async () => {
      const store: preferences.Preferences = await this.prefs();
      await store.delete(KEY_IMAGE);
      await store.delete(KEY_VISUALIZER);
      await store.flush();
      return new Object();
    });

    handlers.set('FoliaWallpaper.clearVideo', async () => {
      const store: preferences.Preferences = await this.prefs();
      await store.put(KEY_VIDEO, '');
      await store.flush();
      return new Object();
    });

    handlers.set('FoliaWallpaper.clear', async () => {
      const store: preferences.Preferences = await this.prefs();
      await store.clear();
      await store.flush();
      return new Object();
    });

    handlers.set('FoliaWallpaper.resetFloatingLyrics', async () => {
      // 没有悬浮窗就没有可重置的歌词层；当成成功，前端的调用方不会因此报错。
      return new Object();
    });

    handlers.set('FoliaWallpaper.heartbeat', async () => {
      // 心跳是给 Android 悬浮窗进程保活的；鸿蒙侧没有悬浮窗进程，收到即忽略。
      return new Object();
    });

    handlers.set('FoliaWallpaper.publishCappellaImages', async () => {
      // 群唱头像/表情图是喂给悬浮窗渲染的，没有悬浮窗就无处可去。
      return new Object();
    });

    // ── 做不到的：如实回 unsupported ──
    const unsupported = async (): Promise<Object> => {
      throw new Error('This capability is not available on HarmonyOS');
    };
    // 真正的悬浮窗渲染：HarmonyOS NEXT 没有应用级系统悬浮窗 API。
    handlers.set('FoliaWallpaper.publish', unsupported);
    // 系统级选择器与系统设置页：鸿蒙上要走各自的 Picker 与 Want，这里没有对应实现。
    handlers.set('FoliaWallpaper.pickFont', unsupported);
    handlers.set('FoliaWallpaper.pickVideo', unsupported);
    handlers.set('FoliaWallpaper.openPicker', unsupported);
    handlers.set('FoliaWallpaper.openOverlaySettings', unsupported);
    handlers.set('FoliaWallpaper.openRomPermission', unsupported);
  }
}
