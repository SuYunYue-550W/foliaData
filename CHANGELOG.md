# 更新日志 / CHANGELOG

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
