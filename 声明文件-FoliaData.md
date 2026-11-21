# Folia 整合增强版 · 交付声明文件（foliaData）

> 打包时间：2026-11-15 ｜ 交付包名：`foliaData.zip`
>
> ⚠️ **本文是 v0.7.25 交付时的历史快照**，文中「版本」「打包时间」等字段记录的是那一次的状态，
> 此后未再随版本更新。当前版本请看 [`README.md`](README.md) 与 [`CHANGELOG.md`](CHANGELOG.md)；
> 本文仍然有效的部分是**自研改动清单**（第四节起）与技术说明。
> 本文说明本项目**基于什么仓库**、**叠加了什么仓库**、**渲染用的微引擎技术**，以及**本人（用户）在原始项目之上做过的全部改动**。

---

## 一、基于什么仓库（基础仓库）

| 项 | 内容 |
|---|---|
| 仓库名 | **Folia**（`folia-major`） |
| 版本 | v0.7.25（displayVersion `0.7.25.dev2`，androidVersionCode `7025011`） |
| 定位 | Lyrics Reimagine（歌词再想象 / 桌面 + 移动端音乐播放与可视化应用） |
| 技术栈 | React 19 + TypeScript + Vite 8；可视化：`three 0.185` + `@react-three/fiber 9` + `pixi.js 8` + `framer-motion 13` + `animejs 4`；桌面 Electron，移动 Capacitor |
| 授权 | **AGPL-3.0**（`"private": true`，作者 maimai993） |
| 形态 | 28 个可视化模式 + 6 种背景模式，统一的模式调度层 + 各模式自带渲染链 |

本项目（Folia 整合增强版）**本体就是 Folia 这个仓库**，所有改动都在其源码树内完成，未脱离该仓库的架构与授权。

---

## 二、叠加了什么仓库（融合来源）

| 项 | 内容 |
|---|---|
| 仓库名 | **Mineradio 2.2.0**（已停更的开源项目（`main` 分支）） |
| 状态 | **长期停更**（最后更新 2026-09-07，README 声明停更） |
| 技术栈 | 原生 JS 全局 `var` + `onclick` 内联、自写 loader、`three r128`（本地 vendor）、GSAP、`music-tempo` |
| 授权 | **GPL-3.0-only** |

### 融合方式（重要合规声明）

> **AGPL-3.0 与 GPL-3.0-only 条款不相容**（GPLv3 不含 AGPLv3 第 13 条网络交互条款），因此本项目**没有复制 Mineradio 任何源码文件**。

融合采取《Mineradio融合评估-20261112.md》确定的 **B/C 做法（独立重写 + 标注出处）**：

- **唯一落地项**：**色散玻璃导航条**（`src/components/liquidGlass/`）。视觉思路参考 Mineradio 2.2.0 的 `control-glass` 效果（`feDisplacementMap` + RGB 三通道偏移 + `backdrop-filter`），用本项目 React 技术栈**独立重写**，参数模型、渐变构造、通道链、降级策略均为自研，并在源码头注释与本文中向作者致谢。
- **未引入项**（因技术栈不同代或授权冲突）：按平台分表音质、粒子播放器（three r128 巨型着色器）、3D 歌单架、CueField AutoMix（第三方 GPL 移植）等，均未并入。

---

## 三、渲染用的微引擎技术

| 项 | 内容 |
|---|---|
| 名称 | **microRender GPU 调度微内核**（自研，非第三方引擎） |
| 定义 | 「统一帧预算的调度微内核」——**不碰任何 shader / pass**，只在帧节拍层做调度 |
| 职责 | 采样真实帧耗时 → 纯函数状态机决策 → 落到已有的帧率/分辨率总闸 → 跨窗口协调 → 上下文丢失降载 |
| 文件 | `src/utils/microRender/gpuBudget.ts`（决策内核，纯函数）、`microRenderScheduler.ts`（运行时）、`renderClientRegistry.ts`（客户端注册）、`src/stores/useMicroRenderStore.ts`（开关 + 端口） |
| 算法核心 | 用户档位永远是天花板；降档先帧率后分辨率、升档逆序；连续 2 坏窗口才降、连续 6 好窗口才升；每次变更留 2.5s/8s 冷却防抖动；上下文丢失 8s 内只降不升；多层渲染 document 并存时非主层先让一档预算 |
| 独立抽取 | 决策内核已拆为**零依赖独立文件** `microRender-engine-standalone.ts`（含 5 条自检，实跑全过），随本包一同交付 |

> 说明：**色散玻璃（liquidGlass）与 microRender 是正交的两件事**——前者是叠加的视觉效果，后者是渲染调度的微引擎，二者互不影响。

---

## 四、本人（用户）在原始项目之上做过的改动

