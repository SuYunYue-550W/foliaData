# B站视频功能 · 路线 A（B站 DASH 自研拉流）实测记录

日期：2026-11-19
验证目的：确认「在 Folia 里播 B站视频（有画面）」这条路在技术���可行，
以及防盗链必须怎么绕。

## 一、结论先行

| 项 | 结果 |
|---|---|
| DASH 视频流可获取 | ✅ `x/player/playurl` 的 `data.dash.video[]` |
| DASH 音频流可获取 | ✅ `data.dash.audio[]` |
| 防盗链存在 | ✅ 无 Referer → **HTTP 403** |
| 注入 Referer 后可取流 | ✅ → **HTTP 200**，视频流 4.58 MB / 音频流 6.20 MB |
| 流格式合法可解码 | ✅ fMP4，`avc1`（H.264），852×480，269.77 秒，45 个 moof/mdat 分片 |
| Chromium/Electron 能播 | ✅ `avc1` + fMP4 是 Chromium 原生支持格式（与 YouTube/Apple Music 同一条技术路线） |

**所以路线 A 可行。** 关键前提只有一个：**请求必须带 `Referer: https://www.bilibili.com/`**，
这由 `electron/bilibili/mediaPolicy.cjs` 在主进程注入（见下文第四节）。

## 二、实测的接口（2026-11-19）

前置：先访问 `https://www.bilibili.com/` 拿 `buvid3` cookie（否则搜索接口 HTTP 412）。

| 用途 | 接口 | 登录 |
|---|---|---|
| 搜索视频 | `api.bilibili.com/x/web-interface/search/type?search_type=video` | 否 |
| 视频信息（拿 cid） | `api.bilibili.com/x/web-interface/view?bvid=` | 否 |
| **取流（画面+声音）** | `api.bilibili.com/x/player/playurl?bvid=&cid=&qn=64&fnval=16&fnver=0&fourk=1` | 否 |
| 推荐 | `api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd` | 否 |
| 热门 | `api.bilibili.com/x/web-interface/popular?ps=20&pn=1` | 否 |
| 动画分区 | `api.bilibili.com/x/web-interface/newlist?rid=1`（rid=1 是动画主区） | 否 |
| 影视分区 | 同上 `rid=181`（影视主区） | 否 |
| 直播分区 | `api.live.bilibili.com/room/v1/Area/getList` | 否 |
| 直播房间 | `api.live.bilibili.com/room/v3/area/getRoomList` | 否 |
| 直播流 | `api.live.bilibili.com/room/v1/Room/playUrl?cid={roomid}&qn=80` | 否 |
| 收藏夹 | `api.bilibili.com/x/v3/fav/folder/created/list-all` | **要 SESSDATA** |
| 收藏内容 | `api.bilibili.com/x/v3/fav/resource/list?media_id=` | **要 SESSDATA** |
| 历史记录 | `api.bilibili.com/x/web-interface/history/cursor?max=0&ps=20` | **要 SESSDATA** |
| 扫码登录 | `passport.bilibili.com/x/passport-login/web/qrcode/generate` + `/poll` | — |

**分区 rid**：动画 = 1，影视 = 181，音乐 = 3（备查）。注意 `rid=24` 不是动画主区，是 MAD·AMV 子分区。

**已失效的接口**（别用）：`x/web-interface/dynamic/region`（-404）、
`live/room/v1/Region/getList`（1000002）、`live/room/v1/Room/recommend`（1000003）。

**WBI 签名**：本次七个模块用到的接口**都不需要** `w_rid`。只有 `x/space/wbi/*` 这类用户空间接口才需要。
（若以后要加，算法见 bilibili-API-collect 的 `docs/misc/sign/wbi.md`：nav 接口拿 img_key/sub_key →
重排表取前 32 位 → 加 wts → 排序编码 → md5。）

## 三、DASH 流的实际内容

实测 `BV1BZbSzZEGT`（Hi-Res 无损《晴天》）：

```
视频流: (id=32, codecid=7  AVC, 852x480)  ← provider 取这一档
        (id=32, codecid=12 HEVC, 852x480)
        (id=16, codecid=12 HEVC, 640x360)
        (id=16, codecid=7  AVC, 640x360)
音频流: (id=30232, 82 kbps) (id=30280, 184 kbps) (id=30216, 65 kbps)
```

**codecid=7 是 AVC、12 是 HEVC。** provider 只取 AVC 那一档：WebView 对 HEVC 的支持不齐，
AVC 最稳（Electron 43 / Android WebView 都原生支持）。

