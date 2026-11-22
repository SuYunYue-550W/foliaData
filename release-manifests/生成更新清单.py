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

NOTES = """## v0.7.39 · 修复 B站播放与更新下载

本版修掉「B站搜索有结果但点播放报未返回音频」—— 这是三端一致的真实故障，根因是搜索接口只给 bvid、播放却必须有 cid。

- **B站播放修复（重点）**：B站搜索接口 `search/type` 返回 bvid 但不返回 cid，而取流的 `playurl` 必须要有 cid。此前播放器直接 `Number(undefined)` 得到 NaN 就静默返回 null，playurl 请求根本没发出去；上层看到「没抛错但也没地址」就报「B站未返回音频」。现在缺 cid 时按 bvid 调 `view` 接口补齐，并回写避免重复查询；DASH 流的 baseUrl 缺失时回退到 backupUrl。新增回归测试覆盖这条真实路径 —— 旧测试的 fixture 手工塞了 cid，正好掩盖了这个 bug。
- **应用内更新多源回退**：此前清单与发布页都有 GitHub 镜像回退，但应用内下载只传一个附件地址，附件域不通时更新仍然失败。现在同一 APK 派生直连 + 两个加速域名，逐个尝试且共用同一个 SHA-512 —— 换的是路，不是要装的东西；摘要不匹配立即停止。
- **发布质量**：修掉架构边界测试的一个失败（新增注释点名其它平台触发了计数），全量单测 1125 文件 / 13450 用例全绿。
- **Rust EQ 试点**（仅实验，不进生产构建）：一份 Rust 10 段 EQ 与 Android Kotlin DSP 数值等价（误差约 2 个 f32 ulp），cdylib 与 wasm32 两种目标均可构建。是否铺开三端统一 DSP 待真机基准确认。
- 版本号 0.7.39，安卓 versionCode 7031900（高于 0.7.38 的 7031800，覆盖安装不会判为降级）。

逐项记录见仓库 CHANGELOG.md、release-manifests/构建与发布.md 与 experiments/rust-eq-poc/README.md。
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
