# 更新日志 / CHANGELOG

## v0.7.38 · 2026-11-21

**安卓更新下载修复与 B站登录闭环。** 修好两件真问题：安卓应用内更新点了下载没反应（版本清单里的安装包名字与实际上传的附件对不上，地址 404），以及 B站扫码登录「扫得出码、登不上号」。另把安装包完整性校验、GitHub 镜像多路回退、二维码本地生成、后台节流默认开启一并做掉。

- **安卓应用内更新修复（重点）**：清单里写的安装包名字用的是本地构建文件名（`app-release.apk`），而真正上传的附件叫 `Folia-Android-0.7.37.apk`，地址 404（实测）。清单生成器新增 `--apk-name`（上传时的附件名），不传会打印提醒；发版流程补一道烟雾测试（`release-manifests/烟雾测试.py`）：逐个请求清单里的地址并比对大小，不通过就不算发完。**线上 v0.7.37 的 `update.json` 已紧急替换修正**，正在用 0.7.37 的用户不必等新版本即可更新。
- **安装包完整性校验**：清单带上安装包的 SHA-512（base64 与 hex 两种），Android 下载时同步计算摘要，对不上就删掉文件、不交给系统安装器 —— 挡的是下载损坏与清单被替换。Android 系统安装器仍会检查覆盖安装签名，这层补的是应用侧的防护。
- **B站扫码登录闭环**：
  - *扫码后账号仍匿名*：原生 `httpRequest` 原先是「调用方给了 Cookie 头就完全不用 CookieManager 里的」，而 `bilibiliTransport` 总会显式带上自己拼的 Cookie，于是扫码存下的 SESSDATA 没随 `nav` 请求发出。改为**按 Cookie 名字合并**（同名以调用方为准，不同名都保留）。
  - *登出只清了一半*：原先只清 localStorage，原生那份会话还在，重启又自动登录回去。新增 `clearCookies` 原生桥，登出按 `bilibili.com` 域名清，其它平台不受影响。
  - *二维码破图*：B站扫码地址本身是网页（响应 `text/html`）不是图片，此前直接当 `<img src>` 渲染所以显示破图。改用项目已有的 `qrcode` 依赖本地生成 PNG data URL，不需要第三方二维码服务。
- **更新源多路回退**：GitHub 直连不通时自动改走加速域名（`gh-proxy.com`、`ghfast.top`），设置页同时给出多个下载入口；桌面「下载来源」菜单与 Web/鸿蒙壳的帮助页同步提供。gh-proxy 是本仓库模型下载清单已在用的域名。
- **省电**：后台节流改为**默认开启**（最小化到托盘后不再空跑 60/120fps；显式关过的老用户保持原样）；壁纸在暂停且颜色收敛后停下帧循环（用「重启签名」而非 payload 做判据 —— payload 每次推送都是新对象，直接依赖会因高频推送反复重启）；预取缓存按 8MB 封顶（原只限 200 条，长歌词仍可能占很多）；分析服务空闲释放从 120 秒缩到 90 秒（仍晚于 worker 释放模型的 60 秒，留出缓冲）。
- **类型修复**：修掉 `test/unit/bilibili/bilibiliTransport.test.ts` 的 TS18046（`result.data` 是 `unknown`，补响应泛型）。
- 版本号升到 `0.7.38`，安卓 `versionCode` `7031800`（高于 0.7.37 的 7031700，覆盖安装不会判为降级）。Kotlin 编译通过；620 个相关单测通过；UI / 体积 / 版本门禁通过；发布烟雾测试通过。

## v0.7.37 · 2026-11-21

**B站视频播放版。** 播放页新增常驻「哔哩哔哩」页签，桌面与安卓都可直接搜索并播放 B 站视频。

- **B站页签**：内含推荐、热门、动画、影视、直播、收藏、历史记录七个模块，支持搜索与扫码登录；播放走 DASH 流，取不到流时回退到 iframe 嵌入。
- **双端播放**：桌面直接取流；安卓复用已有的本地回环代理给视频与音频两条流带上 B 站所需的 Referer（WebView 无法自行设置 `<video>` 的 Referer，否则 403），未改动 Kotlin 原生代码。
- **测试清单同步**：新增平台后补齐内置平台枚举相关的测试用例，避免全量单测回归。
- 版本号 `0.7.37`，安卓 `versionCode` `7031700`。

## v0.7.36 · 2026-11-20

