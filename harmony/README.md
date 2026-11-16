# Folia 鸿蒙（HarmonyOS NEXT）移植工程

> ⚠️ **状态：源码骨架，未在本机编译验证。** 本机没有 DevEco Studio / HarmonyOS SDK，
> 且 HarmonyOS NEXT 不兼容 Android APK（现成的 `Folia-Android-0.7.32.apk` 只能在
> HarmonyOS 4 及以下安装）。本工程提供可导入 DevEco 的完整结构、Capacitor 兼容桥与
> 构建发布配置，**首次编译与真机验证必须在有 SDK 的环境完成**。

## 一、设计思路：前端零改动

HarmonyOS 的 ArkWeb 组件本质是个 Chromium WebView，Capacitor core 原生支持
「自定义平台」——只要在页面脚本运行前设好 `window.CapacitorCustomPlatform` 与
`window.Capacitor.PluginHeaders`，并提供 `nativePromise/nativeCallback` 两个函数，
所有 `registerPlugin('FoliaNative')` 之类的调用都会自动转发给原生桥。

因此本移植**不改前端一行代码**：

```
React 前端 (dist)  ── registerPlugin() ──▶  capacitor-harmony-bridge.js
                                              │  (window.foliaHarmonyInvoke JSON)
                                              ▼
                                       FoliaHarmonyBridge.ets
                                              │  按 pluginName.methodName 分发
                                              ▼
                                   ArkTS 能力实现 / unsupported / unimplemented
```

## 二、目录结构

| 路径 | 作用 |
|---|---|
| `AppScope/app.json5` | 应用标识 `top.izuna.foliamajor.harmony`、版本 0.7.32 / 7031200 |
| `build-profile.json5` | HarmonyOS SDK 5.0.0(12)，手机/平板 |
| `entry/src/main/ets/pages/Index.ets` | ArkWeb 容器，加载 `rawfile/dist/index.html` |
| `entry/src/main/ets/bridge/FoliaHarmonyBridge.ets` | 插件桥：已实现 / unsupported / unimplemented 三级 |
| `entry/src/main/ets/entryability/EntryAbility.ets` | 应用入口，全屏窗口 |
| `entry/src/main/resources/rawfile/capacitor-harmony-bridge.js` | Capacitor 自定义平台桥（注入到 HTML） |
| `scripts/sync-web-assets.sh` | 构建前端 → 拷进 rawfile → 在 index.html 注入桥脚本 |
| `hvigor/hvigor-config.json5` | Hvigor 版本与 `@ohos/hvigor-ohos-plugin` 依赖（API 12+ 必需，版本需按本机 DevEco 校准） |
| `entry/build-profile.json5` | 模块级构建配置 + Release 混淆规则引用 |
| `entry/obfuscation-rules.txt` | 保留桥方法名不被混淆（JS 侧按字符串调用） |
| `hvigorw` / `hvigorw.bat` | 包装器转发占位，首次 Sync 后由 DevEco 替换为真实实现 |
| `.gitignore` / `local.properties.example` | 忽略本地构建产物 / SDK 路径模板 |

## 三、能力状态（诚实清单）

| 分级 | 方法 | 说明 |
|---|---|---|
| ✅ 已实现 | `FoliaNative.showToast / moveToBackground / exitApp / setScreenAwake`；两类音频能力探针 | HarmonyOS 标准 API 可直接覆盖 |
| ⛔ unsupported | `FoliaNative.installUpdate`、`showOverlayNotice`、`pickVideoLayerFile`；`FoliaAppleMusic.*`、`FoliaYtm.signIn`、`FoliaSpotify.signIn`、`FoliaQishui.signIn` | Android 权限/Activity 或 Electron companion 专属，鸿蒙无对应物；前端会收到结构化 `unsupported` 错误并按「能力不可用」降级 |
| ⏳ unimplemented | 其余约 70 个方法（播放服务、YTM 会话落盘、壁纸、歌词条等） | 桥会回 `unimplemented`；调用方已有的 catch 会让界面保持可用，但对应功能不生效 |

