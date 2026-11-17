# Folia 鸿蒙（HarmonyOS NEXT）移植工程

> ✅ **状态：已用真实 HarmonyOS SDK 编译成功（2026-11-17）。** 用华为官方 Command Line
> Tools 26.0.1（内嵌 SDK，无需 DevEco Studio IDE）在本机实测 `hvigorw assembleHap` 全绿，
> 产出合法 HAP（`entry-default-unsigned.hap`，约 74MB，2065 个条目，含 `module.json`
> 与打进 rawfile 的前端产物，ZIP 校验通过）。
>
> ⚠️ 产物是**未签名** HAP：真机安装需要华为开发者证书（`.p12`/`.cer`/`.p7b`）签名，
> 这必须从华为开发者账号申请，仓库不含任何签名材料。
>
> HarmonyOS NEXT 不兼容 Android APK，现成的 `Folia-Android-0.7.33.apk` 只能在
> HarmonyOS 4 及以下安装。

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
| `entry/src/main/ets/bridge/FoliaEventBus.ets` | 事件通道：原生 → JS 的单向推送（callbackId 分发） |
| `entry/src/main/ets/bridge/FoliaPlayer.ets` | 原生播放内核：`media.AVPlayer` 封装（准备/播放/暂停/定位/音量/倍速/循环） |
| `entry/src/main/ets/bridge/FoliaNativePlayerHandlers.ets` | `FoliaNativePlayer.*` 方法实现 + `foliaNativePlayer` 事件 |
| `entry/src/main/ets/bridge/FoliaPlaybackHandlers.ets` | `FoliaPlayback.*`：AVSession 媒体会话（通知栏/锁屏）+ 播放状态镜像 |
| `entry/src/main/ets/bridge/FoliaBridgeOptions.ets` | 桥入参取值辅助（ArkTS 严格模式下的动态 JSON 读取） |
| `entry/src/main/ets/bridge/FoliaHttpHandlers.ets` | 原生 HTTP 转发（`FoliaNative.httpRequest`）+ ArkWeb cookie 罐读写 |
| `entry/src/main/ets/entryability/EntryAbility.ets` | 应用入口，全屏窗口 |
| `entry/src/main/resources/rawfile/capacitor-harmony-bridge.js` | Capacitor 自定义平台桥（注入到 HTML） |
| `scripts/sync-web-assets.sh` | 构建前端 → 拷进 rawfile → 在 index.html 注入桥脚本 |
| `scripts/build-with-cli.sh` | 用 Command Line Tools 的 hvigorw 命令行编译 |
| `scripts/build-ascii.ps1` | 把工程同步到纯 ASCII 路径后编译（hvigor 拒绝中文路径） |
| `scripts/align-sdk-version.py` | 从 SDK 里读真实 hvigor 版本并对齐工程配置 |
| `hvigor/hvigor-config.json5` | Hvigor 配置（**all-in-one 模式：`dependencies` 必须为空对象**） |
| `entry/build-profile.json5` | 模块级构建配置 + Release 混淆规则引用 |
| `entry/obfuscation-rules.txt` | 保留桥方法名不被混淆（JS 侧按字符串调用） |
| `hvigorw` / `hvigorw.bat` | 包装器转发占位，首次 Sync 后由 DevEco 替换为真实实现 |
| `.gitignore` / `local.properties.example` | 忽略本地构建产物 / SDK 路径模板 |

## 三、能力状态（诚实清单）

