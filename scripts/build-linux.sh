#!/usr/bin/env bash
# Linux 原生一键构建：Folia 整合增强版的 tar.gz / deb / rpm / AppImage 产物。
#
# 为什么必须在 Linux 本机跑（不能像 Windows 那样交叉编译）：
#   build/buildMnnRuntime.mjs 明确拒绝跨平台构建 —— MNN 运行时是从固定 commit 的源码
#   用 gcc/CMake 编出来的，Apple Music 的原生宿主在 Linux 也不提供。所以这台机器必须
#   是 Linux（x64 或 arm64），项目路径最好也是纯 ASCII（AGP/部分 CMake 脚本对中文路径敏感）。
#
# 用法：
#   bash scripts/build-linux.sh                      # 全平台默认架构，全部目标
#   TARGETS=tar.gz,deb ARCH=x64 bash scripts/build-linux.sh
#   OUTPUT=/tmp/folia-linux bash scripts/build-linux.sh
#   SKIP_DEPS=1 bash scripts/build-linux.sh          # 依赖已装好时跳过 apt/dnf
#
# 产物：$OUTPUT（默认 <repo>/release-linux-v0.7.32），包含 .tar.gz / .deb / .rpm / AppImage。
# 用法详见 release-manifests/构建与发布.md 的 Linux 一节。

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/Folia-源码-完整版"
PKG="$SRC/package.json"
OUT="${OUTPUT:-$REPO/release-linux-v$(node -p "require('$PKG').version")}"
TARGETS="${TARGETS:-tar.gz,deb,rpm,AppImage}"
ARCH="${ARCH:-$(node -p "process.arch")}"
SKIP_DEPS="${SKIP_DEPS:-0}"

info() { printf '\033[1;36m[Linux Build]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[Linux Build] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f "$PKG" ]] || fail "找不到源码包配置：$PKG"
[[ "$(uname -s)" == Linux ]] || fail "这个脚本必须在 Linux 上运行（检测到 $(uname -s)）"
case "$ARCH" in x64|arm64) ;; *) fail "仅支持 x64 / arm64，收到：$ARCH" ;; esac

command -v node >/dev/null || fail "需要 Node.js 20+（当前未找到 node）"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || fail "需要 Node.js 20+（当前 $(node -v)）"
command -v npm >/dev/null || fail "需要 npm"
command -v git >/dev/null || fail "需要 git（MNN 源码按其 commit 校验）"

# ── 1. 系统依赖（Electron + fpm/rpmbuild + MNN 的 CMake/C++17 + AppImage 的 FUSE 工具）──
if [[ "$SKIP_DEPS" != 1 ]]; then
    info "安装系统依赖（需要 sudo；CI 里可设 SKIP_DEPS=1 跳过）"
    if command -v apt-get >/dev/null; then
        sudo apt-get update -qq
        sudo apt-get install -y -qq \
            build-essential cmake git curl wget ruby-dev \
            rpm libarchive-tools xz-utils zsync file \
            libgtk-3-0 libnss3 libnspr4 libgbm1 \
            libxss1 libxtst6 libx11-xcb1 libxcb-dri3-0 libdrm2 libatk-bridge2.0-0 \
            libatspi2.0-0 libcups2 libxrandr2 libxcomposite1 libxdamage1
        # Ubuntu 24.04 起 ALSA 运行库由 libasound2 改名为 libasound2t64；
        # 固定写死任一名字都会让另一代发行版的 apt 以 100 退出，这里按可用性探测。
        alsa_pkg=""
        for candidate in libasound2t64 libasound2; do
            if apt-cache show "$candidate" >/dev/null 2>&1; then
                alsa_pkg="$candidate"
                break
            fi
        done
        if [[ -n "$alsa_pkg" ]]; then
            info "安装 ALSA 运行库：$alsa_pkg"
            sudo apt-get install -y -qq "$alsa_pkg"
        else
            info "未找到 ALSA 运行库包，Electron 的音频设备可能无法工作"
        fi
    elif command -v dnf >/dev/null; then
        sudo dnf install -y gcc-c++ cmake git ruby-devel rpm-build \
            libarchive xz zsync file gtk3 nss nspr alsa-lib libgbm libXScrnSaver \
            libXtst libxcb libdrm at-spi2-atk cups-libs libXrandr libXcomposite libXdamage
    elif command -v pacman >/dev/null; then
        sudo pacman -Sy --noconfirm base-devel cmake git ruby \
            rpm-tools libarchive xz zsync file gtk3 nss nspr alsa-lib libgbm \
            libxss libxtst libxcb libdrm at-spi2-atk cups libxrandr libxcomposite libxdamage
    else
        info "未识别的发行版：请自行安装 build-essential/cmake/git/ruby/rpm/libarchive + Electron 运行时依赖"
    fi
