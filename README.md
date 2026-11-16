# Folia 整合增强版 · foliaData

全屏沉浸式歌词播放器 **Folia** 的整合增强版。基于 Folia-major 0.7.25，叠加色散玻璃导航条与自研 **microRender** GPU 调度微内核，提供 Windows 与 Android 双端构建。

> **当前版本：`v0.7.32`（Apple Music 双端登录与音质设置版，2026-11-16）。**
> 本版由**本仓库源码在本机真实编译**，把 Apple Music 从桌面端扩展到 Android（原生 WebView 宿主），修好登录入口要点两次的问题，并把音质偏好搬进设置弹窗重新编排；桌面与安卓的「检查更新」均指向本仓库 Releases。v0.7.28 的文件级上游同步因造成源码契约错配已撤销，本版 Apple Music 采用定点契约适配而非文件级覆盖，详见 `CHANGELOG.md`。
> v0.7.28 的上游同步清单见 [`上游同步说明-v0.7.28.md`](上游同步说明-v0.7.28.md)，版本记录见 [`CHANGELOG.md`](CHANGELOG.md)，出包与发布步骤见 [`release-manifests/构建与发布.md`](release-manifests/构建与发布.md)。

> 本仓库由维护者独立整理上传。上传前已移除原发布渠道的更新地址、旧仓库来源指向与原项目社区群信息；**软件更新源现统一指向本仓库的 Releases**。
> 完整的交付声明见 [`声明文件-FoliaData.md`](声明文件-FoliaData.md)，微引擎算法见 [`microRender-算法说明.md`](microRender-算法说明.md)。

---

## 一、项目身份

| 项 | 内容 |
|---|---|
| 基础项目 | Folia（`folia-major`）v0.7.25 的 `folia-sonnet` fork；v0.7.30 起回到健康基线 |
| 当前版本 | `0.7.32`（`package.json` 的 `version` / `displayVersion`；安卓 `versionCode` `7031200`） |
| 定位 | Lyrics Reimagine —— 桌面 + 移动端的在线音乐播放与全屏歌词可视化 |
| 技术栈 | React 19 + TypeScript 6 + Vite 8；three / React Three Fiber / pixi.js / framer-motion / animejs；桌面 Electron 43，移动 Capacitor 8 |
| 规模 | 28 个可视化模式 + 6 种背景模式；`src/` 下约 2790 个 TS/TSX 文件 |
| 授权 | **AGPL-3.0**（见 `LICENSE`），`private: true` |
| 在线音源 | 网易云、QQ 音乐、酷狗、汽水音乐、波点、飞牛音乐、Spotify、YouTube Music、**Apple Music（桌面 + Android，需订阅账号）**、Navidrome、本地音乐库 |
| 交付形态 | Windows 安装包（EXE）、Android 安装包（APK）、完整源码 |

---

## 二、v0.7.28 同步了什么（历史记录）

> **状态更新（v0.7.30）**：这次文件级增量同步已撤销。它把「上游 v0.7.28 新版引用方」与「fork 旧版契约定义」混进同一棵源码树，造成 `tsc --noEmit` 1092 条错误、单测 476 个用例失败；实测把 707 个差异文件全部换成上游版也只能降到 865 条，而两个未混血基线本身几乎零错误。故回到初始健康基线，以下清单保留为历史记录；后续再同步上游需做完整三方合并，不能文件级覆盖。

| 来源 | 版本 | 主要内容 |
|---|---|---|
| `chthollyphile/folia-major` | v0.7.26 | 速记簿、Apple Music / 飞牛音乐、新搜索页、跨平台队列、进度条胶囊、雾笺窗外与玻璃、推荐与歌词增强 |
| 同上 | v0.7.27 | Spotify Soloist 备用播放、Apple Music 改进、飞牛外网登录、酷狗公开歌单账号失效修复 |
| 同上 | v0.7.28 | 场景「影厅」Beta、新应用图标、窗口按钮位置、字幕回退开关、封面清晰度、单曲循环与 iOS Safari 后台播放修复、Folium 1.9 |
| `whycfawa/folia-android` | 至 v0.7.28-android.453 | Apple Music / 飞牛登录、安装包体积 39.8 MB → 20.0 MB、移动端渲染优化、QQ 与酷狗/网易云登录收藏修复 |

以 v0.7.25 tarball 为基线做逐文件 SHA-256 三方对比，**同步 844 个文件**（364 更新 + 477 新增 + 3 删除）。本仓库源码实际来自另一条 fork（`folia-sonnet`），有 **402 个文件双方都改过**；为不抹掉自研改动与上一轮清理，这些冲突文件保留本仓库版本，未强行合并。自研的色散玻璃、microRender、HiRes 音质、导出补帧等全部保留。

