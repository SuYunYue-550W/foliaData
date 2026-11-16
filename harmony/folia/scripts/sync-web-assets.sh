#!/usr/bin/env bash
# 把 Folia 前端产物打进鸿蒙工程的 rawfile，并在 index.html 最前面注入 Capacitor 桥。
# 必须在 DevEco Studio 构建 HAP 之前跑一次；前端每改一次都要重跑。
#
# 用法：bash harmony/folia/scripts/sync-web-assets.sh
# 依赖：Node.js（构建 dist）、rsync 或 cp（拷贝文件）。

set -Eeuo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SRC="$REPO/Folia-源码-完整版"
DST="$REPO/harmony/folia/entry/src/main/resources/rawfile/dist"
BRIDGE_SRC="$REPO/harmony/folia/entry/src/main/resources/rawfile/capacitor-harmony-bridge.js"

info() { printf '\033[1;36m[Harmony]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[Harmony] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f "$SRC/package.json" ]] || fail "找不到源码目录：$SRC"

info "构建前端（FOLIA_BUILD_TARGET=capacitor，与 Android 同款产物）"
(cd "$SRC" && FOLIA_BUILD_TARGET=capacitor npm run build)

info "清空旧 rawfile/dist"
rm -rf "$DST"
mkdir -p "$DST"

info "拷贝 dist → rawfile/dist"
cp -R "$SRC/dist/." "$DST/"

info "复制 Capacitor 桥脚本到 dist 根目录"
cp "$BRIDGE_SRC" "$DST/capacitor-harmony-bridge.js"

info "在 index.html 的 <head> 最前面注入桥脚本"
node - "$DST/index.html" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
let html = fs.readFileSync(file, 'utf8');
const tag = '<script src="./capacitor-harmony-bridge.js"></script>';
if (!html.includes('capacitor-harmony-bridge.js')) {
    // 必须放在所有其它 script 之前：Capacitor core 在 import 时就读 CapacitorCustomPlatform。
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, m => `${m}\n    ${tag}`);
    else html = `${tag}\n${html}`;
    fs.writeFileSync(file, html);
    console.log('[Harmony] bridge script injected');
} else {
    console.log('[Harmony] bridge script already present');
}
NODE

size="$(du -sh "$DST" | cut -f1)"
info "完成：rawfile/dist 已就绪（$size）"
info "下一步：用 DevEco Studio 打开 harmony/folia，Build → Build HAP(s)/APP(s)"
