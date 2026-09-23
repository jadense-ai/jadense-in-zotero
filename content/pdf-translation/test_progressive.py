"""真实引擎故障/冷重启回归；仅发送合成译文，显式指定本地资产后运行。"""
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import tempfile
import threading
import unittest

import pymupdf
from test_worker import fixture, WORKER
from progressive_pipeline import restore_document, clone_document


class CheckpointTests(unittest.TestCase):
    def test_clone_materializes_long_graphics_chains_without_recursive_copy(self):
        from babeldoc.format.pdf.document_il import il_version_1 as il
        from babeldoc.format.pdf.document_il.frontend.il_creater_active_support import (
            PassthroughSnapshot, append_passthrough_instruction, LazyPassthroughInstruction,
        )
        snapshot = PassthroughSnapshot()
        for _ in range(2500):
            snapshot = append_passthrough_instruction(snapshot, ('w', '1'))
        lazy = LazyPassthroughInstruction(snapshot, suffix_parts=('q',))
        original = il.Document(page=[il.Page(pdf_character=[il.PdfCharacter(pdf_style=il.PdfStyle(
            graphic_state=il.GraphicState(passthrough_per_char_instruction=lazy)))])], total_pages=1)
        limit = sys.getrecursionlimit()
        cloned = clone_document(original)
        instructions = cloned.page[0].pdf_character[0].pdf_style.graphic_state.passthrough_per_char_instruction
        self.assertIsInstance(instructions, str)
        self.assertEqual(instructions.count('1 w'), 2500)
        self.assertTrue(instructions.endswith('q'))
        self.assertEqual(sys.getrecursionlimit(), limit)
        cloned.page[0].pdf_character.clear()
        self.assertEqual(len(original.page[0].pdf_character), 1)
        self.assertIs(original.page[0].pdf_character[0].pdf_style.graphic_state.passthrough_per_char_instruction, lazy)

    def test_round_trip_uses_dataclass_names_and_ignores_additive_fields(self):
        from babeldoc.format.pdf.document_il import il_version_1 as il
        from babeldoc.format.pdf.document_il.xml_converter import XMLConverter
        document = il.Document(page=[il.Page(pdf_font=[il.PdfFont(font_id='F1')], page_number=0)], total_pages=1)
        payload = json.loads(XMLConverter().to_json(document))
        payload['future'] = True
        payload['page'][0]['future'] = 'ignored'
        restored = restore_document(il.Document, payload)
        self.assertEqual(restored, document)