顺带修复了 `package.json` 的 `build.publish` 缺少 `owner` 键导致整份 JSON 非法、`npm ci` 与构建全部失败的问题。

> **历史限制已解除**：v0.7.28 的安装包是上游官方构建（不含自研改动、内置上游更新地址），且源码为文件级增量、未经编译验证。
> **v0.7.29 已修复该状态**：补齐三方合并缺失的 44 个模块、对齐接口错配、对三处文件做并集合并，`vite build` 通过，并在本机补齐 Electron 运行时、Android SDK 36、Gradle 8.14.3、JDK 21 与打包资源，重新编译出 EXE / APK。逐项见 `CHANGELOG.md` 与 `release-manifests/构建与发布.md`。

---

## 三、上传前的清理（v0.7.25）

| 项目 | 处理结果 |
|---|---|
| 桌面端更新源（`build.publish`、`electron-updater`、`FOLIA_RELEASES_URL`、发布频道 URL） | **改指向本仓库** Releases |
| 安卓端更新清单（原自建 CDN `update.json`） | **改指向本仓库** `Releases/latest/download/update.json` |
| 帮助页项目地址、AI 帮助提示、登录诊断报告、AUR 包、CI 脚本、构建标识 | 统一改指向本仓库 |
| 保留：`LICENSE`、`CONTRIBUTORS.md`、第三方版权声明、各 `package-lock.json` 内的依赖地址与赞助链接 | 保留 —— AGPL 署名要求与 `npm ci` 完整性所必需，不属于来源指向 |

> 历史交付文档中的仓库指向已统一替换，具体技术内容待维护者后续自行更新。

---

## 四、相对原项目的全部改动（声明）

### 1. 色散玻璃导航条（视觉增强）
- 新建 `src/components/liquidGlass/`：`dispersionModel.ts`、`LiquidGlass.tsx`、`LiquidGlassNavBar.tsx`、`useLiquidGlassFilter.tsx`、两份 CSS 与导出。
- 演进：独立组件 → 接入真实导航位（底栏胶囊 + 顶栏）→ **毛玻璃 ⇄ 液体玻璃互斥切换**（设置页 `Segmented`）→ 同一机制套用到顶部标题栏。
- 状态：`playerBarGlass: 'frosted' | 'liquid'`（`usePlayerChromeSettingsStore`，键 `player_bar_glass`，默认 `frosted`），三语文案齐备。
- **合规说明**：视觉思路参考已停更的 Mineradio 2.2.0 的 `control-glass` 效果（`feDisplacementMap` + RGB 三通道偏移 + `backdrop-filter`）。因 AGPL-3.0 与 GPL-3.0-only 条款不相容，**未复制其任何源码文件**，全部用本项目 React 技术栈独立重写，参数模型、渐变构造、通道链、降级策略均为自研，源码头注释保留致谢。

### 2. microRender GPU 调度微引擎（性能自适应，自研）
- 新增 `src/utils/microRender/` 四件套 + `useMicroRenderStore` + `GraphicsPage` 设置项 + 三语文案。
- 把「诊断与调度断开、档位互不感知、多 document 抢 GPU」三个真空补成闭环；上下文丢失在捕获阶段只读不拦截，与各引擎自身的恢复流程不冲突。
- 决策内核零依赖独立抽取为 `microRender-engine-standalone.ts`（含 5 条自检，实跑全过）。
- 详见 [`microRender-算法说明.md`](microRender-算法说明.md)。

### 3. 播放器 / 音质增强
最高音质档位补齐、杜比音效、HiRes 输出采样率展示；酷狗 `viper_tape / viper_atmos` 桌面取流、QQ 档位链纯数据化、Spotify `audio/flac` 分支。

### 4. 导出补帧层
导出时叠加补帧层，改进导出视频的视觉连贯性；与 microRender 的降帧方向相反，补帧运行时冻结调度决策。

### 5. 官方原项目补丁同步
将上游官方补丁同步进本仓库。

### 6. 鲸鱼桌宠版（形态拓展）
派生「鲸鱼桌宠版」「系统置顶桌面版」，含开屏 / 切歌的鲸鱼过渡手感打磨。

### 7. 多端构建与交付
三端交付物构建（Windows EXE / Android APK / 源码包），文件名带 `YYYYMMDD-HHMM` 时间戳，配套下载页与 MD5 清单。

> 各项改动的一手记录见仓库内的《色散玻璃导航条-接入说明》《渲染管线GPU调度优化》《最高音质与杜比音效-交付说明》《导出补帧层改动说明》《官方原项目补丁同步说明》《改动说明》《项目整体复查报告》等中文文档。

---

