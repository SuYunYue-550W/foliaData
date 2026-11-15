# Mineradio 2.2.0 融合评估报告（对照 Folia 整合增强版）

> 对象仓库：`https://github.com/XxHuberrr/Mineradio-paused`（`main`，2.2.0，最后更新 2026-09-07，README 声明**长期停更**）
> 对照项目：`/workspace/folia-sonnet`（`folia-major` 0.7.25，AGPL-3.0）
> 源码获取：GitHub API 未认证限流（403），改用 codeload zip（5.3 MB / 311 文件）解压到临时目录逐文件阅读
> 结论基于**源码审读**，非运行截图；Mineradio 未在本沙箱运行

---

## 0. 先说三个最重要的事实（与你预期有出入）

| 你的判断 | 核实结果 |
| --- | --- |
| 「他的音质选项好像比我的多」 | **不成立**。他是**按平台分表**：网易云 5 档、QQ 4 档、酷狗 4 档、汽水 1 档、Spotify 1 档。我项目是**全局 6 档** `standard / high / ultra / lossless / hires / atmos`，数量更多。你感觉「更多」，真实原因是它的音质控件是**播放条上的常驻按钮 + 每平台一张带副标题的浮层**（`超清母带 / SVIP 最高规格`、`无损 SQ / FLAC 优先`…），而我项目是设置页里一个下拉框。 |
| 「他的粒子播放器效果我也想要」 | 值得要，但**不能搬代码**。它是 `three.js r128` + 单个巨型 GLSL 顶点着色器（13 个 preset 全塞在一个 `uPreset` 分支里）+ 全局 `var` 脚本；我项目是 React 19 + `three 0.185` + 18 个独立可视化模式 + 6 种背景模式（其中 diorama 已是 6957 行的 three.js 粒子系统）。**技术栈不同代、授权不相容**（见第 4 节）。 |
| 「他的一些导航栏效果也可以使用」 | 可行度最高的一项。核心是**纯 CSS + SVG 色散玻璃滤镜**（`feDisplacementMap` + RGB 三通道偏移 + `backdrop-filter`），不依赖 three，可重写成 React 组件。但整份 CSS 有 18576 行、强耦合全局 DOM id，同样不能直接复制。 |

---

## 1. 两个项目的底子差异（决定「融合」的正确姿势）

| 维度 | Mineradio 2.2.0 | 我项目（Folia） |
| --- | --- | --- |
| 前端框架 | **无框架**，原生 JS 全局 `var` + `onclick` 内联 | **React 19 + TypeScript + Vite 8** |
| 模块加载 | 自写 `index-loader.js` 按编号顺序拼装全局作用域 | ES Module / `import.meta.glob` 自动发现 |
| 图形栈 | `three r128`（本地 vendor，UMD 全局 `THREE`）、GSAP、`music-tempo` | `three 0.185`、`@react-three/fiber 9`、`pixi.js 8`、`framer-motion 13`、`animejs 4`、`@paper-design/shaders` |
| 音频 | 原生 `<audio>` + Web Audio `AudioContext` + `setSinkId` | Web Audio 双 deck + Android ExoPlayer 原生 DSP |
| 后端 | `server.js`（**270 KB 单文件**）+ NeteaseCloudMusicApi | Electron 多模块桥 + Capacitor 原生插件 + 平台 provider 分层 |
| 授权 | **GPL-3.0-only** | **AGPL-3.0**（private: true） |
| 状态 | 长期停更，2.2.0 为历史稳定版 | 活跃自研迭代 |

> **一句话**：这不是「同一个项目的两个分支」，是两套独立架构。融合的正确姿势是**提取设计意图、参数、算法，用我项目的技术栈重写**；直接复制粘贴会同时踩技术债和授权两个坑。

---

## 2. 逐项对比：他要的 / 我已有的 / 可融合的

### 2.1 音质选项（你点名）

