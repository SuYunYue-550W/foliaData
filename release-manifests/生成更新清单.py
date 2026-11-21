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

NOTES = """## v0.7.38 · 修好安卓更新下载，闭环 B站登录

本版修掉两件真问题：安卓应用内更新下不了（清单地址 404），以及 B站扫码登录「扫得出码、登不上号」。

- **安卓应用内更新修复**：上一版的版本清单里写的安装包名字用的是本地构建文件名，而真正上传的附件叫另一个名字，地址 404 —— 点了下载没反应。清单现在按上传时的附件名生成，发版流程里也加了一道烟雾测试：逐个请求清单里的地址并比对大小，不通过就不算发完。
- **安装包完整性校验**：清单里带上安装包的 SHA-512，Android 下载时同步计算摘要，对不上就把文件删掉、不交给系统安装器 —— 挡的是下载损坏和清单被替换。
- **B站扫码登录闭环**：此前扫码成功后账号仍显示未登录（原生存的会话被调用方自带的 Cookie 头挡掉了），登出后重启又自动登录回来（原生那份会话没清）。现在请求按 Cookie 名字合并，登出按域名清掉 B站这一份，其它平台不受影响。
- **B站二维码改为本地生成**：扫码地址本身是网页不是图片，之前直接当图片渲染所以显示破图；现在用本地依赖生成二维码，不需要第三方服务。
- **更新源多路回退**：GitHub 直连不通时自动改走加速域名，设置页也给出多个下载入口。
- **省电**：后台节流改为默认开启（最小化到托盘后不再空跑 60/120fps）；壁纸在暂停且颜色收敛后停下帧循环；预取缓存按 8MB 封顶。
- 版本号 0.7.38，安卓 versionCode 7031800（高于 0.7.37 的 7031700，覆盖安装不会判为降级）。
- 验证：13400+ 个单测通过，Android 原生侧 Kotlin 编译通过，发布烟雾测试通过。

逐项记录见仓库 CHANGELOG.md、Issue #21 与 release-manifests/构建与发布.md。
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