## 五、microRender 微渲染引擎（算法单独说明）

它是一个**统一帧预算的调度微内核**：只在帧节拍层做调度，**不碰任何 shader / pass**，因此与 28 个可视化模式完全解耦。

| 层 | 文件 |
|---|---|
| 决策内核（纯函数） | `src/utils/microRender/gpuBudget.ts` |
| 采样 / 跨窗口协调 / 落闸 | `src/utils/microRender/microRenderScheduler.ts` |
| GPU 消费者注册表 | `src/utils/microRender/renderClientRegistry.ts` |
| 开关与端口 | `src/stores/useMicroRenderStore.ts` |
| 零依赖独立内核 | `microRender-engine-standalone.ts` |
| **完整算法说明** | `microRender-算法说明.md` |

算法要点：用户档位永远是天花板；降档先帧率后分辨率、升档逆序；连续 2 个坏窗口才降、连续 6 个好窗口才升；每次变更留 2.5s / 8s 冷却；上下文丢失 8s 内只降不升；多 document 并存时非主层先让一档预算。

> 色散玻璃（视觉）与 microRender（调度）是**正交的两件事**，互不影响。

---

## 六、构建与运行

要求 **Node ≥ 24**（见 `.nvmrc`）。

```bash
npm ci                        # 安装依赖
npm run dev                   # Web 开发服务器
npm run dev:electron          # 桌面端开发
npm run typecheck             # 类型检查
npm run test:unit             # Vitest 单元测试
npm run ci:local              # 与 CI 一致的本地门禁（开 PR 前）
npm run build:electron        # Windows 安装包
npm run build:android:debug   # Android debug APK
```

开发规范见 `AGENTS.md` 与 `skills/`（12 个项目 skill）。要点：在线歌曲只走 `src/services/onlineMusic/omni.ts`；禁止手写原生 `<button>/<input>/<select>/<textarea>`；界面文案走三语 i18n；单文件不超过 800 行；改界面必须实看渲染截图。

完整的环境要求、出包与发布步骤见 [`release-manifests/构建与发布.md`](release-manifests/构建与发布.md)。

### 新增平台的构建入口（v0.7.32 配套）

| 平台 | 入口 | 说明 |
|---|---|---|
| Linux（tar.gz / deb / rpm / AppImage） | `bash scripts/build-linux.sh` | **必须在 Linux 本机跑**（MNN 运行时拒绝交叉编译）；或 push `v*` 标签触发 `.github/workflows/build-linux.yml`，由 GitHub runner 构建并自动上传 Release |
| HarmonyOS NEXT | 见 [`harmony/README.md`](harmony/README.md) | ArkWeb 壳工程 + Capacitor 自定义平台桥（前端零改动）；需 DevEco Studio + SDK 编译 HAP，`.github/workflows/build-harmony.yml` 配好自托管 runner 自动发布。**当前为未编译验证的源码骨架**，详见该文档的诚实能力清单 |

---

## 七、软件更新机制（现指向本仓库，v0.7.32 继续生效）

| 端 | 机制 | 地址 |
|---|---|---|
| 桌面 | `electron-updater` 读取 Release 的 `latest.yml`（`beta.yml` / `alpha.yml` 为未启用的滚动通道） | 本仓库 Releases |
| Android | 拉取静态版本清单 → 比版本号 → 原生下载 → 系统安装器 | `Releases/latest/download/update.json` |
| 兜底 | 打开发布页 | 本仓库 Releases 页面 |

`update.json` 格式（`version` 与 `download_url` 为必需，其余可选）：

```json
{
  "version": "0.7.32",
  "download_url": "https://github.com/SuYunYue-550W/foliaData/releases/download/v0.7.32/Folia-Android-0.7.32.apk",
  "page_url": "https://github.com/SuYunYue-550W/foliaData/releases/tag/v0.7.32",
  "notes": "更新说明",
  "published_at": "2026-11-15T05:50:37.167Z",
  "size": 124079060
}
```

桌面端 `latest.yml` 的 `sha512` 用 **base64**、`size` 用字节，必须与附件实测一致。
清单模板与自动生成脚本见 `release-manifests/`。**发布新版本时把 `latest.yml` 与 `update.json` 一起作为最新 Release 的附件上传即可**，无需自建后端。

---

## 八、交付物（Release 附件）

### v0.7.32（当前版本 · Apple Music 双端登录与音质设置版）