**Mineradio 档位表**（`public/js/modules/00-state/00-core-stores.js:114`）

| 平台 | 档位 | 备注 |
| --- | --- | --- |
| 网易云 | `jymaster` 超清母带（SVIP）/ `hires` 高清臻音 / `lossless` 无损 SQ / `exhigh` 极高 320k / `standard` 128k | 5 档，默认 `hires` |
| QQ | `hires` Hi-Res FLAC / `lossless` 无损 FLAC / `exhigh` 320k / `standard` 128k | 4 档，默认 `lossless` |
| 酷狗 | `hires` Hi-Res 臻品 / `lossless` 无损 FLAC / `exhigh` 320k / `standard` 128k | 4 档，默认 `lossless` |
| 汽水 / Spotify | 仅 1 档「匹配源」 | 播放时自动换源 |

服务端码率（`server.js:1217`）：网易云 `jymaster 1.999 Mbps / hires 1.999 Mbps / lossless 1.411 Mbps / exhigh 999 kbps / standard 128 kbps`；走 `song_url_v1` 的 `level` 字段，SVIP 才放行 `jymaster`。

**我项目现状**：全局 6 档（含 `atmos`），`omni.resolveAudioQuality()` 按 provider 的 `audioQualityLevels` 做「最近不高于偏好」解析；上一轮刚补齐了酷狗 `viper_tape / viper_atmos` 桌面取流、QQ 档位链纯数据化、Spotify `audio/flac` 分支、Hi-Res 输出采样率只读展示。

**他真正比我强的不是档位数量，而是这 5 个交互/机制（值得移植）**：

| 机制 | Mineradio 实现 | 我项目 | 移植价值 |
| --- | --- | --- | --- |
| ① **按平台独立保存音质偏好** | `playbackQualityPrefs[provider]`，localStorage 存 JSON，含旧版单值迁移 | 全局单值 `audioQuality`（`useAudioSettingsStore`） | ⭐⭐⭐ 高。我项目各平台能力差异大（汽水 5 档 / Spotify 2 档 / 网易云 hires），全局单值会让在 Spotify 选的 `hires` 落到 QQ 时语义含糊 |
| ② **每首歌音质上限（runtime cap）** | `markPlaybackQualityRuntimeCap()` 按 `provider:id:media` 记 ceiling，UI 把超出的档位 `disabled` 并提示「当前歌曲最高：xxx」 | 无 | ⭐⭐⭐ 高。能根治「选了母带但这首只有 320k」的静默降级，与上一轮 `sourceTier` 诊断天然配套 |
| ③ **会员门槛显式化** | `jymaster` 标 `svip: true`，未登录/非 SVIP 时禁用并提示 + 引导登录 | 无（`atmos` 只有文案 hint） | ⭐⭐ 中高。我项目已有 `hasProviderSvip` 类登录态可读性，接上成本低 |
| ④ **换档即时生效（不断播）** | `applyPlaybackQualityToCurrentTrack()` 记 `resumeAt = audio.currentTime`，带 `qualitySwitch: true` 重载当前曲目并从原位置续播 | 无（需下次播放生效） | ⭐⭐⭐ 高。是「用户能感知到音质差异」的前提 |
| ⑤ **降级可见 / 实际码率展示** | `playbackQualityWasDowngraded()` + `playbackResolvedQualityText()` 显示「无损 FLAC · 1411 kbps」 | 部分（`sourceTier` 仅诊断，未上 UI） | ⭐⭐ 中。把 `sourceTier` + 实际码率显示到播放页 |
| ⑥ 音频输出设备路由 | `setSinkId` + 镜像监听 + 虚拟麦克风桥接（实验） | **已有** `AudioOutputDeviceRow.tsx` / `useAudioOutputDevice.ts` / `main.cjs` | ❌ 不需要。他的镜像监听是「复制 `<audio>` 到第二个元素」，实验性质、有延迟，我项目不必跟 |

