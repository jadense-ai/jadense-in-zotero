"""用深层普通用户 profile 复现两种离线安装器的 Windows 长路径解压边界。"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile


SOURCE = Path(__file__).resolve().parents[1] / 'content'


@unittest.skipUnless(os.name == 'nt', 'Windows PowerShell installer only')
class BundleInstallPathTest(unittest.TestCase):
    def test_user_selected_package_extracts_past_old_staging_limit(self):
        """旧随机目录会超出 MAX_PATH；新目录须进入离线检查且不覆盖旧环境。"""
        powershell = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
        with tempfile.TemporaryDirectory(prefix='jadense-bundle-path-') as temporary:
            base = Path(temporary)
            for kind, stage in [('ocr', 'offline'), ('pdf-translation', 'check')]:
                suffix = Path('普通用户 profile') / kind
                padding = 'p' * max(1, 94 - len(str(base)) - len(str(suffix)) - 2)
                root = base / padding / suffix
                root.mkdir(parents=True)
                source = SOURCE / kind
                for name in ('install-bundle.ps1', 'install-network.ps1'):
                    shutil.copy2((SOURCE / 'pdf-translation' if name == 'install-network.ps1' else source) / name, root / name)
                (root / 'bundles.json').write_text(json.dumps({'windows-x64': {'file': 'another.zip', 'sha256': '0' * 64}}), encoding='utf-8')
                runtime = root / 'runtime'
                runtime.mkdir()
                (runtime / 'previous.txt').write_text('keep', encoding='utf-8')
                member = 'python/Lib/site-packages/sample/' + 'a' * 106 + '.dat'
                self.assertGreater(len(str(root / ('bundle-stage-' + '0' * 32) / member)), 260)
                self.assertLess(len(str(root / ('s-' + '0' * 8) / member)), 260)
                archive = base / (kind + '.zip')
                with zipfile.ZipFile(archive, 'w') as bundle:
                    bundle.writestr(member, b'fixture')
                command = [str(powershell), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(root / 'install-bundle.ps1')]
                command += ['-RuntimeDirectory', str(root), '-ArchivePath', str(archive)] if kind == 'ocr' else [str(root), str(archive)]
                result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60)
                output = result.stdout + result.stderr
                self.assertNotEqual(result.returncode, 0, output)
                self.assertIn('"stage":"' + stage + '"', output)
                self.assertNotIn('Could not find a part of the path', output)
                self.assertEqual((runtime / 'previous.txt').read_text(encoding='utf-8'), 'keep')


if __name__ == '__main__':
    unittest.main()