| 文件 | 体积 | 说明 |
|---|---:|---|
| `Folia-Setup-0.7.32.exe` | 见 Release 附件 | 本仓库源码编译的 Windows NSIS 安装包，内含 Apple Music WebView2 原生宿主，未做代码签名 |
| `Folia-Android-0.7.32.apk` | 见 Release 附件 | 本仓库源码编译的 Android release 包，`Folia Whale Pet` 证书签名，`versionCode` 7031200，含 Apple Music 原生 WebView 宿主 |
| `latest.yml` | — | 桌面端更新清单（含 SHA-512） |
| `update.json` | — | 安卓端更新清单 |

两个包均内含本仓库的更新地址；自研的色散玻璃导航条与 microRender 微内核都在包内。
**Apple Music 在桌面与 Android 均可用**：音频由 Apple 官方页面出声，需要订阅账号；Linux / 纯网页不提供。网页侧最高 AAC，不支持 Lossless / Hi-Res / 对象式 Dolby，请用官方客户端。

### v0.7.31（历史版本 · Apple Music 与功能补齐版）

| 文件 | 体积 | 说明 |
|---|---:|---|
| `Folia-Setup-0.7.31.exe` | 见 Release 附件 | 本仓库源码编译的 Windows NSIS 安装包，内含 Apple Music WebView2 原生宿主，未做代码签名 |
| `Folia-Android-0.7.31.apk` | 见 Release 附件 | 本仓库源码编译的 Android release 包，`Folia Whale Pet` 证书签名，`versionCode` 7031100 |
| `latest.yml` | — | 桌面端更新清单（含 SHA-512） |
| `update.json` | — | 安卓端更新清单 |

### v0.7.30（历史版本 · 稳定修复版）

| 文件 | 体积 | 说明 |
|---|---:|---|
| `Folia-Setup-0.7.30.exe` | 见 Release 附件 | 本仓库源码编译的 Windows NSIS 安装包，未做代码签名 |
| `Folia-Android-0.7.30.apk` | 见 Release 附件 | 本仓库源码编译的 Android release 包，`Folia Whale Pet` 证书签名，`versionCode` 7030100 |
| `latest.yml` | — | 桌面端更新清单（含 SHA-512） |
| `update.json` | — | 安卓端更新清单 |

两个包均内含本仓库的更新地址；自研的色散玻璃导航条与 microRender 微内核都在包内。

### v0.7.29（历史版本 · 自编译完整版）

| 文件 | 体积 | 说明 |
|---|---:|---|
| `Folia-Setup-0.7.29.exe` | 303.6 MB（318,390,970 B） | 本仓库源码编译的 Windows NSIS 安装包，未做代码签名 |
| `Folia-Android-0.7.29.apk` | 118.3 MB（124,079,060 B） | 本仓库源码编译的 Android release 包，`Folia Whale Pet` 证书签名，`versionCode` 7029100 |
| `latest.yml` | — | 桌面端更新清单（含 SHA-512） |
| `update.json` | — | 安卓端更新清单 |

两个包均内含本仓库的更新地址；自研的色散玻璃导航条与 microRender 微内核都在包内。

### v0.7.28（历史版本 · 上游同步版）

| 文件 | 体积 | 说明 |
|---|---:|---|
| `Folia-Setup-0.7.28.exe` | 251.9 MB | 上游官方 Windows 安装包，无代码签名 |
| `Folia-Android-0.7.28-android.453.apk` | 20.0 MB | 上游官方 Android 包，debug 签名 |
| `latest.yml` / `update.json` | — | 该版更新清单 |

### v0.7.25（历史版本）

| 文件 | 说明 |
|---|---|
| `Folia-Windows-Setup-20261112-2200.exe` | Windows 安装包，**无代码签名**，SmartScreen 可能提示 |
| `Folia-Android-20261112-2200.apk` | Android 安装包，**debug 签名** |
| `Folia-Source-Full-20261112-2200.zip` | 源码包备份（清理前的历史快照） |

> 安装包仅供自研 / 校内演示使用，未做分发级签名；正式发布请另行签名。

---

## 九、授权与致谢

- 本体 Folia：**AGPL-3.0**，遵循其条款（`LICENSE` 全文）；上游同步内容同样来自 AGPL-3.0 项目。
- 视觉灵感：感谢 Mineradio 2.2.0 作者提供色散玻璃 `control-glass` 的设计思路；本项目已独立重写，未复制其源码，未引入任何与 AGPL 不相容的第三方源码。
- 汽水音乐签名组件 `bdms.node` / `metasecml.dll` 来自官方客户端 Web 安全组件，仅用于生成请求签名，版权归字节跳动与汽水音乐所有。
- 在线音乐、歌词、封面及其他第三方内容的版权归相应权利人所有，请遵守所在地法律及服务条款，并通过官方渠道支持正版。
- 本仓库在 AI 的广泛协助下开发，可能存在细微问题；仅供个人学习、技术交流与非营利测试使用，请勿用于商业盈利用途。