> **推荐做法**：不引入 `jymaster` 这个假档位（我项目没有网易云 SVIP `song_url_v1` 链路，硬加就是上一轮反复避免的「假开关」）。真正该抄的是 ①②③④⑤ 这五个**机制**，用我项目现有的 `AudioQualityPreference` / `omni` / `sourceTier` 数据模型重写。

### 2.2 粒子播放器效果（你点名）

**Mineradio 的实现**（`public/js/modules/02-visual/00-pointer-cover-particles.js`，1186+ 行）

- `THREE.Points` + 自定义 `ShaderMaterial`，**把专辑封面作为纹理采样**：粒子网格 `GRID_X × GRID_Y`（由 `coverResolution` 决定，默认 1.55），每个粒子取封面 UV 的颜色
- **13 个 preset 全在一个顶点着色器的 `uPreset` 分支里**：SILK 丝绸（z 轴涟漪 + 3D simplex 噪声）、TUNNEL 隧道自旋、ORBIT 星球、VOID 虚空（不显示粒子）、VINYL 黑胶唱片（沟槽 + 白边 + 中心封面）、WALLPAPER PULSE 极光带、ECLIPSE HALO 月蚀圣环、NEON DRIZZLE 霓虹雨幕、PRISM FLOCK 折光蝶群、ABYSSAL BLOOM 深海绽放、SONIC 音域回响、SKULL 骷髅点云、ANQUAN 安魂
- 音频驱动：`uBass / uMid / uTreble / uBeat / uEnergy` 5 个 uniform，随节拍位移/放大/发光
- 交互：鼠标推开粒子（射线投到粒子平面）、拖拽自旋、滚轮缩放、手势握拳（`uGestureGrip`）、点击涟漪（`DataTexture` 存 12 个 ripple）
- 切歌：`uPrevCoverTex → uCoverTex` 颜色渐变 `uColorMixT`
- 附加层：1400 点「背景星河」、bloom 加色层、加载态雾状微尘
- 还有 `public/assets/skull-decimation-points.bin`（骷髅点云数据）

**我项目现状**：18 个内置可视化模式（`cadenza / cappella / claddagh / classic / diorama / fume / hanabi / lumiere / machi / monet / nebbia / partita / pendolo / prompt / sonnet / still / tempera / tilt`）+ 6 种背景模式（`common / latent / monet / nomand / sora / url`）。其中 **`diorama` 已是 three.js 粒子系统（6957 行，含 `DioramaScene.tsx` / `dioramaParticleShaders.ts` / `DioramaParticleField.tsx` / `CameraRig.tsx` / `cameraPath.ts`）**，另有 `pixi` / `hanabi` 烟花 / `fume` 流体 / `FluidBackground` / `GeometricBackground`。

**判定**：

| 结论 | 说明 |
| --- | --- |
| ❌ 不能整包搬 | r128 → 0.185 API 差异、全局 `var` → React 组件、单文件 1186 行 → 18 模式注册表，重写量极大；且 GPL-3.0 代码并入 AGPL-3.0 项目会触发 copyleft 义务 |
| ❌ 「封面采样粒子」我项目未必缺 | diorama 已有粒子材质/着色器/相机路径，需先确认它是否已做封面取色，别重复造轮子（**建议第一步先做这个内部盘点**） |
| ✅ 值得借鉴的是**设计意图**，可零成本落到现有系统 | ① 把「封面颜色/图案作为粒子源」做成 diorama 的一个新子模式或参数；② 补 2~3 个 preset 形态（黑胶唱片、极光带、星河），各写成独立 `entry.tsx` 注册进 registry；③ 点击涟漪 / 鼠标推开 / 切歌封面渐变这 3 个**交互**，用我项目已有的 shader 骨架加 uniform 即可；④ 「加载态雾状微尘」可直接用于我项目的开屏/切歌过渡（呼应你之前反复调的鲸鱼过渡手感） |

