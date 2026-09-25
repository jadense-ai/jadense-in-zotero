"""在 Windows 发布机组装同一批 XPI、引擎和离线套装；源码清单始终恢复。"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('suite', ROOT / 'scripts/build-offline-suite.py')
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)


def prepare_catalog(kind, entry, directory, repository, tag):
    """只有与构建清单摘要匹配的本地引擎才能写入候选 XPI。"""
    name = entry['file']
    if Path(name).name != name or '/' in name or '\\' in name or not name.endswith('.zip'):
        raise ValueError('Invalid engine filename')
    archive = directory / name
    if archive.stat().st_size != entry['size'] or suite.digest(archive) != entry['sha256']:
        raise ValueError(f'{kind} checksum mismatch')
    if entry['platform'] != 'windows-x64':
        raise ValueError('Expected Windows x64 engine')
    return {**entry, 'published': True, 'urls': [f'https://github.com/{repository}/releases/download/{tag}/{name}']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repository', required=True)
    args = parser.parse_args()
    version = json.loads((ROOT / 'package.json').read_text())['version']
    output = ROOT / 'release/zotero' / f'v{version}'
    if (output / f'jadense-in-zotero-v{version}-windows-x64-offline.zip').exists():
        raise FileExistsError('Existing offline release must not be overwritten; use a fresh checkout')
    engines = ROOT / 'release/engines' / f'v{version}'
    engines.mkdir(parents=True, exist_ok=True)
    for script in ('build-pdf-engine.py', 'build-ocr-engine.py'):
        # 每个构建器只清理本次独占临时目录，避免双引擎同时占满托管 runner。
        with tempfile.TemporaryDirectory(prefix='zotero-release-engine-') as temporary:
            subprocess.run([sys.executable, str(ROOT / 'scripts' / script), '--output', str(engines)],
                           env={**os.environ, 'TEMP': temporary, 'TMP': temporary, 'TMPDIR': temporary}, check=True)
    originals = {}
    packages = {}
    try:
        for kind, filename in [('pdf-translation', 'windows-x64.json'), ('ocr', 'ocr-windows-x64.json')]:
            entry = prepare_catalog(kind, json.loads((engines / filename).read_text()), engines, args.repository, f'v{version}')
            target = ROOT / 'content' / kind / 'bundles.json'
            originals[target] = target.read_bytes()
            catalog = json.loads(originals[target])
            catalog['windows-x64'] = entry
            target.write_text(json.dumps(catalog, indent=2) + '\n', encoding='utf-8')
            packages[kind] = engines / entry['file']
        # Windows 通过 cmd 执行固定 pnpm 命令；没有用户输入的 shell 拼接。
        command = ['cmd', '/d', '/c', 'pnpm run build'] if os.name == 'nt' else ['pnpm', 'run', 'build']
        subprocess.run(command, cwd=ROOT, check=True)
        xpi = output / f'jadense-in-zotero-v{version}.xpi'
        offline = suite.build(xpi, packages, output)
        assets = {'xpi': xpi, 'offline': offline}
        for kind, archive in packages.items():
            destination = output / archive.name
            shutil.move(str(archive), destination)
            assets[kind] = destination
        metadata = {'version': version, 'assets': {kind: {'file': file.name, 'size': file.stat().st_size, 'sha256': suite.digest(file)} for kind, file in assets.items()}}
        (output / 'distribution-metadata.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
        (output / 'DISTRIBUTION-SHA256SUMS').write_text(''.join(f'{entry["sha256"]}  {entry["file"]}\n' for entry in metadata['assets'].values()), encoding='utf-8')
        subprocess.run(['node', '.github/scripts/distribution.mjs', str(output), version], cwd=ROOT, check=True)
    finally:
        for file, original in originals.items():
            file.write_bytes(original)


if __name__ == '__main__':
    main()