else
    info "SKIP_DEPS=1，跳过系统依赖安装"
fi

cmake_major="$(cmake --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1 | cut -d. -f1 || echo 0)"
[[ "${cmake_major:-0}" -ge 3 ]] || fail "cmake >= 3.24 未找到"
if [[ "$TARGETS" == *rpm* ]]; then
    command -v rpmbuild >/dev/null || fail "打 rpm 需要 rpmbuild（本脚本会尝试安装，或设 TARGETS 去掉 rpm）"
fi

# ── 2. npm 依赖 ──
info "检查 node_modules（缺则 npm ci）"
if [[ ! -d "$SRC/node_modules/electron-builder" ]]; then
    (cd "$SRC" && npm ci)
else
    info "node_modules 已存在，跳过 npm ci；如需重装请先手动删除"
fi

# ── 3. 前端产物 ──
info "构建前端（vite build）"
(cd "$SRC" && npm run build)

# ── 4. electron-builder 配置临时改写（构建期置空 electronLanguages 规避删除钩子；指定输出目录）──
ORIGINAL="$(cat "$PKG")"
restore() {
    printf '%s' "$ORIGINAL" > "$PKG"
    info "package.json 已恢复"
}
trap restore EXIT

node - "$PKG" "$OUT" "$TARGETS" <<'NODE'
const fs = require('fs');
const [pkgPath, outDir, targets] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
// fpm（rpm/deb）打包要求 metadata 有 homepage，否则报 "Please specify project homepage"；
// repository 顺带补上消掉 electron-builder 的仓库探测警告。只在构建期注入，trap 退出时恢复。
config.homepage = 'https://github.com/SuYunYue-550W/foliaData';
config.repository = { type: 'git', url: 'git+https://github.com/SuYunYue-550W/foliaData.git' };
// electron-builder 在裁剪语言包时会批量删除 .pak，某些受限沙箱会拦截；
// 置空后它跳过裁剪（Linux 包体积略大，但构建可靠）。
config.build.electronLanguages = [];
config.build.directories = { ...(config.build.directories || {}), output: outDir };
config.build.linux = {
    ...(config.build.linux || {}),
    // AppImage 需要下载 appimage-tools；CI 网络不佳时可 TARGETS=tar.gz,deb,rpm 跳过。
    target: targets.split(',').map(s => s.trim()).filter(Boolean),
};
fs.writeFileSync(pkgPath, JSON.stringify(config, null, 2) + '\n');
console.log(`[Linux Build] 构建目标：${config.build.linux.target.join(', ')}`);
NODE

# ── 5. 打包（beforePack 会编 MNN、下载 ffmpeg/模型；均在 Linux 本机完成）──
info "electron-builder 开始打包（MNN 首次编译约 5~15 分钟）"
(cd "$SRC" && node node_modules/electron-builder/out/cli/cli.js --linux --"$ARCH" --publish never)

# ── 6. 校验 ──
info "产物清单："
find "$OUT" -maxdepth 1 -type f \( -name '*.tar.gz' -o -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' -o -name '*.yml' \) \
    -printf '%f  %s B\n' | sort
count="$(find "$OUT" -maxdepth 1 -type f \( -name '*.tar.gz' -o -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) | wc -l)"
[[ "$count" -gt 0 ]] || fail "没有任何安装包产出，请检查上面的 electron-builder 日志"
info "完成：$count 个安装包 → $OUT"
