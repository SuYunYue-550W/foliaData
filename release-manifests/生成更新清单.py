#!/usr/bin/env python3
"""生成 Folia 的桌面端与安卓端更新清单。

用法（在仓库根目录执行）：
    python release-manifests/生成更新清单.py \
        --exe <Windows 安装包路径> --apk <Android 安装包路径> \
        --tag v0.7.28 --version 0.7.28

产出：
    latest.yml              桌面 stable 通道，electron-updater 读取（作为 latest Release 附件上传）
    update.json             安卓端清单（作为 latest Release 附件上传）
    beta.yml.example        Limo 滚动通道模板（需另建 tag=limo 的 Release 才生效）
    alpha.yml.example       Cielo 滚动通道模板（需另建 tag=cielo 的 Release 才生效）

sha512 / size 从本地二进制实测，不手写；EXE 的 sha512 用 base64（electron-updater 约定）。
"""
import argparse
import base64
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

OWNER, REPO = 'SuYunYue-550W', 'foliaData'
RELEASES = f'https://github.com/{OWNER}/{REPO}/releases'

NOTES = """## v0.7.33 · 启动卡住修复与新平台构建版

本版由本仓库源码在本机真实编译，修复 Windows 启动卡在 Folia logo 加载页的问题，并为 Linux 增加 ARM64 构建、补齐 HarmonyOS 壳工程；桌面与安卓的「检查更新」继续指向本仓库 Releases。

- **Windows 启动卡住修复**：`index.tsx` 顶层副作用（microRender / 调试 / 限帧等）任一同步抛错会中断 bootstrap 的加载，导致 React 永不挂载、首屏遮罩永久停留。现改为顶部用 queueMicrotask 排队 bootstrap（同步抛错也挡不住微任务），`index.html` 另加纯内联 12 秒看门狗强制摘遮罩并打诊断标记，两道护栏互不依赖。
- **Linux 双架构**：`.github/workflows/build-linux.yml` 改为 x64（ubuntu-24.04）与 ARM64（ubuntu-24.04-arm）双 job，MNN 运行时各架构本机编译；v0.7.32 已实测两种架构共 8 个包全部上传 Release、下载 HTTP 200。
- **HarmonyOS 壳工程补齐**：新增 hvigor 配置、模块级构建配置、混淆规则与包装器，修正 ArkTS 严格模式写法与桥契约；仍需 DevEco SDK 才能编译 HAP。
- 版本号 0.7.33，安卓 versionCode 7031300（高于上一版，覆盖安装不会判为降级）。
- 验证：tsc（8GB 堆）0 错误、vite build 通过、启动护栏与桥契约单测全绿。

逐项记录见仓库 CHANGELOG.md 与 release-manifests/构建与发布.md。
"""


def sha512_pair(path: Path):
    digest = hashlib.sha512()
    md5 = hashlib.md5()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b''):
            digest.update(chunk)
            md5.update(chunk)
    return base64.b64encode(digest.digest()).decode('ascii'), md5.hexdigest()


def yaml_notes(text: str, indent: str = '  ') -> str:
    return '\n'.join(indent + line for line in text.strip().splitlines())


def desktop_manifest(version: str, exe_name: str, sha512_b64: str, size: int, stamp: str) -> str:
    return (
        f"version: {version}\n"
        f"files:\n"
        f"  - url: {exe_name}\n"
        f"    sha512: {sha512_b64}\n"
        f"    size: {size}\n"
        f"path: {exe_name}\n"
        f"sha512: {sha512_b64}\n"
        f"releaseDate: '{stamp}'\n"
        f"releaseNotes: |\n"
        f"{yaml_notes(NOTES)}\n"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--exe', required=True, type=Path, help='Windows 安装包路径')
    parser.add_argument('--apk', required=True, type=Path, help='Android 安装包路径')
    parser.add_argument('--tag', default='v0.7.33')
    parser.add_argument('--version', default='0.7.33')
    parser.add_argument('--out', default='release-manifests', type=Path)
    args = parser.parse_args()

    for path in (args.exe, args.apk):
        if not path.is_file():
            raise SystemExit(f'找不到文件: {path}')

    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

    exe_name = args.exe.name
    apk_name = args.apk.name
    exe_sha, exe_md5 = sha512_pair(args.exe)
    apk_sha, apk_md5 = sha512_pair(args.apk)
    exe_size, apk_size = args.exe.stat().st_size, args.apk.stat().st_size

    (out / 'latest.yml').write_text(
        desktop_manifest(args.version, exe_name, exe_sha, exe_size, stamp), encoding='utf-8')

    # 滚动通道只是模板：需要 tag=limo / tag=cielo 的 Release 与对应版本号构建才生效。
    for channel, suffix in (('beta', 'beta.1'), ('alpha', 'alpha.1')):
        text = desktop_manifest(f'{args.version}-{suffix}', exe_name, exe_sha, exe_size, stamp)
        header = (
            f'# 模板文件，未启用。\n'
            f'# 启用条件：构建 {args.version}-{suffix} 版本，创建 tag='
            f'{"limo" if channel == "beta" else "cielo"} 的 Release，\n'
            f'# 把本文件改名为 {channel}.yml 并作为该 Release 的附件上传。\n'
        )
        (out / f'{channel}.yml.example').write_text(header + text, encoding='utf-8')

    apk_url = f'{RELEASES}/download/{args.tag}/{apk_name}'
    manifest = {
        'version': args.version,
        'download_url': apk_url,
        'page_url': f'{RELEASES}/tag/{args.tag}',
        'notes': NOTES.strip(),
        'published_at': stamp,
        'size': apk_size,
        'assets': [{
            'name': apk_name,
            'browser_download_url': apk_url,
            'size': apk_size,
        }],
    }
    (out / 'update.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    print(f'版本 {args.version} | tag {args.tag} | 生成时间 {stamp}')
    print(f'  EXE  {exe_name}: {exe_size} B | md5 {exe_md5}')
    print(f'       sha512(base64) {exe_sha}')
    print(f'  APK  {apk_name}: {apk_size} B | md5 {apk_md5}')
    print(f'       sha512(base64) {apk_sha[:32]}...')
    print('产出:', ', '.join(sorted(p.name for p in out.iterdir() if p.is_file() and not p.name.endswith('.py'))))


if __name__ == '__main__':
    main()
