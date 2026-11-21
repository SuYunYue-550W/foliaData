#!/usr/bin/env python3
"""发布烟雾测试：清单里的每个地址都要真的能下载，且大小与本地一致。

v0.7.37 出过一次这样的事：清单里的 APK 名字用的是本地文件名（app-release.apk），
而真正上传的附件叫 Folia-Android-0.7.37.apk —— 地址 404，安卓应用内更新下不了，
而发版当时的检查只看了「清单字段能不能解析」，没看地址通不通。

这个脚本补上那一层：拿清单里的地址真去请求一次，比对状态码与大小。
清单是给**别的机器**用的，所以要对着线上那份查，不是本地文件。

用法：
    python release-manifests/烟雾测试.py --tag v0.7.37
    python release-manifests/烟雾测试.py --tag v0.7.37 --manifest release-manifests/update.json
"""
import argparse
import json
import sys
import urllib.request
from pathlib import Path

DEFAULT_RELEASES = 'https://github.com/SuYunYue-550W/foliaData/releases'


def http_size(url: str, timeout: int = 60) -> tuple[int, int]:
    """返回 (状态码, 内容长度)。带重定向。"""
    request = urllib.request.Request(url, method='GET', headers={'User-Agent': 'folia-smoke'})
    request.add_header('Range', 'bytes=0-0')
    with urllib.request.urlopen(request, timeout=timeout) as response:
        length = response.headers.get('Content-Range')
        if length and '/' in length:
            return response.status, int(length.split('/')[-1])
        return response.status, int(response.headers.get('Content-Length') or 0)


def check(url: str, expected_size: int, label: str) -> bool:
    try:
        status, size = http_size(url)
    except Exception as error:  # noqa: BLE001 - 任何失败都要报出来
        print(f'  ✗ {label}: 请求失败 {error}')
        return False
    if status not in (200, 206):
        print(f'  ✗ {label}: HTTP {status}')
        return False
    if expected_size and size and size != expected_size:
        print(f'  ✗ {label}: 大小不符 远端 {size} B != 清单 {expected_size} B')
        return False
    print(f'  ✓ {label}: HTTP {status} | {size} B')
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--tag', required=True, help='Release 标签，例如 v0.7.37')
    parser.add_argument('--manifest', default=None, help='本地清单路径；默认取线上的')
    parser.add_argument('--releases', default=DEFAULT_RELEASES, help='Release 根地址')
    args = parser.parse_args()

    if args.manifest:
        manifest = json.loads(Path(args.manifest).read_text(encoding='utf-8'))
        source = str(args.manifest)
    else:
        url = f'{args.releases}/latest/download/update.json'
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'folia-smoke'}), timeout=30) as response:
            manifest = json.loads(response.read().decode('utf-8'))
        source = url

    print(f'清单来源: {source}')
    print(f'  版本: {manifest.get("version")}')

    ok = True
    urls: list[tuple[str, str, int]] = []
    download_url = manifest.get('download_url')
    if isinstance(download_url, str) and download_url:
        urls.append(('download_url', download_url, int(manifest.get('size') or 0)))
    for asset in manifest.get('assets') or []:
        url = asset.get('browser_download_url')
        if isinstance(url, str) and url:
            urls.append((asset.get('name') or url, url, int(asset.get('size') or 0)))

    for label, url, size in urls:
        ok = check(url, size, label) and ok

    if not urls:
        print('  ✗ 清单里没有任何下载地址')
        return 1
    print('烟雾测试通过' if ok else '烟雾测试失败')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
