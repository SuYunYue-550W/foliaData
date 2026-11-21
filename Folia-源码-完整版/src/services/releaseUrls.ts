// src/services/releaseUrls.ts
// 发布页与更新清单的地址，跨端共用（Android 面板、桌面「下载来源」、Web 帮助页）。
// 单独成文件是为了让只想要一个浏览器链接的 UI 不必 import appUpdate.ts ——
// 后者会连带 Capacitor 原生桥（platform/foliaNative），桌面和纯 Web 用不到。
//
// 国内直连 github.com 常常不通，Release 附件域更是间歇性不可达。gh-proxy.com 是本仓库
// 模型下载镜像清单（shared/modelManifest.json）已在用的加速域名，ghfast.top 是第二备源。
// 这里的镜像只用于「打开发布页」这类浏览器跳转，不参与任何自动更新链路。

const REPOSITORY = 'https://github.com/SuYunYue-550W/foliaData';

export const RELEASES_PAGE_URL = `${REPOSITORY}/releases`;
export const UPDATE_MANIFEST_URL = `${RELEASES_PAGE_URL}/latest/download/update.json`;

/** 清单候选源，按顺序尝试，取到就停。 */
export const UPDATE_MANIFEST_URLS = [
  UPDATE_MANIFEST_URL,
  `https://gh-proxy.com/${UPDATE_MANIFEST_URL}`,
  `https://ghfast.top/${UPDATE_MANIFEST_URL}`,
] as const;

/** 打不开 GitHub 时的备用发布页，UI 上逐个列给用户挑。 */
export const RELEASES_PAGE_MIRRORS = [
  { label: 'gh-proxy', url: `https://gh-proxy.com/${RELEASES_PAGE_URL}` },
  { label: 'ghfast', url: `https://ghfast.top/${RELEASES_PAGE_URL}` },
] as const;