> 它 13 个 preset 里**真正有辨识度的是 VINYL 黑胶**（把封面画进唱片中心 + 沟槽 + 白色外圈）和 **WALLPAPER PULSE 极光带**，这两个在我项目 18 个模式里没有同形态，优先级最高。

### 2.3 导航栏 / UI 动效（你点名）

**Mineradio 的效果清单**

| 效果 | 实现位置 | 技术 |
| --- | --- | --- |
| **色散玻璃控制条** | `15-control-glass-animations.js` + `#mineradio-control-glass-filter` | SVG `feDisplacementMap` 位移图（运行时按控件宽高动态生成 data-URI）+ RGB 三通道 `feOffset` 色差 + `backdrop-filter: url(#...)`；Chromium 专属，Safari/Firefox 主动降级 |
| 玻璃搜索框 / 账号胶囊 / 搜索胶囊 | 同模块，4 套独立滤镜 | 同上，各带 `generate*GlassDisplacementMap(width, height, radius)` |
| 顶部 `home-rail` 侧栏 | `public/index.html:211` + CSS `.home-rail` | 主页信息层级（每日推荐 / 平台推荐 / 继续听 / 听歌画像 / 我的歌单） |
| 面板 Tab | `#playlist-panel` `.panel-tabs` / `.panel-tab` | 「当前队列 / 我的歌单 / 我的播客」切换 |
| 3D 歌单架 | `public/js/modules/04-shelf/*`（7 文件） | three.js 卡片，右键唤起，三段模式（关闭/侧栏/舞台）、动态/静态镜头、自动隐藏/常驻 |
| 控件自动隐藏、手势、全屏 DIY 悬浮入口 | `10-shell/*` | GSAP + 鼠标位置追踪 |

**我项目现状**：`framer-motion 13` + `animejs 4` + 已有 `backdrop-filter` 玻璃效果（`statusToast.css` / `ExploreSurface.tsx` / `ListeningArchive.tsx` / `LatticeSections.css` 等），有 `Carousel3D.tsx`、`NaviTab.tsx`、`panelTab/`、`settings/kit/Menu.tsx`、`UnifiedPanel.tsx`。

**判定**：

| 项 | 可融合度 | 说明 |
| --- | --- | --- |
| **SVG 色散玻璃滤镜** | ⭐⭐⭐ **最推荐** | 纯 CSS/SVG、无 three 依赖、与 React 无冲突。可封装成一个 `<DispersionGlass>` 组件 + 一个按尺寸生成位移图的 hook，套到播放条 / 搜索框 / 账号胶囊。Chromium（Electron 43）完美支持，正好是我项目主战场 |
| `home-rail` 主页信息层级 | ⭐⭐ 中 | 我项目已有 `Home.tsx` / `ExploreSections.tsx` / 每日推荐类能力，属于信息架构调整，不是纯视觉 |
| 面板 Tab 动效 | ⭐⭐ 中 | 已有 `panelTab/` 与 `UnifiedPanel`，用 framer-motion 加选中态位移即可，不必抄它的 CSS |
| 3D 歌单架 | ⭐ 低（不建议） | 我项目已有 `Carousel3D.tsx` 和 `ponder/` 3D 界面体系；它那份 7 文件强耦合全局 `shelfManager` + `index.html` 内联逻辑，重写成本 >> 收益 |
| 控件自动隐藏 / 手势 | ⭐⭐ 中 | 我项目已有 `useBackgroundRenderPause` 等后台节流，可补「鼠标静止自动隐藏播放条」这一条 |

> **注意**：`15-control-glass-animations.js` 里 13 个 `getElementById` 硬编码全局 id、`controlGlassState` 全局对象、依赖 `fx` / `fxDefaults` 全局配置。**只能取「生成 SVG 位移图 + feOffset 色差」这个算法思路重写**，不要试图把模块塞进 React。

---

