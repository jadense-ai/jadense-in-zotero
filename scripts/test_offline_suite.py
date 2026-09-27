"""发布套装必须与 XPI 信任清单一致，不能混入错误版本的可执行环境。"""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('suite', Path(__file__).with_name('build-offline-suite.py'))
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)


class OfflineSuiteTest(unittest.TestCase):
    def test_matching_packages_and_additive_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engines = {}
            xpi = root / 'plugin.xpi'
            with zipfile.ZipFile(xpi, 'w') as plugin:
                plugin.writestr('manifest.json', json.dumps({'version': '1.2.3'}))
                for kind in ('ocr', 'pdf-translation'):
                    file = root / f'{kind}.zip'; file.write_bytes(kind.encode())
                    engines[kind] = file
                    entry = {'file': file.name, 'size': file.stat().st_size, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'future': {}}
                    plugin.writestr(f'content/{kind}/bundles.json', json.dumps({'windows-x64': entry}))
            guide_path = root / '安装流程.pdf'
            guide_bytes = b'%PDF-1.7\nfixture guide bytes\n%%EOF'
            guide_path.write_bytes(guide_bytes)
            target = suite.build(xpi, engines, root / 'output', guide_path)
            with zipfile.ZipFile(target) as bundle:
                self.assertEqual(set(bundle.namelist()), {'plugin.xpi', 'ocr.zip', 'pdf-translation.zip', '安装流程.pdf'})
                self.assertEqual(bundle.read('安装流程.pdf'), guide_bytes)
            engines['ocr'].write_bytes(b'wrong executable')
            with self.assertRaises(ValueError):
                suite.build(xpi, engines, root / 'bad')
            self.assertFalse((root / 'bad').exists())


if __name__ == '__main__':
    unittest.main()