| 分级 | 方法 | 说明 |
|---|---|---|
| ✅ 已实现 | `FoliaNative.showToast / exitApp / setScreenAwake` | HarmonyOS 标准 API 可直接覆盖 |
| ✅ 已实现（原生播放） | `FoliaNativePlayer.prepare / play / pause / stop / seek / setVolume / setSpeed / setRepeatMode / getSnapshot / release` | 基于 `media.AVPlayer`，带 `foliaNativePlayer` 事件（ready/playing/paused/ended/position/seeked/buffering/error/idle） |
| ✅ 已实现（原生 HTTP） | `FoliaNative.httpRequest`、`cookiesSet`、`cookiesRemove` | WebView 里的页面有来源（`https://localhost`），跨域请求照样被同源策略拦；原生这一条是鸿蒙上绕过 CORS 的唯一通路。**前端无需改动**：`nativeHttpFetch.ts` 的判定「不是 native 平台 **且** 不是 android」在鸿蒙上成立，且 `isPluginAvailable('FoliaNative')` 查的是本桥上报的 pluginHeaders |
| ✅ 已实现（媒体会话） | `FoliaPlayback.update / setState / stop / getPlaybackSnapshot / setQueueMirror / setQueueMirrorIndex / consumeLikeOverrides` | 基于 `avSession`：通知栏与锁屏可控制播放，元数据与播放状态同步；`foliaPlaybackCommand` 事件把通知栏/耳机按键转给前端 |
| ⛔ unsupported | `FoliaNative.moveToBackground`（鸿蒙无 `moveTaskToBack`）、`installUpdate`、`showOverlayNotice`、`pickVideoLayerFile`；`FoliaNativePlayer.setEqualizer / getEqualizerState / setSpectrumEnabled / getSpectrum`（鸿蒙 AVPlayer 无 FFT 与等效 EQ 链）；`FoliaAppleMusic.*`、`FoliaYtm.signIn`、`FoliaSpotify.signIn`、`FoliaQishui.signIn` | Android 权限/Activity、Electron companion 专属，或 SDK 无对应 API；前端会收到结构化 `unsupported` 错误并按「能力不可用」降级，**不会拿到假数据** |
| ⚠️ 降级回退 Web | `FoliaPlayback.playFromQueue`（回 `ok:false`）、`FoliaPlayback.requestSkip`（回 `skipped:false`） | Android 侧原生有「平台网关」按需解析歌曲地址，鸿蒙侧没有这套地址解析。按前端契约回 false，调用方会回退 Web 全流程 —— 功能不坏，切歌走 Web 路径 |
| ⏳ unimplemented | 其余约 70 个方法（壁纸悬浮窗、歌词条、在线音乐登录与 HTTP 代理等） | 桥会回 `unimplemented`；调用方已有的 catch 会让界面保持可用，但对应功能不生效 |

**结论：壳能保证界面正常显示、基本导航、Toast/退出；原生播放与通知栏/锁屏控制已可用；在线音乐的平台登录与壁纸悬浮窗需要后续逐项移植。**

> 桥的方法表不是手写的：`Folia-源码-完整版/dev/tools/extract-harmony-plugin-methods.mjs` 直接从前端各插件的 TS 接口提取，方法名与前端契约同源；`npm run check:harmony` 会在桥表漂移时失败（已接进 `ci:local`）。

## 四、构建步骤

### 4.1 命令行构建（本机实测通过，无需 DevEco Studio）

1. 从华为开发者下载中心获取 **Command Line Tools**（`command-line-tools-for-hmos`，
   Windows 包约 3.1GB，**已内嵌 HarmonyOS SDK**，需登录华为账号），解压到空间充足的盘
   （例 `D:\folia-harmony-sdk\command-line-tools`）。
   - 版本无关配置：Command Line Tools 26.0.1 起是 all-in-one 模式，`hvigor/hvigor-config.json5`
     的 `dependencies` 必须是 `{}`，`modelVersion: "6.0.0"`；写 `@ohos/hvigor-ohos-plugin`
     会让 hvigor 去 npm 拉私有包而失败（错误码 00308003）。
   - `build-profile.json5` 需 `arkTSVersion: "1.1"`，且不能有 `signingConfigs`（用 `signingConfig`）。
2. **工程路径必须纯 ASCII**（hvigor 错误码 00306003）——本仓库在中文路径下，需先复制到
   `D:\folia-harmony-build` 之类路径（脚本 `scripts/build-ascii.ps1` 做这件事）。
3. 同步前端资源：`bash harmony/folia/scripts/sync-web-assets.sh`（会重新 vite build 并注入桥）。
4. 编译：设置 `NODE_HOME`（node 目录）、`DEVECO_SDK_HOME=<tools>/sdk`、
   `JAVA_HOME=<tools>/tool/jre`（SDK 自带 JRE 21），在 ASCII 工程目录执行
   `hvigorw assembleHap --mode module -p product=default --no-daemon`。
   - 本机还需在构建子进程内移除 WorkBuddy 沙箱的 `NODE_OPTIONS` 删除 shim 注入
     （否则 ohpm 清理临时文件时 `genie-trash` 超时），见 `scripts/build-with-cli.sh`。
5. 产物：`entry/build/default/outputs/default/entry-default-unsigned.hap`（未签名）。
6. 签名：在 DevEco 里配置证书自动签名，或用华为开发者证书手动签名后才能装真机。

### 4.2 DevEco Studio 图形界面（备选）

1. 安装 DevEco Studio（5.0+）与 HarmonyOS SDK。
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
