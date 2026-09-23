"""在构建机生成可移植离线引擎；只收集新建环境和校验过的资源，不打包用户 profile。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--assets', help='Optional previously downloaded assets; worker verifies every asset')
    parser.add_argument('--tag', default='pdf-engine-0.6.4-1')
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1] / 'content' / 'pdf-translation'
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    target = {'Windows': 'windows', 'Darwin': 'macos', 'Linux': 'linux'}[platform.system()]
    arch = {'AMD64': 'x64', 'x86_64': 'x64', 'arm64': 'arm64', 'aarch64': 'arm64'}[platform.machine()]
    target += '-' + arch
    # 新建目录无现有用户数据；保留构建目录供复核，禁止覆盖已有制品。
    build = Path(tempfile.mkdtemp(prefix='jadense-pdf-engine-build-'))
    project = build / 'project'
    project.mkdir()
    for name in ('pyproject.toml', 'uv.lock', 'worker.py', 'batch_adapter.py', 'progressive_pipeline.py'):
        shutil.copy2(source / name, project / name)
    env = {**os.environ, 'UV_PROJECT_ENVIRONMENT': str(project / '.venv'), 'PYTHONNOUSERSITE': '1'}
    for name in ('PYTHONPATH', 'PYTHONHOME'):
        env.pop(name, None)
    subprocess.run(['uv', 'sync', '--project', str(project), '--python', '3.12', '--managed-python', '--frozen', '--no-config'], env=env, check=True)
    python = project / '.venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    info = json.loads(subprocess.check_output([str(python), '-I', '-c', 'import sys,sysconfig,json; print(json.dumps([sys.base_prefix,sysconfig.get_path("purelib")]))'], text=True))
    payload = build / 'runtime'
    shutil.copytree(info[0], payload / 'python', ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    packages = payload / 'python' / ('Lib/site-packages' if os.name == 'nt' else 'lib/python3.12/site-packages')
    shutil.copytree(info[1], packages, dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    if args.assets:
        # 只复制资产白名单；后续 prepare/check 以 BabelDOC 元数据校验。
        for name in ('fonts', 'models', 'cmap', 'tiktoken'):
            location = Path(args.assets) / name
            if location.is_dir():
                shutil.copytree(location, project / 'assets' / name)
    request = json.dumps({'operation': 'prepare', 'root': str(project)}) + '\n'
    subprocess.run([str(python), '-s', str(project / 'worker.py')], input=request, text=True, env=env, check=True)
    shutil.copytree(project / 'assets', payload / 'assets', ignore=shutil.ignore_patterns('*.db', '*.log', '__pycache__'))
    # 保留包内许可证和锁定源码地址，随二进制附发布所需来源清单。
    shutil.copy2(source / 'uv.lock', payload / 'uv.lock')
    shutil.copy2(source / 'LICENSE', payload / 'LICENSE-BabelDOC')
    metadata = {'version': args.tag, 'engine': 'babeldoc-0.6.4-v1', 'platform': target}
    (payload / 'bundle.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    portable = payload / 'python' / ('python.exe' if os.name == 'nt' else 'bin/python3')
    # 移动后的独立 Python 在禁用用户 site 的进程中运行真实离线检查。
    request = json.dumps({'operation': 'check', 'root': str(project), 'assetRoot': str(payload / 'assets')}) + '\n'
    subprocess.run([str(portable), '-s', str(project / 'worker.py')], input=request, text=True, env=env, check=True)
    filename = f'jadense-{args.tag}-{target}.zip'
    archive = output / filename
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for file in sorted(payload.rglob('*')):
            if file.is_file():
                bundle.write(file, file.relative_to(payload).as_posix())
    digest = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
    entry = {**metadata, 'file': filename, 'size': archive.stat().st_size, 'sha256': digest,
             'urls': [f'https://github.com/jadense-ai/jadense-in-zotero/releases/download/{args.tag}/{filename}']}
    (output / f'{target}.json').write_text(json.dumps(entry, indent=2) + '\n', encoding='utf-8')
    (output / f'{filename}.sha256').write_text(f'{digest}  {filename}\n', encoding='utf-8')
    print(json.dumps({'build': str(build), 'artifact': str(archive), **entry}), flush=True)


if __name__ == '__main__':
    main()