**B站视频功能首版。** 首次把 B 站接进播放页，打通搜索、取流与七个内容模块。

- 播放页接入 B 站搜索与推荐模块，桌面端先行。
- 桌面取流走主进程登记的媒体策略（注入 Referer 与桌面 UA），B 站的 Web 端取流要求 Referer 在 bilibili.com 域下且 UA 非空。
- 补齐 B站 provider 的归一化与模块映射单测。

## v0.7.35 · 2026-11-18

**修好手机端「听歌档案启动出错」。** 这版修的是一个真实的启动失败：固定在安卓上弹「模组「听歌档案」启动时出错了」。

- **手机端内置模组无法启动**：Capacitor 打包后入口 JS 在 `/assets/` 下，而随包模组的地址写成了相对路径 `./mods/builtin/...`。动态 import 的相对路径是相对 **JS 模块**解析的，于是变成 `https://localhost/assets/mods/builtin/...`，文件实际却在 `https://localhost/mods/builtin/...` —— 三个随包模组在手机上全都加载失败。桌面端 file:// 必须用相对路径（写死 `/mods/...` 会被解析到盘符根），所以两端不能共用一种写法：现在由构建标记区分，Capacitor 用绝对路径、桌面维持相对路径。
- **模组错误提示带上真实原因**：启动失败的提示后面会附上手抛出的原文（截断 160 字），手机 WebView 没有开发者工具，用户之前只看到「启动出错了」，既没法自行判断也没法反馈有效信息。
- **上游 v0.7.29 部分同步**：同步了两个经单测验证的独立修复 —— 本地歌曲首曲的莫奈背景（`blob:`/`data:` 不再错加 crossOrigin）、YouTube Music 便携版浏览器登录（Windows 上读注册表找默认浏览器）。
- **顺带修掉一个竞态**：全量单测发现 Jam 联播传输在 `await` 之后仍向已关闭的 channel 发送，补上二次检查。
- 版本号 `0.7.35`，安卓 `versionCode` `7031500`。

## v0.7.34 · 2026-11-17

**HarmonyOS 首次真实编译。** 装上华为官方 Command Line Tools 26.0.1（内嵌 SDK），把鸿蒙壳工程从「结构齐备」推进到「真的编出 HAP」。

- **HAP 真实编译**：产出未签名 HAP 并上传 Release（需华为开发者证书才能装真机）。踩过的坑：26.0.1 是 all-in-one 模式，`hvigor-config.json5` 的 `dependencies` 必须为 `{}`、modelVersion 6.0.0（写私有包依赖会让 pnpm 去 npm 拉而 404）；hvigor 拒绝中文路径，工程须复制到纯 ASCII 路径编译；ArkTS 里 `Object` 不能作泛型实参，动态 JSON 用 `Record<string, ESObject>`。
- **原生播放移植**：AVPlayer 原生播放（prepare/play/pause/stop/seek/音量/倍速/循环 + foliaNativePlayer 事件）、AVSession 媒体会话（通知栏/锁屏控制 + foliaPlaybackCommand 事件）、事件通道（FoliaEventBus + JS 侧 callbackId 机制）。AVSession 在 `@kit.AVSessionKit`（导出 `avSession`），不在 `@kit.MediaKit`。
- **桥契约护栏**：桥方法表由 `dev/tools/extract-harmony-plugin-methods.mjs` 从前端 TS 接口自动提取，`npm run check:harmony` 防漂移（已进 ci:local）。`addListener` 必须声明 rtype 'callback'，否则 Capacitor 会丢弃 listener、原生事件永远到不了页面。
- 版本号 `0.7.34`，安卓 `versionCode` `7031400`。

## v0.7.33 · 2026-11-16

**启动卡住修复与新平台构建版。** 由本仓库源码重新编译 Windows EXE 与 Android APK，修复部分 Windows 环境下打开后停在 Folia logo 加载页、永不进入主界面的问题；Linux 构建扩展到 ARM64；HarmonyOS 壳工程补齐到可在 DevEco 中 Sync/构建的结构。

