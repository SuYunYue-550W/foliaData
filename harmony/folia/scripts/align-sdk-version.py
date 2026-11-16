"""把工程里的 SDK/hvigor 版本与本机解压的 Command Line Tools 对齐。

用法：
  python harmony/folia/scripts/align-sdk-version.py <command-line-tools 根目录>

Command Line Tools 自带 hvigor 与 ohos 插件，模板里有真实版本号；本脚本扫描解压目录，
找出 @ohos/hvigor-ohos-plugin 的版本与 hvigor 版本，写回工程的 hvigor/hvigor-config.json5。
同时打印可用的 SDK 版本目录，供人工核对 build-profile.json5 的 compatibleSdkVersion。
只读 SDK 目录、只改工程的 hvigor-config.json5，不联网、不删除任何文件。
"""
import json
import re
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
CFG = PROJECT / 'hvigor' / 'hvigor-config.json5'


def find_plugin_versions(root: Path) -> dict:
    """在 SDK 目录里找 @ohos/hvigor(-ohos-plugin) 的版本。

    两种写法都要认：
      1) package.json 里 "name": "@ohos/hvigor-ohos-plugin" + "version": "6.26.21"（分开字段）
      2) 依赖声明 "@ohos/hvigor-ohos-plugin": "6.26.21"（键值同现）
    """
    found = {}
    for name in ('package.json', 'oh-package.json5'):
        for p in root.rglob(name):
            try:
                txt = p.read_text(encoding='utf-8', errors='ignore')
            except OSError:
                continue
            # 写法 1：name + version 配对（只在小 package.json 上做，避免误配到大依赖清单）
            nm = re.search(r'["\']name["\']\s*:\s*["\'](@ohos/hvigor(?:-ohos-plugin)?)["\']', txt)
            if nm and len(txt) < 20000:
                vm = re.search(r'["\']version["\']\s*:\s*["\']([\d.]+)["\']', txt)
                if vm:
                    found.setdefault(nm.group(1), set()).add(vm.group(1))
            # 写法 2：依赖键值
            for m in re.finditer(r'["\'](@ohos/hvigor(?:-ohos-plugin)?)["\']\s*:\s*["\']([\d.]+)["\']', txt):
                found.setdefault(m.group(1), set()).add(m.group(2))
    return found


def main() -> int:
    if len(sys.argv) < 2:
        print('usage: align-sdk-version.py <command-line-tools-root>', file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    if not root.is_dir():
        print(f'not a directory: {root}', file=sys.stderr)
        return 2

    # 版本信息集中在 hvigor 子目录，限定搜索范围避免扫描整个 SDK 的 node_modules（很慢）
    search_root = root / 'hvigor' if (root / 'hvigor').is_dir() else root
    versions = find_plugin_versions(search_root)
    print('[found in SDK]')
    for k, vals in sorted(versions.items()):
        print(f'  {k}: {sorted(vals)}')

    plugin = versions.get('@ohos/hvigor-ohos-plugin', set())
    hvigor = versions.get('@ohos/hvigor', set())
    if not plugin and not hvigor:
        print('未在 SDK 里找到版本号，保持 hvigor-config.json5 不变（构建时按报错调整）')
        return 0

    # 26.0.1 (all-in-one) 模式：插件内置，dependencies 必须留空，不能写版本号进去，
    # 否则 hvigor 会拿这个版本去 npm 拉私有包而 404（见 hvigor 错误码 00308003）。
    # 所以这里只报告检测到的版本，不再改写配置文件。
    print('[info] all-in-one 模式：hvigor-config.json5 的 dependencies 保持空对象，'
          '不写入私有包版本（避免 hvigor 去 npm 拉取失败）')
    text = CFG.read_text(encoding='utf-8')
    if '"dependencies": {}' not in text:
        text = re.sub(r'"dependencies"\s*:\s*\{[^}]*\}', '"dependencies": {}', text, count=1)
        CFG.write_text(text, encoding='utf-8', newline='\n')
        print('[align] 已将 dependencies 置空')

    # 打印 SDK 版本目录供核对 compatibleSdkVersion
    print('[SDK platforms]')
    for d in sorted(root.rglob('*')):
        if d.is_dir() and re.match(r'^\d+\.\d+\.\d+\(\d+\)$', d.name):
            print('  ', d.relative_to(root))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
