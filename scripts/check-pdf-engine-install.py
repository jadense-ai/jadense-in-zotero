"""普通权限、无开发工具/缓存环境验收真实安装器；HTTP 仅用于模拟断线与 Range。"""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True)
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1] / 'content' / 'pdf-translation'
    archive = Path(args.archive).resolve()
    root = Path(tempfile.mkdtemp(prefix='jadense-engine-ordinary-user-'))
    runtime = root / '普通用户 profile' / 'jadense-pdf-translation'
    runtime.mkdir(parents=True)
    for name in ('worker.py', 'batch_adapter.py', 'progressive_pipeline.py', 'install-bundle.ps1', 'install-network.ps1', 'bundles.json'):
        shutil.copy2(source / name, runtime / name)
    entry = json.loads((source / 'bundles.json').read_text())['windows-x64']
    powershell = str(Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe')
    # 不继承真实 HOME、开发工具 PATH、代理认证或用户包缓存。
    env = {name: os.environ[name] for name in ('SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432') if name in os.environ}
    home = root / 'empty-home'; home.mkdir()
    env.update(PATH=str(Path(os.environ['SystemRoot']) / 'System32'), USERPROFILE=str(home), HOME=str(home),
               LOCALAPPDATA=str(home), APPDATA=str(home), TEMP=str(root), TMP=str(root), PYTHONNOUSERSITE='1', PYTHONIOENCODING='utf-8',
               UV_CACHE_DIR=str(home / 'uv-cache'), UV_PYTHON_INSTALL_DIR=str(home / 'python'))
    checks = []
    def invoke(arguments, expected=0, stdin=None):
        result = subprocess.run(arguments, input=stdin, text=True, encoding='utf-8', errors='replace', env=env, capture_output=True, timeout=600)
        with (root / 'checks.log').open('a', encoding='utf-8') as log:
            log.write(result.stdout + result.stderr + '\n')
        if (result.returncode == 0) != (expected == 0):
            raise AssertionError(result.stdout[-3000:] + result.stderr[-3000:])
        return result
    ordinary = invoke([powershell, '-NoProfile', '-Command', '$p=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()); if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 1}; if(Get-Command uv,python -ErrorAction SilentlyContinue){exit 2}'])
    checks.append('non-admin-no-python-no-uv-empty-user-cache')
    command = [powershell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(runtime / 'install-bundle.ps1'), str(runtime)]
    invoke(command + [str(archive)])
    checks.append('official-offline-archive-installed-in-unicode-space-path')
    python = runtime / 'runtime/python/python.exe'
    def health(expected=0):
        return invoke([str(python), '-s', str(runtime / 'worker.py')], expected, json.dumps({'operation': 'check', 'root': str(runtime)}) + '\n')
    health()
    checks.append('portable-python-model-and-pdf-rendering-offline-check')
    assert not (home / 'uv-cache').exists() and not (home / 'python').exists()
    # 损坏包不得执行或覆盖已安装环境；失败范围仅安装操作。
    bad = root / 'bad.zip'; bad.write_bytes(b'not an engine')
    invoke(command + [str(bad)], expected=1)
    health()
    checks.append('corrupt-archive-rejected-existing-runtime-preserved')
    font = next((runtime / 'runtime/assets/fonts').iterdir())
    saved = font.with_suffix('.saved')
    font.rename(saved)
    try:
        result = health(expected=1)
        assert 'Missing or damaged asset' in result.stdout
        assert not (runtime / 'babeldoc-0.6.4-v1').exists()
    finally:
        saved.rename(font)
    health()
    checks.append('missing-font-detected-without-network-and-marker-cleared')
    ranges = []
    size = archive.stat().st_size
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *values):
            pass
        def do_GET(self):
            offset = int(self.headers.get('Range', 'bytes=0-').split('=')[1].split('-')[0])
            ranges.append(offset)
            self.send_response(206 if offset else 200)
            self.send_header('Content-Length', str(size - offset))
            if offset:
                self.send_header('Content-Range', f'bytes {offset}-{size-1}/{size}')
            self.end_headers()
            with archive.open('rb') as file:
                file.seek(offset)
                if len(ranges) == 1:
                    self.wfile.write(file.read(1024 * 1024)); self.wfile.flush()
                    self.close_connection = True
                    return
                shutil.copyfileobj(file, self.wfile)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    entry['urls'] = [f'http://127.0.0.1:{server.server_port}/engine.zip']
    # 仅隔离目录改为合成 HTTP 源，生产 XPI 清单仍使用 GitHub HTTPS。
    (runtime / 'bundles.json').write_text(json.dumps({'windows-x64': entry}), encoding='utf-8')
    try:
        result = invoke(command)
        assert len(ranges) >= 2 and ranges[1] > 0, ranges
        assert '"stage":"retry"' in result.stdout and '"stage":"download"' in result.stdout
    finally:
        server.shutdown()
    health()
    checks.append('interrupted-download-retried-with-range-and-byte-progress')
    report = {'passed': True, 'root': str(root), 'runtime': str(runtime), 'checks': checks, 'rangeOffsets': ranges,
              'limits': 'Windows current OS; isolated ordinary user environment, not a clean VM. Network recovery uses local fixture, not GitHub availability.'}
    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