### 1. 色散玻璃导航条（视觉增强，参考 Mineradio 设计意图重写）
- 新建 `src/components/liquidGlass/`：`dispersionModel.ts`（纯计算层：位移图、三通道色散参数、能力判定）、`LiquidGlass.tsx`（注入与订阅）、`LiquidGlassNavBar.tsx`、`useLiquidGlassFilter.tsx`（按实时尺寸+圆角生成位移图）、`liquidGlass.css`、组件导出 `index.ts`。
- 演进路径：独立组件 → 接入真实导航位（底栏胶囊 + 顶栏）→ **毛玻璃 ⇄ 液体玻璃互斥切换**（设置页 `Segmented` 分段控件）→ 同切换机制套用到顶部标题栏。
- 状态：`playerBarGlass: 'frosted' | 'liquid'`（`usePlayerChromeSettingsStore`，键 `player_bar_glass`，默认 `frosted`）。
- 三语文案 `playerBarGlass*`（zh-CN / en / in）齐备。
- 依据：《色散玻璃导航条-接入说明-20261112.md》《色散玻璃导航栏效果-交付说明-20261112.md》。

### 2. 微渲染引擎 GPU 调度（性能自适应，自研）
- 新增 `src/utils/microRender/` 三件套 + `useMicroRenderStore` + `GraphicsPage` 设置项 + 三语文案。
- 把「诊断与调度断开、档位互不感知、多 document 抢 GPU」三个真空补成闭环；上下文丢失捕获阶段只读不拦截，与 5 处引擎级恢复不冲突。
- `tsc` 零错误、单测 26/26 通过。
- 依据：《渲染管线GPU调度优化-20261109.md》。

### 3. 播放器 / 音质增强
- 最高音质档位补齐、杜比音效、HiRes 输出采样率展示；酷狗 `viper_tape / viper_atmos` 桌面取流、QQ 档位链纯数据化、Spotify `audio/flac` 分支。
- 依据：《最高音质与杜比音效-交付说明-20261112.md》《最高音质档位补齐与HiRes输出-交付说明-20261112.md》。

### 4. 导出补帧层
- 导出时叠加补帧层，改进导出视频的视觉连贯性。
- 依据：《导出补帧层改动说明-20261109.md》。

### 5. 官方原项目补丁同步
- 将 Folia 上游官方补丁同步进本仓库。
- 依据：《官方原项目补丁同步说明-20261112.md》。

### 6. 鲸鱼桌宠版（形态拓展）
- 派生「鲸鱼桌宠版」「系统置顶桌面版」，含开屏/切歌的鲸鱼过渡手感打磨。
- 依据：相关桌宠版交付包与《改动说明.md》《项目整体复查报告-20261105.md》《电脑端与手机端功能对比.md》。

### 7. 多端构建与交付
- 三端交付物构建（Windows EXE / Android APK / 三份源码 zip：完整版、Windows 版、安卓版），文件名带 `YYYYMMDD-HHMM` 时间戳，配套下载页与 MD5 清单。
- 依据：《交付说明-20261112.md》及系列交付说明。

---

## 五、本交付包（foliaData.zip）内容清单

| 文件 | 说明 |
|---|---|
| `Folia-Windows-Setup-20261112-2200.exe` | Windows 安装包（306 MB，无代码签名，SmartScreen 可能提示） |
| `Folia-Android-20261112-2200.apk` | Android 安装包（124 MB，debug 签名） |
| `Folia-源码-完整版-20261112-2200.zip` | 完整版源码（含 `folia-sonnet/` 全树，146 MB） |
| `microRender-engine-standalone.ts` | 微引擎决策内核独立抽取（零依赖，含自检） |
| `声明文件-FoliaData.md` | 本文件 |

> EXE 证书未签名、APK 为 debug 签名，仅供自研/校内使用与演示，未做分发级签名。如需正式发布请另行签名。

---

## 六、授权与致谢

- 本体 Folia：AGPL-3.0，遵循其条款。
- 视觉灵感：感谢 Mineradio 2.2.0 作者提供色散玻璃 `control-glass` 效果的设计思路（本项目已独立重写，未复制其源码）。
- 未引入任何与本项目授权不相容的第三方源码。

---

## 七、上传 GitHub 前的清理（2026-11-15）

本仓库 `SuYunYue-550W/foliaData` 上传前做了以下处理，历史交付文档中的仓库指向亦已统一替换，
后续由维护者自行更新：

| 项目 | 处理 |
|---|---|
| 桌面端更新源（`build.publish`、`electron-updater`、发布频道 URL、发布页） | 统一改指向本仓库 Releases |
| 安卓端更新清单（原自建 CDN `update.json`） | 改为本仓库 `Releases/latest/download/update.json` 附件 |
| 帮助页项目地址、AI 帮助提示、登录诊断、AUR 包、CI 脚本、构建标识 | 统一改指向本仓库 |
| 旧发布仓库来源标识 | 全部替换 / 移除 |
| 原项目社区群（群号、帮助页入口、首次启动弹窗、三语文案、UI 测试与计数快照） | **全部删除** |
| `LICENSE`、`CONTRIBUTORS.md`、第三方版权声明、依赖锁文件内的地址 | 保留（署名合规与 `npm ci` 完整性） |

> 软件更新地址现统一来源于本仓库；安装包（EXE / APK / 源码 zip）作为 Release 附件分发，不进 git。