@unittest.skipUnless(os.environ.get('JADENSE_TEST_PDF_ASSETS'), 'requires local BabelDOC assets')
class ProgressiveEngineTests(unittest.TestCase):
    def test_partial_cancel_restart_and_corrupt_layout(self):
        with tempfile.TemporaryDirectory(prefix='jdx-progressive-test-') as folder:
            root = Path(folder)
            source = root / 'source.pdf'
            fixture(source)
            original = source.read_bytes()
            config = dict(root=str(root), source=str(source), directory=str(root / 'task'),
                          assetRoot=os.environ['JADENSE_TEST_PDF_ASSETS'], layoutIdentity=[1, 'TEST'],
                          fingerprint=hashlib.sha256(original).hexdigest(), configuration='test',
                          sourceLanguage='en', targetLanguage='zh-CN', machine=True, workers=1)

            def execute(mode):
                # 统计真正解析入口，而非依靠 UI 阶段字符串推断是否重复解析。
                code = (f"import sys; sys.path.insert(0, {str(WORKER.parent)!r}); import worker; "
                        f"worker.setup_cache({str(root)!r}, {config['assetRoot']!r}); "
                        "from babeldoc.format.pdf.new_parser import native_parse; "
                        "original=native_parse.parse_prepared_pdf_with_new_parser_to_legacy_ir; "
                        "native_parse.parse_prepared_pdf_with_new_parser_to_legacy_ir=lambda *a,**k: (worker.emit(type='test_parse'),original(*a,**k))[1]; "
                        "worker.main()")
                if mode == 'render-fail':
                    code = code.replace('worker.main()', "from babeldoc.format.pdf.document_il.backend.pdf_creater import PDFCreater; PDFCreater.write=lambda *a,**k: (_ for _ in ()).throw(OSError('synthetic render failure')); worker.main()")
                events, requests = [], []
                with (root / f'{mode}.log').open('w', encoding='utf-8') as log:
                    child = subprocess.Popen([sys.executable, '-u', '-c', code], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                             stderr=log, text=True, encoding='utf-8', env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
                    lines = queue.Queue()
                    def read():
                        for line in child.stdout: lines.put(line)
                        lines.put(None)
                    threading.Thread(target=read, daemon=True).start()
                    def send(value):
                        child.stdin.write(json.dumps(value) + '\n'); child.stdin.flush()
                    send(config)
                    try:
                        while True:
                            line = lines.get(timeout=90)
                            if line is None: break
                            if not line.startswith('{'): continue  # 上游导入的弃用提示不属于协议。
                            event = json.loads(line); events.append(event)
                            if mode == 'crash' and event.get('stage') == 'translation' and event.get('completed', 0) > 0:
                                child.kill()
                                break
                            if event['type'] == 'translate':
                                self.assertTrue(any(e['type'] == 'artifact' for e in events), 'must publish before requests')
                                requests.append(event['text'])
                                if mode == 'zero' or (mode in ('cancel', 'fail') and len(requests) == 2):
                                    if mode == 'cancel': send(dict(type='cancel'))
                                    else: send(dict(id=event['id'], error=dict(code='PROVIDER_FAILED', stop=True)))
                                else:
                                    parts = re.split(r'(<[^>]+>|\{[^}]+\})', event['text'])
                                    translated = ''.join(part if part.startswith(('<', '{')) else re.sub(r'[A-Za-z][A-Za-z ,.]+', 'TranslatedEvidence.', part) for part in parts)
                                    send(dict(id=event['id'], text=translated))
                        code = child.wait(timeout=10)
                        if mode not in ('crash', 'render-fail'):
                            self.assertEqual(code, 0, (root / f'{mode}.log').read_text(encoding='utf-8')[-3000:])
                        else:
                            self.assertNotEqual(code, 0)
                    finally:
                        if child.poll() is None: child.kill(); child.wait()
                        child.stdin.close(); child.stdout.close()
                if mode not in ('crash', 'render-fail'): self.assertTrue(any(e['type'] == 'complete' for e in events))
                self.assertEqual(source.read_bytes(), original)
                return events, requests

            for stop_mode in ('cancel', 'fail'):
                config['directory'] = str(root / stop_mode)
                events, first = execute(stop_mode)
                self.assertEqual(sum(e['type'] == 'test_parse' for e in events), 1 if stop_mode == 'cancel' else 0)
                artifact = json.loads((Path(config['directory']) / 'artifact.json').read_text())
                self.assertEqual(artifact['coverage']['translated'], 1)
                self.assertGreater(artifact['coverage']['failed'], 0)
                with pymupdf.open(Path(config['directory']) / f"{artifact['revision']}-mono.pdf") as pdf:
                    self.assertIn('TranslatedEvidence.', pdf[0].get_text())
                    self.assertIn('Scientific methods', pdf[0].get_text())
                    self.assertEqual(len(pdf), 3)
                    self.assertEqual(pdf[2].rect.width, 800)
                resumed, remaining = execute('resume-' + stop_mode)
                self.assertEqual(sum(e['type'] == 'test_parse' for e in resumed), 0)
                self.assertNotIn(first[0], remaining)
                self.assertTrue(any(e.get('stage') == 'layout_cached' for e in resumed))
                final = resumed[-1]
                self.assertEqual(final['coverage']['failed'], 0, final['coverage'])
                again, requests = execute('complete-' + stop_mode)
                self.assertEqual(requests, [])
                self.assertEqual(sum(e['type'] == 'test_parse' for e in again), 0)

            manifest = next((root / 'layouts').glob('*/layout.json'))
            manifest.write_text('{}')
            repaired, requests = execute('corrupt')
            self.assertEqual(sum(e['type'] == 'test_parse' for e in repaired), 1)
            self.assertEqual(requests, [])

            for fault in ('zero', 'crash', 'render-fail'):
                config['directory'] = str(root / fault)
                events, sent = execute(fault)
                self.assertEqual(sum(e['type'] == 'test_parse' for e in events), 0)
                artifact = json.loads((Path(config['directory']) / 'artifact.json').read_text())
                with pymupdf.open(Path(config['directory']) / f"{artifact['revision']}-mono.pdf") as pdf:
                    self.assertEqual(len(pdf), 3)
                resumed, remaining = execute('recover-' + fault)
                self.assertEqual(sum(e['type'] == 'test_parse' for e in resumed), 0)
                self.assertEqual(resumed[-1]['coverage']['failed'], 0)
                if fault == 'crash': self.assertNotIn(sent[0], remaining)
                if fault == 'render-fail': self.assertEqual(remaining, [])

            with pymupdf.open(source) as pdf:
                pdf.set_metadata({'subject': 'changed source'})
                pdf.saveIncr()
            original = source.read_bytes()
            config['fingerprint'] = hashlib.sha256(original).hexdigest()
            changed, _ = execute('changed-source')
            self.assertEqual(sum(e['type'] == 'test_parse' for e in changed), 1)


if __name__ == '__main__':
    unittest.main()