## 3. 其它值得关注的候选（你没点名，但审读中发现）

| Mineradio 特性 | 我项目对应 | 建议 |
| --- | --- | --- |
| **性能自适应体系**：`09-performance-probe.js` / `10-frame-scheduler.js` / `08-desktop-render-power.js` / `11-system-memory-controls.js`，含低配优化宣言 `docs/LOW_SPEC_OPTIMIZATION_DOCTRINE.md`、画质档位（低/中/高/超高）、后台策略（自动优化/保持运行/停止释放） | 我项目上一轮刚做的 **microRender GPU 调度**（p10/p90、慢帧占比、冷却、用户档位上限、跨窗口优先级） | ⭐⭐⭐ **建议对读**。两套独立实现可互相校验，尤其「低配设备降级」与「后台保持/释放」策略，我项目可能缺显式的用户可选档位 |
| **节拍/镜头系统**：`03-beat/*`（离线节拍分析、`music-tempo`、DJ/播客专属分析、本地 beatmap 缓存）、`01-scene/*`（节拍镜头、聚焦电影镜头、自由轨道相机） | 我项目有 `BeatEffectsGroup.tsx` / `beatClockTargets.ts` / `SmartBeatSettingsCard.tsx` / `lyricDirector` / `diorama/CameraRig.tsx` | ⭐⭐ 同类能力，重点看它的**播客/DJ 长曲目专属视觉模式**——我项目可能没有按内容类型切换视觉的分支 |
| **CueField AutoMix**：`cuefield/*` 20 文件 + `17*-cuefield-*`，源自 `SLYysl/cuefield-mineradio`（GPL-3.0），做结构分析、边界证据、转场配方、B-deck 时间线 | 我项目有 `services/automix/*`（`crossfadePlanner` / `transitionChooser` / `deckAnalyser` / `automixSession`） | ⭐ 同类能力，**且它明确标注是第三方 GPL 移植**，融合它的授权风险更高，不建议 |
| **桌面歌词独立窗口**：`desktop-lyrics.html` + `docs/DESKTOP_LYRICS_VISUAL.md`，锁定穿透、中键解锁、白底可读性中性外描边 | 我项目有 `wallpaperSurface.tsx` / `RemoteLyricOverlay.tsx` / `useNativeLyricsSubscription` | ⭐⭐ 可直接借鉴**白底可读性方案**（`drop-shadow` + `-webkit-text-stroke` 中性外描边，不用灰/黄染字），这是纯 CSS 且很实用 |
| **Wallpaper Engine 本地视觉库** | 我项目 `videoLayer/` / URL 背景 | ⭐ 低，Windows 专属生态 |
| **音源换源兜底** `11-provider-fallback.js` | 我项目 `handleOnlineMediaFailure.ts` / `createOnlineRecoveryController.ts` | ❌ 已有 |

---

## 4. 授权与合规边界（**必须先定的前提**）

| 事实 | 依据 |
| --- | --- |
| Mineradio 是 **GPL-3.0-only** | `package.json` `"license": "GPL-3.0-only"`，根目录 `LICENSE` 为完整 GPLv3 文本 |
| 我项目是 **AGPL-3.0** | `package.json` `"license": "AGPL-3.0"`，`"private": true` |
| 作者额外声明原创设计权 | `NOTICE.md`：「MR Logo、Mineradio 名称、**界面视觉设计**、启动动画方向、**粒子视觉体验和电影镜头系统的产品表达**属于作者原创设计」 |
| README 的宽松口径 | 「感兴趣的个人玩家可随意使用本项目进行创作，也可以自行修改和修复 bug」——但这是针对 **Fork / 二创本仓库**，不是把代码并入另一个不同授权的项目 |
| 它自身还移植了第三方 GPL 代码 | `NOTICE.md` / `docs/THIRD_PARTY_PORTS.md`：CueField AutoMix、Mineradio-LX-Music 桌面模式、汽水 QR 登录桥，均为 GPL-3.0 |

