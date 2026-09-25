"""隔离普通用户环境验收 OCR 离线包、失败保护、下载续传和搬移后识别。"""
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
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1] / 'content'
    archive = args.archive.resolve()
    root = Path(tempfile.mkdtemp(prefix='jadense-ocr-install-check-'))
    runtime = root / '普通用户 profile' / 'jadense-ocr' / 'v1'
    runtime.mkdir(parents=True)
    for name in ('server.py', 'install-bundle.ps1', 'bundles.json'):
        shutil.copy2(source / 'ocr' / name, runtime / name)
    shutil.copy2(source / 'pdf-translation/install-network.ps1', runtime / 'install-network.ps1')
    entry = json.loads((runtime / 'bundles.json').read_text())['windows-x64']
    powershell = str(Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe')
    env = {name: os.environ[name] for name in ('SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432') if name in os.environ}
    home = root / 'empty-home'; home.mkdir()
    env.update(PATH=str(Path(os.environ['SystemRoot']) / 'System32'), USERPROFILE=str(home), HOME=str(home),
               LOCALAPPDATA=str(home), APPDATA=str(home), TEMP=str(root), TMP=str(root),
               HF_HUB_OFFLINE='1', PYTHONNOUSERSITE='1', PYTHONIOENCODING='utf-8',
               HTTP_PROXY='http://127.0.0.1:9', HTTPS_PROXY='http://127.0.0.1:9')
    checks = []

    def invoke(command, success=True):
        result = subprocess.run(command, env=env, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=900)
        if (result.returncode == 0) != success:
            raise AssertionError((result.stdout + result.stderr)[-6000:])
        return result

    command = [powershell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(runtime / 'install-bundle.ps1'), '-RuntimeDirectory', str(runtime)]
    invoke(command + ['-ArchivePath', str(archive)])
    checks.append('offline-install-with-no-system-python-uv-cache-and-invalid-proxy')
    python = runtime / 'runtime/python/python.exe'
    health = [str(python), '-s', str(runtime / 'server.py'), '--verify-models', str(runtime / 'runtime')]
    invoke(health)
    checks.append('relocated-python-models-and-real-recognition')
    bad = root / 'bad.zip'; bad.write_bytes(b'corrupt')
    invoke(command + ['-ArchivePath', str(bad)], success=False)
    invoke(health)
    checks.append('bad-archive-retains-healthy-runtime')
    ranges = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *values):
            pass

        def do_GET(self):
            offset = int(self.headers.get('Range', 'bytes=0-').split('=')[1].split('-')[0])
            ranges.append(offset)
            size = archive.stat().st_size
            self.send_response(206 if offset else 200)
            self.send_header('Content-Length', str(size - offset))
            if offset:
                self.send_header('Content-Range', f'bytes {offset}-{size-1}/{size}')
            self.end_headers()
            with archive.open('rb') as stream:
                stream.seek(offset)
                if len(ranges) == 1:
                    self.wfile.write(stream.read(1024 * 1024)); self.wfile.flush()
                    self.close_connection = True
                    return
                shutil.copyfileobj(stream, self.wfile)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    # 只在隔离测试目录标记公开，生产清单保持未发布。
    entry.update(published=True, urls=[f'http://127.0.0.1:{server.server_port}/engine.zip'], additive='ignored')
    (runtime / 'bundles.json').write_text(json.dumps({'windows-x64': entry}), encoding='utf-8')
    env.update(NO_PROXY='127.0.0.1')
    try:
        invoke(command)
        assert len(ranges) >= 2 and ranges[1] > 0, ranges
    finally:
        server.shutdown()
    invoke(health)
    checks.append('ordinary-download-resumes-after-interruption-and-installs')
    args.report.write_text(json.dumps({'root': str(root), 'checks': checks, 'ranges': ranges}, indent=2), encoding='utf-8')
    print(json.dumps(checks))


if __name__ == '__main__':
    main()
