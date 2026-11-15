# 更新日志 / CHANGELOG

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
