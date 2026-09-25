"""构建独立 OCR Python 与模型包；仅收集全新构建目录，不读取用户 profile。"""
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
    parser.add_argument('--model-source', choices=['default', 'modelscope', 'hf-mirror'], default='modelscope')
    args = parser.parse_args()
    if platform.system() != 'Windows' or platform.machine().lower() not in ('amd64', 'x86_64'):
        raise SystemExit('This build currently targets Windows x64.')
    source = Path(__file__).resolve().parents[1] / 'content' / 'ocr'
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    build = Path(tempfile.mkdtemp(prefix='jadense-ocr-engine-build-'))
    print(f'Build directory: {build}', flush=True)
    project = build / 'project'
    project.mkdir()
    for name in ('pyproject.toml', 'uv.lock', 'server.py'):
        shutil.copy2(source / name, project / name)
    env = {**os.environ, 'UV_PROJECT_ENVIRONMENT': str(project / '.venv'),
           'PYTHONNOUSERSITE': '1', 'HF_HUB_DISABLE_IMPLICIT_TOKEN': '1',
           'HF_HOME': str(project / 'models'), 'JADENSE_OCR_MODEL_SOURCE': args.model_source,
           'JADENSE_OCR_SETUP_PROGRESS': '1'}
    for name in ('PYTHONPATH', 'PYTHONHOME', 'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN'):
        env.pop(name, None)
    subprocess.run(['uv', 'sync', '--project', str(project), '--python', '3.12', '--managed-python', '--frozen', '--no-config'], env=env, check=True)
    python = project / '.venv/Scripts/python.exe'
    subprocess.run([str(python), '-s', str(project / 'server.py'), '--prepare-models', str(project)], env=env, check=True)
    info = json.loads(subprocess.check_output([str(python), '-I', '-c', 'import sys,sysconfig,json; print(json.dumps([sys.base_prefix,sysconfig.get_path("purelib")]))'], text=True))
    payload = build / 'runtime'
    shutil.copytree(info[0], payload / 'python', ignore=shutil.ignore_patterns('__pycache__', '*.pyc', 'site-packages'))
    shutil.copytree(info[1], payload / 'python/Lib/site-packages', dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    shutil.copytree(project / 'models', payload / 'models', ignore=shutil.ignore_patterns('.locks', '.cache', '*.lock', '*.incomplete'))
    for name in ('uv.lock', 'pyproject.toml', 'server.py'):
        shutil.copy2(source / name, payload / name)
    shutil.copytree(source / 'licenses', payload / 'licenses')
    # 移动环境后重新真实识别；不携带开发路径绑定的就绪凭据。
    subprocess.run([str(payload / 'python/python.exe'), '-s', str(payload / 'server.py'), '--verify-models', str(payload)], env={**env, 'HF_HUB_OFFLINE': '1'}, check=True)
    (payload / 'models-ready.json').unlink(missing_ok=True)
    metadata = {'version': 'ocr-engine-2.126.0-3.9.2-1', 'engine': 'docling-2.126.0-rapidocr-3.9.2', 'platform': 'windows-x64'}
    (payload / 'bundle.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
    archive = output / f'jadense-{metadata["version"]}-windows-x64.zip'
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for file in sorted(payload.rglob('*')):
            if file.is_file():
                bundle.write(file, file.relative_to(payload).as_posix())
    with archive.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    entry = {**metadata, 'published': False, 'file': archive.name, 'size': archive.stat().st_size, 'sha256': digest, 'urls': []}
    (output / 'ocr-windows-x64.json').write_text(json.dumps(entry, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'build': str(build), 'artifact': str(archive), **entry}), flush=True)


if __name__ == '__main__':
    main()
