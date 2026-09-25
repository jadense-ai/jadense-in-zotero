"""使用小型模拟引擎测试发布目录清单，不下载模型或访问 GitHub。"""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('package-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class CatalogTest(unittest.TestCase):
    def test_verified_bundle_and_future_release_url(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            file = root / 'engine.zip'
            file.write_bytes(b'fixture')
            entry = {'file': file.name, 'size': file.stat().st_size, 'sha256': release.suite.digest(file), 'platform': 'windows-x64', 'extra': True}
            result = release.prepare_catalog('ocr', entry, root, 'fixture/plugin', 'v1.0.0')
            self.assertTrue(result['published'])
            self.assertEqual(result['urls'], ['https://github.com/fixture/plugin/releases/download/v1.0.0/engine.zip'])
            for patch in ({'file': '../engine.zip'}, {'sha256': 'wrong'}, {'size': 0}, {'platform': 'linux-x64'}):
                with self.assertRaises(ValueError):
                    release.prepare_catalog('ocr', {**entry, **patch}, root, 'fixture/plugin', 'v1.0.0')

class PipelineTest(unittest.TestCase):
    def test_same_bytes_and_source_restoration(self):
        import json
        import subprocess
        import sys
        import zipfile
        from unittest.mock import patch
        for fail_build in (False, True):
            with self.subTest(fail_build=fail_build), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'package.json').write_text('{"version":"1.2.3"}')
                originals = {}
                for kind in ('ocr', 'pdf-translation'):
                    file = root / 'content' / kind / 'bundles.json'
                    file.parent.mkdir(parents=True)
                    file.write_bytes(b'{"windows-x64":{"published":false},"additive":true}')
                    originals[file] = file.read_bytes()
                real_run = subprocess.run
                def run(command, **kwargs):
                    if command[0] == sys.executable:
                        kind = 'ocr' if 'ocr' in command[1] else 'pdf'
                        output = Path(command[-1])
                        archive = output / f'jadense-{kind}-engine-1-windows-x64.zip'
                        with zipfile.ZipFile(archive, 'w') as bundle:
                            bundle.writestr('runtime/python/python.exe', 'synthetic runtime')
                        entry = {'file': archive.name, 'platform': 'windows-x64', 'size': archive.stat().st_size, 'sha256': release.suite.digest(archive)}
                        (output / ('ocr-windows-x64.json' if kind == 'ocr' else 'windows-x64.json')).write_text(json.dumps(entry))
                    elif command[0] == 'node':
                        real_run(['node', str(Path(__file__).with_name('distribution.mjs').resolve()), *command[2:]], check=True)
                    else:
                        if fail_build:
                            raise subprocess.CalledProcessError(1, command)
                        output = root / 'release/zotero/v1.2.3'
                        output.mkdir(parents=True)
                        with zipfile.ZipFile(output / 'jadense-in-zotero-v1.2.3.xpi', 'w') as plugin:
                            plugin.writestr('manifest.json', '{"version":"1.2.3"}')
                            for file in originals:
                                plugin.write(file, file.relative_to(root).as_posix())
                with patch.object(release, 'ROOT', root), patch.object(sys, 'argv', ['package-release.py', '--repository', 'fixture/plugin']), patch.object(release.subprocess, 'run', side_effect=run):
                    if fail_build:
                        with self.assertRaises(subprocess.CalledProcessError):
                            release.main()
                    else:
                        release.main()
                        output = root / 'release/zotero/v1.2.3'
                        with zipfile.ZipFile(output / 'jadense-in-zotero-v1.2.3-windows-x64-offline.zip') as suite:
                            for name in suite.namelist():
                                if name.endswith(('.zip', '.xpi')):
                                    self.assertEqual(suite.read(name), (output / name).read_bytes())
                        with zipfile.ZipFile(output / 'jadense-in-zotero-v1.2.3.xpi') as plugin:
                            entry = json.loads(plugin.read('content/ocr/bundles.json'))['windows-x64']
                            self.assertTrue(entry['published'])
                            self.assertIn('/v1.2.3/', entry['urls'][0])
                        with self.assertRaises(FileExistsError):
                            release.main()
                for file, original in originals.items():
                    self.assertEqual(file.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
