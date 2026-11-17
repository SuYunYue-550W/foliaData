#!/usr/bin/env bash
# 用华为 SDK 自带的 hap-sign-tool.jar 给 unsigned HAP 签名。
#
# 为什么不用 hvigor 的 signingConfigs：
#   hvigor 26.0.1 要求 storePassword / keyPassword 是 DevEco 自动签名生成的**密文**，
#   且要在 storeFile 同级放一个 material/ 目录（内含 fd/ac/ce 加密材料）。
#   手工填明文 hex 会触发它去 stat <cert dir>/material 然后 ENOENT（实测踩过）。
#   所以这里直接调 SDK 的独立签名工具，用明文密码，稳定可复现。
#
# 用法：bash harmony/folia/scripts/sign-hap.sh [unsigned.hap] [signed.hap]
# 前置：证书、密钥库、Profile 在 harmony/certs/（该目录已在 .gitignore 中）。
set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SDK="${DEVECO_SDK_HOME:-D:/folia-harmony-sdk/command-line-tools/sdk}"
TOOL="${SDK}/default/openharmony/toolchains/lib/hap-sign-tool.jar"
CERTS="${REPO}/harmony/certs"

# 密码与别名（与生成证书时一致）
KEY_ALIAS="foliaec"
STORE_PASS='FoliaHarmony2026!@#'
SIGN_ALG="SHA256withECDSA"
COMPATIBLE_VERSION="12"

UNSIGNED="${1:-D:/folia-harmony-build/entry/build/default/outputs/default/entry-default-unsigned.hap}"
SIGNED="${2:-D:/folia-harmony-build/entry/build/default/outputs/default/entry-default-signed.hap}"
CERT_CHAIN="${CERTS}/folia.cer"
PROFILE="${CERTS}/foliaRelease.p7b"
KEYSTORE="${CERTS}/folia.p12"

for f in "$TOOL" "$CERT_CHAIN" "$PROFILE" "$KEYSTORE" "$UNSIGNED"; do
    [ -f "$f" ] || { echo "缺少文件: $f" >&2; exit 1; }
done

printf '\033[1;36m[Harmony]\033[0m 签名 %s\n' "$UNSIGNED"
java -jar "$TOOL" sign-app \
    -mode localSign \
    -keyAlias "$KEY_ALIAS" \
    -keyPwd "$STORE_PASS" \
    -appCertFile "$CERT_CHAIN" \
    -profileFile "$PROFILE" \
    -inFile "$UNSIGNED" \
    -signAlg "$SIGN_ALG" \
    -keystoreFile "$KEYSTORE" \
    -keystorePwd "$STORE_PASS" \
    -outFile "$SIGNED" \
    -compatibleVersion "$COMPATIBLE_VERSION"

printf '\033[1;36m[Harmony]\033[0m 验证签名\n'
java -jar "$TOOL" verify-app \
    -inFile "$SIGNED" \
    -outCertChain "${SIGNED%.hap}-chain.cer" \
    -outProfile "${SIGNED%.hap}-profile.p7b"

printf '\033[1;36m[Harmony]\033[0m 完成: %s\n' "$SIGNED"
