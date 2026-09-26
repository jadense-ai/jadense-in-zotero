"""将已经核验的 XPI 和两种引擎组成离线套装；不上传、不包含用户配置。"""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def build(xpi, engines, output):
    """清单来自 XPI；拒绝不匹配的可执行包，附加清单字段不影响组装。"""
    with zipfile.ZipFile(xpi) as plugin:
        version = json.loads(plugin.read('manifest.json'))['version']
        catalogs = {kind: json.loads(plugin.read(f'content/{kind}/bundles.json')) for kind in engines}
    files = {xpi.name: xpi}
    for kind, file in engines.items():
        entry = catalogs[kind]['windows-x64']
        if file.stat().st_size != entry['size'] or digest(file) != entry['sha256']:
            raise ValueError(f'{kind} package does not match the XPI catalog')
        files[entry['file']] = file
    guide = '''# Windows x64 完整离线套装

本目录包含匹配版本的 XPI、PDF 版面引擎 ZIP 和本机 OCR 引擎 ZIP。

1. 从官方 Release 下载完整离线套装 ZIP，解压到本地目录；其中两个引擎 ZIP 保持原样。
2. Zotero → 工具 → 插件 → 齿轮菜单 → 从文件安装插件，选择本目录 XPI，然后重启 Zotero。
3. 插件设置 → 外置依赖配置 → 版面解析引擎 → 导入离线包，选择本目录 `jadense-pdf-engine-*.zip` 并等待就绪。
4. 同页本机 OCR → 导入离线包，选择 `jadense-ocr-engine-*.zip` 并等待识别检查完成。

两个引擎可按需独立安装；无需管理员、系统 Python、uv 或在线安装依赖。建议预留 6 GiB 空间用于下载包、解压和安装过程中的临时文件。
插件更新不要求重复安装同版本健康引擎。模型、引擎与插件各自版本以包内清单为准。
本套装包含全文 OCR 模型；选文公式专用 CodeFormulaV2 仍为首次使用时下载的可选组件。
AI 翻译仍需要配置可用的翻译服务和网络；离线安装不等于离线 AI 翻译。
仅 Windows x64；macOS、Linux、Windows ARM64 使用普通插件的现有安装流程。
插件启动安装器时已对该 PowerShell 进程使用 `-ExecutionPolicy Bypass`，通常不需要用户修改执行策略。若提示脚本被禁止运行，打开 PowerShell 执行 `Get-ExecutionPolicy -List`；`MachinePolicy` / `UserPolicy` 不为 `Undefined` 时，记录该结果和安装日志，交给设备策略维护者放行本插件的安装脚本及引擎。若两项均为 `Undefined`，当前用户的执行策略无需修改；检查下方的程序拦截记录，手动运行安装器时按指南使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ...`。
若提示无法写入或程序被拦截，打开 Windows 安全中心 → 病毒和威胁防护 → 保护历史记录，查看被拦程序路径；若是受控文件夹访问，可在“允许应用通过受控文件夹访问”中允许该程序。若是 AppLocker/WDAC，记录事件查看器中的阻止记录，由设备策略维护者放行具体脚本或程序。
安装失败先检查磁盘空间和上述拦截记录，再重新导入原始引擎 ZIP；不要将引擎 ZIP 解压到 Zotero 文献目录。
'''
    output.mkdir(parents=True, exist_ok=True)
    target = output / f'jadense-in-zotero-v{version}-windows-x64-offline.zip'
    with zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_STORED) as suite:
        for name, file in files.items():
            suite.write(file, name)
        suite.writestr('安装指南.md', guide)
    (output / (target.name + '.sha256')).write_text(f'{digest(target)}  {target.name}\n', encoding='utf-8')
    return target


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--xpi', type=Path, required=True)
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--ocr', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(build(args.xpi, {'pdf-translation': args.pdf, 'ocr': args.ocr}, args.output))


if __name__ == '__main__':
    main()