- **Windows 启动卡住（重点）**：根因是 `src/index.tsx` 的顶层副作用（`installConsoleLogCapture` / `installDebugModule` / 帧率限制器 / microRender 调度器等）任一同步抛错，会中断写在文件中段的 `void import('./bootstrap')`，使 React 永不挂载、`#app-splash` 遮罩永久停留（波形动画由纯内联脚本驱动仍在动，看起来像"卡住"而非崩溃）。两道互不依赖的护栏：
  - 治本：`index.tsx` 顶部用 `queueMicrotask(() => { void import('./bootstrap'); })` 排队 bootstrap，微任务在所有同步初始化后执行（顺序不变），JS 语义保证即使中途抛错也已排队、仍会挂载 React。
  - 兜底：`index.html` 内联看门狗（12 秒，晚于 bootstrap 内 8 秒兜底 4 秒），到点遮罩还在就走同一套淡出移除，并打 `data-app-splash-watchdog="1"` 诊断标记、暴露 `window.__foliaSplashWatchdogFired()`。
  - 验证：`test/unit/startup/splashBootGuard.test.ts` 7 例（含确认修复打进 `dist/index.html`），`tsc` 与 `vite build` 通过。
- **Linux 双架构**：`.github/workflows/build-linux.yml` 改为 `build-x64`（ubuntu-24.04）与 `build-arm64`（ubuntu-24.04-arm）两个独立 job，`workflow_dispatch` 可用 `arch` 选 `both`/`x64`/`arm64`；MNN 按 `arch === process.arch` 各架构本机编译，不交叉。此前 v0.7.32 已实测 x64 四种包云端全绿并上传 Release，本版工作流补上 ARM64，实测全绿、四个 arm64 包（tar.gz/deb/aarch64.rpm/AppImage）下载 HTTP 200。
- **HarmonyOS 壳工程补齐**：新增 `hvigor/hvigor-config.json5`、`entry/build-profile.json5`、`entry/obfuscation-rules.txt`、`hvigorw.bat`、`.gitignore`、`local.properties.example`；修正 ArkTS 严格模式写法（`Record` 索引访问、`JSON.stringify as Object`、`EntryAbility` 导入 `Want`/`AbilityConstant`）；新增 `test/unit/harmony/harmonyBridgeContract.test.ts` 11 例钉住桥契约。**仍无 DevEco SDK，未编译出 HAP**，需在 SDK 环境首次构建并按报错微调 API 签名。
- **构建链修复**：云端 Linux 构建修掉两处 CI 坑（ubuntu-24.04 的 `libasound2`→`libasound2t64` 探测、fpm 打 rpm 需构建期临时注入 `homepage`/`repository`）；workflow 从无效的复杂动态 matrix 改为两个显式 job。
- 版本号升到 `0.7.33`，安卓 `versionCode` `7031300`；重新生成 `latest.yml` / `update.json`，更新源继续指向本仓库 Releases。

## v0.7.32 · 2026-11-16

**Apple Music 双端登录与音质设置版。** 由本仓库源码重新编译 Windows EXE 与 Android APK，把 v0.7.31 只在桌面端可用的 Apple Music 扩展到 Android，修好登录入口要点两次的流程，并把音质偏好搬进设置弹窗。

- **登录入口一键直达**：新增 provider 能力 `beginsLoginOnChoose`（类型 / omni / account 契约 / 三处 mock 同步），Apple Music 选中即启动 companion 登录窗口，不再停在「打开浏览器」那一步等第二次点击；YTM 等两步浏览器登录不受影响。开始失败不再被 `void` 吞掉，留下日志。
- **Apple Music Android 原生宿主**：
  - 页面运行时 `src/services/onlineMusic/appleMusic/pageScript.ts` 从桌面 companion 的 `companionRequests.cjs` + 5 个伴生模块忠实移植成单一自包含函数（约 700 行），桌面/安卓共用同一套页面逻辑；`toString()` 重建仍可独立运行有单测钉住。
  - 新增 `appleMusic/android/appleMusicAndroidBridge.ts`：桌面同一套请求校验、not-ready/busy 25 秒重试、前台保持、登出/销毁接线；`appleMusicTransport.ts` 按桌面桥 / 安卓宿主双路由，Linux / 纯网页仍明确不可用。
  - 原生侧新增 `FoliaAppleMusicPlugin.kt`（prepare/request/setForeground/logout/dispose）、`AppleMusicHostActivity.kt`（独立 task 的 WebView，四 Apple 域白名单，onPause 刻意不暂停 WebView 以保后台出声）、`AppleMusicHoldService.kt`（前台保持通知），MainActivity 注册插件、manifest 注册组件，Kotlin 编译与 manifest 合并均通过。
  - Apple Music 相关 5 个测试文件共 25 用例通过（含页面运行时的行为与自包含约束、安卓桥的校验与降级）。
