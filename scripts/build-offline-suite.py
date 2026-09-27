"""将已经核验的 XPI 和两种引擎组成离线套装；不上传、不包含用户配置。"""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def build(xpi, engines, output, guide=None):
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
    # 用户提供的 PDF 按原始字节分发，替代旧的自动生成 Markdown 指南。
    guide = Path(guide) if guide else Path(__file__).resolve().parents[1] / 'docs' / 'jadense-in-zotero 离线安装详细流程.pdf'
    guide_bytes = guide.read_bytes()
    output.mkdir(parents=True, exist_ok=True)
    target = output / f'jadense-in-zotero-v{version}-windows-x64-offline.zip'
    with zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_STORED) as suite:
        for name, file in files.items():
            suite.write(file, name)
        suite.writestr(guide.name, guide_bytes)
    (output / (target.name + '.sha256')).write_text(f'{digest(target)}  {target.name}\n', encoding='utf-8')
    return target


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--xpi', type=Path, required=True)
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--ocr', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--guide', type=Path, help='PDF installation guide; defaults to the maintained guide')
    args = parser.parse_args()
    print(build(args.xpi, {'pdf-translation': args.pdf, 'ocr': args.ocr}, args.output, args.guide))


if __name__ == '__main__':
    main()