**结论：当前壳能保证界面正常显示、基本导航、Toast/退出/后台；在线音乐、原生播放与平台登录需要后续逐项移植。**

## 四、构建步骤（需 DevEco Studio）

1. 安装 DevEco Studio（5.0+）与 HarmonyOS SDK 5.0.0(12)。
2. 在本机跑 `bash harmony/folia/scripts/sync-web-assets.sh`：构建 `dist` 并拷进 `rawfile/dist`，
   同时把桥脚本作为 `index.html` 的第一个 `<script>` 注入。
3. 用 DevEco 打开 `harmony/folia`，执行 `File > Sync and Refresh Project`。
   - 首次 Sync 会用 `hvigor/hvigor-config.json5` 下载构建插件；若报版本不符，用 DevEco
     新建一个 Empty Ability 工程，复制它的 `hvigor/hvigor-config.json5` 覆盖本文件再 Sync。
   - Sync 会生成真实的 `hvigorw` / `hvigorw.bat` / `hvigor/hvigor-wrapper.js` 与 `local.properties`。
     DevEco 生成的 `hvigorw.real*` 被 `.gitignore` 排除；若要让自托管 runner 的 CI 也能构建，
     把这些真实包装器文件提交进仓库（workflow 会用 `./hvigorw`）。
4. `Build > Build HAP(s)/APP(s)`，产物在 `entry/build/default/outputs/default/`。
   命令行等价：`./hvigorw assembleHap --mode module -p product=default --no-daemon`。
5. 真机（HarmonyOS NEXT）安装验证；签名需在 DevEco 里配置自动签名或手动证书。

> ArkTS 严格模式提示：桥里对 `Record` 一律用索引访问（`o['text']`），`JSON.stringify` 对
> interface 显式 `as Object`，`EntryAbility` 从 `@kit.AbilityKit` 导入 `Want`/`AbilityConstant`。
> 这些已按 NEXT/API 12 的常见写法处理；个别 SDK 版本若仍有签名差异，按 DevEco 报错逐处微调。

## 五、自动发布

`.github/workflows/build-harmony.yml` 提供两种模式：

- **build-with-sdk**：在带 `harmony-sdk` 标签的自托管 runner（已装 DevEco CLI + SDK）上
  自动 sync → hvigorw assembleHap → 上传 HAP 到对应 tag 的 Release。
- **upload-only**：本地 DevEco 构建好 HAP 后，用 `workflow_dispatch` 传 tag 手动上传。

> GitHub 官方 runner 上没有 HarmonyOS SDK（它不公开分发），所以完整构建必须用自托管
> runner 或本地 DevEco；这一点在 workflow 注释里也写明了。

## 六、已知风险与待办清单

1. **ArkTS API 签名**：`FoliaHarmonyBridge.ets` 里的 `registerJavaScriptProxy`、
   `moveTaskToBack`、`promptAction.showToast` 在不同 SDK 版本间有签名差异；本文件未经
   编译，首次编译按 DevEco 报错微调，结构不用动。
2. **桥脚本注入时机**：必须在所有前端脚本之前执行；`sync-web-assets.sh` 已把 `<script>`
   插到 `<head>` 首位。若前端构建改用非标准 HTML，需同步调整。
3. **原生播放**：Android 用 ExoPlayer，鸿蒙需要用 ArkTS 的 AVPlayer/AVSession 重做；
   当前 `FoliaNativePlayer.*` 全部 unimplemented，播放会退化为 WebView 的 `<audio>`。
4. **后台音频**：需接 HarmonyOS 的 AVSession + 后台任务，否则锁屏/切后台后可能暂停。
5. **Apple Music / YTM / Spotify / 汽水**：登录依赖各自的原生 Activity/WebView；
   在鸿蒙上要么移植对应 WebView 壳，要么明确标记平台不可用（当前走后者）。
6. **签名与上架**：需要有效的 HarmonyOS 开发者证书；本工程不含任何签名材料。