- **音质偏好进设置弹窗并重新编排**：播放控制页新增独立「在线音质」组（过渡 → 在线音质 → 声音与设备 → 播放行为 → 空间音频/Hi-Res 能力 → 分析模型），按当前平台画档位下拉框，两个入口（账户页 / 设置页）共用 `AUDIO_QUALITY_CHOICES` 与 omni 落档；只有真正可选的平台才画下拉框，Apple Music 如实写明「由官方页面按订阅与设备给出」。
- **安卓 YouTube Music 最高档**：安卓桥把 Premium 的 ultra（约 256 kbit/s）传给 `pickAudioFormat`，没有 ultra 格式时仍按 high 给。
- **工程修复**：本机 TypeScript 6.0.2 在默认堆下会 OOM 并在临界时给出不稳定的诊断，统一以 `--max-old-space-size=8192` 跑 `tsc`；修掉 14 个先前被掩盖的测试文件类型错误（`byte` 隐式 any、`Array.from` 推断等），不改门禁规则。
- **验证**：`tsc --noEmit` 0 错误；UI / 体积 / 版本 / 源码密钥 / 同步服务类型 / 契约清单全部通过；界面预览 PNG 真看 + `layoutCheck` 0 findings。

## v0.7.31 · 2026-11-15

**Apple Music 与功能补齐版。** 由本仓库源码重新编译 Windows EXE 与 Android APK，新增 Apple Music 平台，并把此前「声明了但没实装 / 写好了没接线」的功能补上。

- **Apple Music（重点）**：
  - 从上游 `chthollyphile/folia-major` v0.7.26~0.7.28 移植 `src/services/onlineMusic/appleMusic/` 6 个 provider 文件、外部播放引擎（`externalPlayback.ts` / `externalQueue.ts` / `externalClock.ts` / `mediaShim.ts`）与 `electron/appleMusic/` 25 个 companion 源码文件。
  - **定点补契约，不整体替换**：在 `src/types/onlineMusic.ts` 只插入 5 组可选字段与 3 个接口（`ProviderExternalPlaybackStatus` / `OnlineExternalPlaybackProvider` / `ProviderLyricSearchAlias`），保留 fork 独有的 `passwordLogin` / `nativeGateway` / `canSignIn`。这正是 v0.7.28 文件级同步造成 1092 条类型错误的地方，本版未重演（搬入后 61 个错误全部定点消除，`tsc --noEmit` 0 错误）。
  - 新增 `src/services/onlineMusic/omni/externalPlaybackMethods.ts`（12 个方法）拼进 fork 的分模块 `omni.ts`；`usePlaybackStore` 补 `playbackRoute` / `setPlaybackRoute`；`providerRegistry.ts` 注册 provider 并补 `canPlaySongExternally`。
  - 桌面接线：`preload.cjs` / `vite-env.d.ts` / `main.cjs`（懒加载 companion，宿主缺失时安全回 `runtime-unavailable`）/ 三语文案 / `docs/contracts/manifest/` 三份清单。
  - **Windows WebView2 原生宿主在本机编译成功**（.NET Framework 4.8 + WebView2 SDK 1.0.4314.35，0 警告 0 错误），接进 `build/beforePack.cjs`（每次打包现编）、`build/afterPack.cjs`（强制校验 5 个宿主文件）与 `package.json` 的 `extraResources`。
  - 搬入上游 3 个单元测 + 新增 `appleMusicForkWiring.test.ts` 验证 fork 适配层；`authMembers.test.ts` 补登录成员行；补 `nextPlayableQueueIndex` 队列辅助函数。
  - **限制**：音频受 DRM 保护，只能由 Apple 官方页面出声，需订阅账号实机验收；Android / Linux 不提供该平台；依赖 Apple 未公开的网页接口，页面变化可能导致失效。另外 fork 目前仍让 Media Session / 听歌上报等观察者直接读原生 `<audio>`，尚未切到 `hifiMediaShim.getObservedMedia`，因此**外部播放器发声时这些观察者拿不到它的进度**；这份 shim 已注册但不被读取，接上属于后续独立改动。