流本身是完整 fMP4：`ftyp` + `moov` + 45 组 `moof`/`mdat`，`mvhd` 时长 269.77 秒。
Chromium 直接吃这种流，不需要 MSE 拼装。

## 四、防盗链（这是路线 A 唯一的技术门槛）

实测对比（同一个流地址）：

```
无 Referer  → HTTP 403（548 字节的错误页）
带 Referer  → HTTP 200（4,579,154 字节，完整视频流）
```

B站 Web 端取流要求 `Referer` 在 `bilibili.com` 域下且 `User-Agent` 非空。

**实现**：`electron/bilibili/mediaPolicy.cjs`
- 只对**本 provider 登记过的 URL** 注入（`register(url)`，登记在取流成功之后），
  不给任意第三方域名乱加 Referer。
- `onBeforeSendHeaders` 注入 `Referer` 与浏览器 UA。
- `onHeadersReceived` 补 `Access-Control-Allow-Origin`（DASH 的 fetch 需要）。
- `onBeforeRedirect` 把重定向后的新地址一并登记，否则 302 之后 Referer 就丢了。

Android 侧：WebView 不能自定义 Referer，靠**已有的原生回环代理**解决——
`LocalAudioServer` 的 `/remote-audio/` 路由用 OkHttp 带自定义 headers 拉流，再以 `127.0.0.1`
的地址喂给 WebView（支持 Range）。前端只需调 `proxyNativeRemoteAudioUrl(url, { headers, allowAnyHost: true })`，
**不需要改任何 Kotlin 代码**。视频和音频两条流都要过代理，只代理音频的话画面仍是 403。

`BilibiliVideoSurface` 在 Android 上的 iframe 回退也可用（项目无 CSP 限制、WebView 已开 mixed content）。

## 五、代码落点

| 位置 | 作用 |
|---|---|
| `src/services/onlineMusic/bilibili/bilibiliTransport.ts` | 所有原始请求；buvid3 获取；SESSDATA 读写 |
| `src/services/onlineMusic/bilibili/bilibiliNormalize.ts` | 视频/直播间 → `UnifiedSong` |
| `src/services/onlineMusic/bilibili/bilibiliModules.ts` | 七个模块的数据获取 |
| `src/services/onlineMusic/bilibili/bilibiliProvider.ts` | provider：`search` / `playback` / `auth` / `explore` |
| `electron/bilibili/mediaPolicy.cjs` | Referer 注入 + CORS |
| `src/stores/useBilibiliVideoStore.ts` | 画面状态（bvid / videoUrl / 内核选择） |
| `src/components/bilibili/BilibiliVideoSurface.tsx` | 播放页里的画面：A 走 DASH，失败自动回退 B（iframe） |
| `src/components/bilibili/BilibiliModulePanel.tsx` | 七模块面板 |
| `src/services/onlinePlayback.ts` | 取到 `videoUrl` 时启动画面层 |
| `dev/bilibili/dashProbe.cjs` | 端到端验证工具 |

**契约扩展**：`ProviderAudioSource` 加了可选的 `videoUrl`（同一次取流里画面与声音分开给时才有）。
音频仍走主播放引擎，画面另起一个静音 `<video>`——**不放第二个音频元素**，否则会双份出声。

## 六、还没做的部分

- **七模块界面**的完整形态（当前是独立浮层面板，还没接进播放页的 tab）。
- **搜索结果**点开后自动带画面（当前只有模块面板里点会带画面）。
- **直播流**在手机上的表现（live 的 FLV 流 HTML5 播不了，要转 HLS/fMP4）。

## 七、风险

1. **B站 2026 年发起大规模律师函维权**：头部开源项目 `bilibili-API-collect`（20k star，2026-01 关停）、
   `Nemo2011/bilibili-api`（2026-07 永久关停）、`JKVideo`（5k star，停维）都已消失。
   本功能走的是同样的非公开接口路径，**接口随时可能变**——所以播放内核做成 A+B 混合：
   A（自研拉流）失败时自动回退 B（官方 `player.bilibili.com` iframe）。
2. **接口风控**：搜索必须带 `buvid3` cookie，否则 HTTP 412；接口改动频率高。
3. **画质上限**：匿名 480P；1080P+ 需要登录态 SESSDATA。
4. **无歌词**：B站字幕不是歌词，`capabilities.lyrics` 如实关闭。
