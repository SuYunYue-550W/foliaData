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

NOTES = """## v0.7.31 · Apple Music 与功能补齐版

本版由本仓库源码在本机真实编译，新增 Apple Music 平台与一批补齐功能；桌面与安卓的「检查更新」继续指向本仓库 Releases。

- **Apple Music**：从上游 v0.7.26~0.7.28 移植 provider、外部播放引擎与 Electron companion，
  定点补齐 fork 契约（未整体替换类型文件，避免重演契约混血）；Windows WebView2 原生宿主
  在本机编译成功并随安装包分发。音频受 DRM 保护，由 Apple 官方页面出声，需 Apple 订阅账号登录；
  Android 与 Linux 端不提供该平台。
- **功能补齐**：Cappella AI 语义词着色（含对比度兜底）、混合来源队列另存为本地歌单、
  歌词过滤规则错误提示、存储页「恢复默认目录」按钮。
- **清理**：三语各移除 506 行死文案（旧 7 页用户指南 + 19 个历史发行说明块）、
  繁中转换表 1 条死规则、14 个空目录；纠正桌宠浮层漫游与安卓原生音效的过时注释
  （这两项本就已实装，不是缺失功能）。
- 版本号 0.7.31，安卓 versionCode 7031100（高于上一版，覆盖安装不会判为降级）。
- 全套门禁通过：tsc 0 错误、全量单测、UI / 体积 / 版本 / 密钥 / 契约检查、vite build。

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
    parser.add_argument('--tag', default='v0.7.31')
    parser.add_argument('--version', default='0.7.31')
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