- **功能补齐**：
  - Cappella **AI 语义词着色**：解开被注释的实现，改用项目公共的 `resolveWordColor`（不复活手写 `.find`），新增 `cappellaWordColors.ts` 做气泡底色与词色的对比度兜底（当初正因为可读性差才禁用），新增 9 个单测。
  - **跨源队列另存为本地歌单**：解除 `Mixed-source queues cannot be saved as playlists yet` 拦截，给 `LocalPlaylist` 增加外部条目引用并保序，读取侧同步支持。
  - 歌词过滤 / 职员规则的两个校验错误从 store 接到设置页入口行提示。
  - 存储页补「恢复默认目录」按钮（IPC 与类型声明原本齐备，只缺入口）。
- **清理与更正**：
  - 三语各删 506 行死文案（旧 7 页用户指南 37 键、19 个历史发行说明块），保留仍在用的 `releaseNotes.v0_7_22`；`dev/i18n/traditionalTerms.mjs` 移除随之失效的 1 条繁中转换规则；删除 14 个空目录。
  - **更正上一版的盘点结论**：安卓原生 `EqAudioProcessor.kt` 早已实装饱和 / 黑胶 / 声场宽度 / 混响 / 压缩（由另一套设置页驱动，Web 端 `AUDIO_CONSOLE_EFFECT_IDS` 有意只留 2 个滑杆）；桌宠浮层漫游也已由主进程 `whalePetWindow.cjs` 的 `startRoam()` 驱动窗口实现。两者不是缺失功能，本版只纠正过时注释，不重复造循环。
  - 汽水 / 波点的「专辑详情、创建歌单、收藏写入」仍需第三方私有接口，未实装，README 里的关闭说明保留。
- **复验**：`tsc --noEmit` 0 错误；`check:ui` / `check:size` / `check:versions`（0.7.31 → 7031100）/ `checkSecrets` / 契约清单 全部通过；Apple Music 相关 29 个单测通过；界面预览 PNG 与 `layoutCheck`（dev-probe 首页 0 findings）。
- 版本号升到 `0.7.31`，安卓 `versionCode` `7031100`；重新生成 `latest.yml` / `update.json`，更新源继续指向本仓库 Releases。

> Apple Music 的原生宿主、公证与版权合规说明见 `electron/appleMusic/README.md`；构建与发布步骤见 `release-manifests/构建与发布.md`。

## v0.7.30 · 2026-11-15

**稳定修复版。** 回到可完整类型检查与单元测试的健康代码基线，由本仓库源码重新编译 Windows EXE 与 Android APK。

- **撤销 v0.7.28 的文件级上游同步**：该合并把「上游 v0.7.28 新版引用方」与「folia-sonnet fork 旧版契约定义」混进同一棵源码树，造成 `tsc --noEmit` 1092 条错误、`test:unit` 476 个用例失败。实测把 707 个差异文件全部换成上游版仍剩 865 条错误，而两个未混血基线（纯上游 v0.7.28、本仓库初始提交 `1466b37`）本身几乎零错误 —— 因此回到 `1466b37` 健康基线：删除 520 个同步新增文件、恢复 372 个被改动文件。
- **自研内容与清理结果全部保留**：色散玻璃导航条、microRender GPU 调度微内核、HiRes 音质、导出补帧、鲸鱼桌宠、三语文案，以及指向 `SuYunYue-550W/foliaData` Releases 的更新源与原项目社区群清理。
- **修复全部已知问题**：`package.json` 的 `build.publish` 非法 JSON（补 `owner`）、`package-lock.json` 版本同步、Docker 部署的 qq-music-api 版本对齐（3.3.6 → 3.3.3）、印尼语缺失的 8 个词条、UI 门禁基线登记、正式版允许显式 `androidVersionCode` 的策略、删除无人引用的 `node-forge.mjs` vendor 残留。
- **复验**：`tsc --noEmit` **0 错误**；`check:ui` / `check:size` / `check:versions` / `checkSecrets` / `build:vercel-api` 全部通过；`test:unit` 与 `vite build` 结果见下方实测记录。
- 版本号升到 `0.7.30`，安卓 `versionCode` `7030100`（高于 v0.7.29 的 `7029100`，覆盖安装不会判为降级）；重新生成 `latest.yml` / `update.json`，桌面与安卓「检查更新」继续指向本仓库 Releases。

> 上游 v0.7.26–v0.7.28 的功能清单仍保留在 `上游同步说明-v0.7.28.md`；后续若再同步上游，需做完整三方合并，不能文件级覆盖。
> 本机复现步骤与环境记录见 `release-manifests/构建与发布.md`。

