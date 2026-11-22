// src/services/releaseUrls.ts
// 发布页与更新清单的地址，跨端共用（Android 面板、桌面「下载来源」、Web 帮助页）。
// 单独成文件是为了让只想要一个浏览器链接的 UI 不必 import appUpdate.ts ——
// 后者会连带 Capacitor 原生桥（platform/foliaNative），桌面和纯 Web 用不到。
//
// 国内直连 github.com 常常不通，Release 附件域更是间歇性不可达。gh-proxy.com 是本仓库
// 模型下载镜像清单（shared/modelManifest.json）已在用的加速域名，ghfast.top 是第二备源。
// 镜像既用于「打开发布页」这类浏览器跳转，也用于清单与 APK 下载的回退
// （见 apkDownloadUrls）—— 清单拿得到但附件域不通时，应用内更新才不至于卡住。

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

/**
 * 从一个 Release 附件地址派生候选下载地址：直连、两个加速域名。
 *
 * 清单里写的是 github.com 的附件地址；国内很多时候清单能拿到（走镜像），但附件域不通。
 * 逐个试，全部共用同一个 SHA-512 —— 换的是路，不是要装的东西。
 * 非 github.com 的地址（第三方 CDN 之类）原样返回，不硬套前缀。
 */
export const apkDownloadUrls = (url: string): string[] => {
  if (!/^https?:\/\/github\.com\//i.test(url)) return [url];
  const path = url.replace(/^https?:\/\/github\.com/i, '');
  return [url, `https://gh-proxy.com${path}`, `https://ghfast.top${path}`];
};