**三种做法的合规差异**：

| 做法 | 风险 | 建议 |
| --- | --- | --- |
| A. **直接复制源码文件**（shader / CSS / JS 模块）进我项目 | 🔴 高。GPL-3.0-only 与 AGPL-3.0 同为强 copyleft 但**条款不相容**（GPLv3 不含 AGPLv3 第 13 条网络交互条款）；并入后整体分发的授权义务会冲突，且 NOTICE 声明的原创设计权未被授权 | ❌ 不做 |
| B. **阅读后按同一算法/参数独立重写**（React 组件、新 GLSL、新 CSS） | 🟡 低。思想、算法、参数、功能布局通常不受版权保护；只要不是逐行翻译式照搬具体表达，属于独立实现 | ✅ **推荐**，同时在文档里标注「参考 Mineradio 2.2.0 设计思路」并保留出处链接 |
| C. **只借鉴交互/信息架构**（按平台音质偏好、每曲上限、白底歌词可读性） | 🟢 极低。纯功能性设计 | ✅ 推荐 |

> 补充：即便走 B/C，也建议在你的项目文档里加一行致谢与来源链接（不引入其代码）。若你未来要把项目**公开发布/参赛**，这一点尤其重要；若仅校内自研、不分发，风险主要停留在合规规范层面。

---

## 5. 综合结论

**「我项目里面有的」（不用重复做）**：全局 6 档音质框架、18+6 套可视化/背景模式、three.js 粒子系统（diorama 6957 行）、自动混音、镜头/节拍系统、桌面歌词、音频输出设备选择、换源兜底、microRender GPU 调度、玻璃拟态基础。

**「Mineradio 有、值得融合」的（按推荐优先级）**：

| 优先级 | 项 | 类型 | 成本 |
| --- | --- | --- | --- |
| P0 | **SVG 色散玻璃滤镜**（播放条/搜索框/账号胶囊） | 纯 CSS/SVG 重写 | 低，1 个组件 + 1 个 hook |
| P0 | **按平台独立音质偏好 + 每首歌音质上限 + 换档即时续播** | 复用现有 `omni` / store 扩展 | 中，3 处数据模型 + UI |
| P0 | **音质降级/实际码率可见**（把 `sourceTier` 上 UI） | 已有数据上屏 | 低 |
| P1 | **2~3 个新粒子形态**（VINYL 黑胶 / 极光带 / 封面采样）注册为独立可视化模式 | 用现有 registry + three 0.185 重写 | 中高 |
| P1 | **点击涟漪 / 鼠标推开 / 切歌封面渐变 / 加载态雾尘** | 现有 shader 加 uniform | 中 |
| P1 | **性能档位显式化**（低/中/高/超高的用户可选 + 后台策略三态） | 对读 microRender 后补 | 中 |
| P2 | 白底桌面歌词中性外描边、鼠标静止隐藏播放条、播客/DJ 专属视觉分支 | 零散打磨 | 低 |
| — | ❌ 不引入 `jymaster` 假档位、❌ 不搬 3D 歌单架、❌ 不碰 CueField 第三方 GPL 移植、❌ 不复制任何源码文件 | 授权/成本/重复 | — |

---

## 6. 落地前需要你定的两件事

1. **范围**：是想「先把 P0 三块做了」，还是「只做纯视觉的 P0 玻璃滤镜 + P1 粒子形态」，还是「先只做一次内部盘点（确认 diorama 是否已封面取色）再决定」？
2. **合规口径**：确认走 **B/C（独立重写 + 标注出处）**，我会在代码与交付说明里加致谢行；本轮**不会**把 Mineradio 任何源码文件复制进 `/workspace/folia-sonnet`。

> 本报告只做审读与评估，**未修改我项目任何代码、未重新打包**。临时解压的 Mineradio 源码位于沙箱临时目录，不在 `/workspace` 交付区。