## v0.7.29 · 2026-11-15

**自编译完整版。** 首次由本仓库源码在本机真实编译出 Windows EXE 与 Android APK，
包含自研的色散玻璃导航条与 microRender GPU 调度微内核；v0.7.28「二进制来自上游官方构建」的限制至此解除。

- 版本号升到 `0.7.29`；安卓 `versionCode` 设为 `7029100`（高于上一版的 `7025011`，避免覆盖安装被判为降级）。
- **修复 v0.7.28 文件级增量同步造成的构建链断裂**：
  - 补齐 44 个被合并误删、但上游新增文件仍依赖的模块（hifi 引擎全套、bravais 倾斜模块、`textMeasureCache.ts` 等）；
  - 对齐 5 处「引用方已是上游新版、提供方仍是 fork 旧版」的接口错配；
  - 对 `bravaisConstants.ts`、`partitaLayout.ts`、`homeCards.ts` 做**并集合并**，同时保留上游新导出与 fork 仍被引用的旧常量/函数；
  - 上述改动只补缺失文件、不覆盖 `liquidGlass`、`microRender` 等自研路径。
- 本机补齐构建条件：Electron 43 Windows 运行时、Android SDK Platform 36 / Build-Tools 36 / platform-tools、
  Gradle 8.14.3、ffmpeg 8.1.2-folia.5 与两个分析模型（SHA-256 均与项目清单一致）。
- 渲染层 `vite build` 通过（0 个模块解析 / 导出错误），随后产出新版 EXE 与 APK；
  重新生成 `latest.yml` / `update.json`，桌面端与安卓端「检查更新」指向本仓库新版本。

> 本机复现步骤与环境记录见 `release-manifests/构建与发布.md`；上一版的完整上游对比见 `上游同步说明-v0.7.28.md`。

## v0.7.28 · 2026-11-15

**上游同步版。** 完整清单见 [`上游同步说明-v0.7.28.md`](上游同步说明-v0.7.28.md)。

- 同步 `chthollyphile/folia-major` **v0.7.26 / v0.7.27 / v0.7.28** 三个正式版本的更新内容：速记簿、Apple Music 与飞牛音乐、新搜索页、跨平台队列、进度条胶囊、Spotify Soloist、场景「影厅」Beta、新应用图标、窗口按钮位置、字幕与可视化参数、封面清晰度，以及单曲循环 / iOS Safari 后台播放 / 酷狗公开歌单等修复。
- 同步 `whycfawa/folia-android` 至 **v0.7.28-android.453**：Apple Music / 飞牛登录、安装包体积优化（39.8 MB → 20.0 MB）、移动端渲染优化与 QQ / 酷狗 / 网易云登录收藏修复。
- 以 v0.7.25 为基线做三方对比，**同步 844 个文件**（364 更新 + 477 新增 + 3 删除）；402 个双方都改过的冲突文件保留本仓库版本，自研改动与上一轮清理全部保留。详见说明文档第三节。
- 修复 `package.json` 的 `build.publish` 缺少 `owner` 键导致整份 JSON 非法、无法 `npm ci` 与构建的问题。
- 版本号升级到 `0.7.28`；补齐 `latest.yml` 与 `update.json` 更新清单，**应用内「检查更新」正式可用**。
- 交付 `Folia-Setup-0.7.28.exe` 与 `Folia-Android-0.7.28-android.453.apk`（上游官方构建，见说明文档第五节的限制）。

> 注意：本版二进制为上游官方构建，不含本仓库的色散玻璃导航条与 microRender 调度微内核；源码为文件级增量同步，尚未完成完整合并与编译验证。

## v0.7.25 · 2026-11-15

首次上传：Folia 整合增强版（基于 Folia-major 0.7.25）。

- 自研色散玻璃导航条（参考 Mineradio 视觉思路独立重写，未复制其 GPL 源码）与 microRender GPU 调度微内核，另有 HiRes 音质、导出补帧、官方补丁同步、鲸鱼桌宠版与三端构建交付。
- 软件更新源统一改指向本仓库 Releases；移除旧发布仓库来源指向与原项目社区群信息（群号、入口、三语文案、UI 测试）。
- 新增 `声明文件-FoliaData.md`、`microRender-算法说明.md` 与零依赖内核 `microRender-engine-standalone.ts`。
- 该版 Release 未附带更新清单，应用内「检查更新」会提示清单缺失。
