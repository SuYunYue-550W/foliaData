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

NOTES = """## v0.7.40 · B站融入首页 + 修复覆盖安装

- **B站重设计（重点）**：B站以前是整个项目里唯一特殊的平台 —— 除 provider 外还自带播放面板页签、独立内容面板、独立状态层和独占画面层，跟「歌单 / 电台 / 专辑」那一套首页页签互不相通，看起来就像跟播放器不是一家的。现在 B站成为**首页的一级页签**，点进去是一个全屏页面：顶部有返回键和原生页签条，中间是推荐 / 热门 / 动画 / 影视 / 直播 / 收藏 / 历史七个模块，下面是视频网格。播放仍保持嵌入在歌词背后的画面层，声音由主引擎出。播放面板里的那个 B站入口现在只是跳转按钮，不再是一个关不干净的内容区；原来那个只会切回封面页签、名不副实的「关闭」按钮已删除。Esc 可以返回。
- **Windows 覆盖安装修复**：双击新 EXE 覆盖安装一直报「Folia 无法关闭」/「uninstallFailed: 2」。根因是自定义进程清理只杀 Folia 主进程、只等 400ms，把 electron-builder 自带的轮询重试整个替换掉了，而 Apple Music companion / ffmpeg 这些后台程序仍锁着 app.asar。现在按「可执行文件位于安装目录下」杀所有相关进程并轮询确认退出；全新安装默认装到 D://Folia（已有安装保持原路径，确保覆盖仍可用）。
- 三语 i18n 与界面门禁全过。B站页签与页面结构已在本机 dev server 真机截图确认。

逐项记录见仓库 CHANGELOG.md 与 release-manifests/构建与发布.md 第 12 节。
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
    parser.add_argument(
        '--apk-name',
        default=None,
        help='上传到 Release 时用的附件名。默认取本地文件名，但本地通常是 app-release.apk，'
             '与真正上传的附件名不一致 —— 清单里的地址会 404，必须显式给出上传时用的名字。')
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
    apk_name = args.apk_name or args.apk.name
    exe_sha, exe_md5 = sha512_pair(args.exe)
    apk_sha, apk_md5 = sha512_pair(args.apk)
    apk_sha_hex = hashlib.sha512(args.apk.read_bytes()).hexdigest()
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
        # 摘要：原生下载完成后按它比对，挡住下载损坏与清单被替换。
        # base64 与 electron-updater 的约定一致；hex 给 Android 侧（Kotlin）直接比对。
        'sha512': apk_sha,
        'sha512_hex': apk_sha_hex,
        'assets': [{
            'name': apk_name,
            'browser_download_url': apk_url,
            'size': apk_size,
            'sha512': apk_sha,
            'sha512_hex': apk_sha_hex,
        }],
    }
    (out / 'update.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    print(f'版本 {args.version} | tag {args.tag} | 生成时间 {stamp}')
    print(f'  EXE  {exe_name}: {exe_size} B | md5 {exe_md5}')
    print(f'       sha512(base64) {exe_sha}')
    print(f'  APK  {apk_name}: {apk_size} B | md5 {apk_md5}')
    print(f'       sha512(base64) {apk_sha[:32]}...')
    print(f'       sha512(hex) {apk_sha_hex[:32]}...')
    if args.apk_name is None:
        print('  ⚠ 未指定 --apk-name：清单用的是本地文件名，上传时必须用同一个名字，否则地址 404。')
    print('产出:', ', '.join(sorted(p.name for p in out.iterdir() if p.is_file() and not p.name.endswith('.py'))))


if __name__ == '__main__':
    main()
