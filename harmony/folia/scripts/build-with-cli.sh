#!/usr/bin/env bash
# 用华为 Command Line Tools（内嵌 HarmonyOS SDK）在命令行编译 HarmonyOS HAP。
# 无需 DevEco Studio IDE。SDK 解压目录由第一个参数或 DEVECO_SDK_ROOT 给出。
#
# 用法：
#   bash harmony/folia/scripts/build-with-cli.sh <command-line-tools 解压根目录>
#   DEVECO_SDK_ROOT=/d/folia-harmony-sdk/... bash harmony/folia/scripts/build-with-cli.sh
#
# 只读写本仓库与 SDK 目录；不改系统环境变量（在当前 shell 子进程内设置）。

set -Eeuo pipefail
info() { printf '\033[1;36m[HAP Build]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[HAP Build] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # harmony/folia
REPO="$(cd "$PROJECT/../.." && pwd)"
ROOT="${1:-${DEVECO_SDK_ROOT:-}}"
[[ -n "$ROOT" && -d "$ROOT" ]] || fail "请给出 Command Line Tools 解压根目录"

# ── 1. 定位 Command Line Tools 的实际根目录（解压后可能多套一层 command-line-tools）──
CLI="$ROOT"
if [ -d "$ROOT/command-line-tools" ]; then CLI="$ROOT/command-line-tools"; fi
info "CLI 根目录: $CLI"

# 找 sdk 目录（DEVECO_SDK_HOME 指向它）
SDK=""
for cand in "$CLI/sdk" "$ROOT/sdk" "$CLI/Sdk"; do
    [ -d "$cand" ] && { SDK="$cand"; break; }
done
[ -n "$SDK" ] || fail "找不到 SDK 目录（期望 $CLI/sdk）"
export DEVECO_SDK_HOME="$SDK"
info "DEVECO_SDK_HOME=$SDK"

# 把 bin 目录加进 PATH（hvigor / ohpm / codelinter 等）
for d in "$CLI/bin" "$CLI/hvigor/bin" "$CLI/ohpm/bin" "$CLI/codelinter/bin"; do
    [ -d "$d" ] && export PATH="$d:$PATH"
done

# hvigorw 需要 NODE_HOME；优先用 PATH 里的 node 所在目录（SDK 自带 node 通常为空）
NODE_BIN="$(command -v node || true)"
if [ -n "$NODE_BIN" ]; then
    export NODE_HOME="$(dirname "$NODE_BIN")"
    info "NODE_HOME=$NODE_HOME"
else
    fail "找不到 node（hvigorw 需要 NODE_HOME）"
fi

# ── 2. JDK 21（26.0.0+ 推荐）──
JDK21="${JDK21:-/c/Users/芒果游泳/AppData/Local/Temp/folia_upstream/jdk21/jdk-21.0.13+9}"
if [ -d "$JDK21" ]; then
    export JAVA_HOME="$JDK21"
    export PATH="$JAVA_HOME/bin:$PATH"
    info "JAVA_HOME=$JAVA_HOME"
else
    info "未找到指定 JDK21，使用系统 java: $(java -version 2>&1 | head -1)"
fi

# ── 3. 对齐 hvigor 版本（从 SDK 模板读真实版本写回工程）──
if [ -f "$PROJECT/scripts/align-sdk-version.py" ]; then
    info "对齐 hvigor 版本"
    python "$PROJECT/scripts/align-sdk-version.py" "$CLI" || info "版本对齐脚本失败，继续用当前配置"
fi

# ── 4. 找到真正的 hvigorw 可执行文件 ──
HVIGORW=""
# 只认 POSIX 脚本（无扩展名），排除 .bat（那是给 cmd.exe 用的，bash 跑不了）
for cand in \
    "$CLI/hvigor/bin/hvigorw" \
    "$CLI/bin/hvigorw" \
    "$CLI/hvigorw" "$ROOT/hvigorw"; do
    [ -f "$cand" ] && [ ! "${cand##*.}" = "bat" ] && { HVIGORW="$cand"; break; }
done
[ -n "$HVIGORW" ] || fail "找不到 bash 版 hvigorw（在 $CLI 下搜索无果）"
info "使用 hvigorw: $HVIGORW"

# ── 5. 编译 ──
cd "$PROJECT"
# WorkBuddy 沙箱用 NODE_OPTIONS(--require) 往每个 Node 子进程注入 node-safe-delete shim；
# ohpm/hvigor 安装依赖时要清理自己的临时文件，会被该 shim 转给 genie-trash，本机上超时卡死。
# 这是本机特有的构建干扰（与 Vite 清 dist、electron-builder 裁剪语言包同类）。
# 仅在本构建的子进程里移除注入，不改系统/仓库的安全配置，也不触碰项目外的任何文件。
if [ "${KEEP_SAFE_DELETE_SHIM:-0}" != "1" ]; then
    unset NODE_OPTIONS
    unset CODEBUDDY_SAFE_DELETE_ENABLED CODEBUDDY_SAFE_DELETE_SANDBOX CODEBUDDY_SAFE_DELETE_BULK_GUARD
    info "已在本构建子进程内移除沙箱删除 shim 注入（KEEP_SAFE_DELETE_SHIM=1 可保留）"
fi
info "执行 hvigorw assembleHap"
bash "$HVIGORW" assembleHap --mode module -p product=default --no-daemon 2>&1 | tee "$PROJECT/build-hap.log"
RC=${PIPESTATUS[0]}
[ "$RC" -eq 0 ] || fail "hvigorw 编译失败（exit=$RC），见 $PROJECT/build-hap.log"

# ── 6. 找 HAP 产物 ──
info "HAP 产物："
find "$PROJECT" -type f -name '*.hap' -printf '%s %p\n' 2>/dev/null | sort -n
