"""真实 PDF 产物与 stdio 引擎回归；测试数据为合成论文，不访问付费 Provider。"""
import hashlib
import asyncio
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import pymupdf as fitz

WORKER = Path(__file__).with_name("worker.py")
spec = importlib.util.spec_from_file_location("worker", WORKER)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def fixture(path):
    document = fitz.open()
    page = document.new_page(width=600, height=800)
    page.insert_text((40, 50), "Bilingual PDF experiment", fontsize=18)
    for column in (40, 320):
        for row in range(15):
            page.insert_text((column, 100 + row * 22), "Scientific methods preserve evidence.", fontsize=10)
    page.draw_rect(fitz.Rect(40, 460, 270, 570), color=(0, .5, .2))
    page.insert_text((40, 600), "Figure 1. Experiment results.", fontsize=10)
    page.insert_text((40, 640), "E = mc2", fontsize=12)
    page = document.new_page(width=600, height=800)
    page.draw_rect(fitz.Rect(80, 100, 400, 650), fill=(.8, .8, .8))
    page = document.new_page(width=600, height=800)
    page.insert_text((40, 80), "Rotation preserves the page identity.", fontsize=12)
    page.set_rotation(90)
    document.save(path)
    document.close()


class PDFOutputTests(unittest.TestCase):
    def test_offline_check_accepts_powershell_utf8_bom_on_first_message(self):
        with tempfile.TemporaryDirectory() as directory:
            request = '\ufeff' + json.dumps({'operation': 'check', 'root': directory}) + '\n'
            with patch.object(worker.sys, 'stdin', io.StringIO(request)), \
                    patch.object(worker, 'setup_cache'), patch.object(worker, 'check_engine') as check:
                worker.main()
            check.assert_called_once_with()
            self.assertEqual((Path(directory) / worker.ENGINE).read_text(encoding='utf-8'), 'ready')

    def test_worker_and_host_share_the_adapter_deployment_version(self):
        from batch_adapter import STRATEGY
        self.assertEqual(worker.ADAPTER, STRATEGY)
        host = WORKER.parents[2] / 'src' / 'zotero' / 'pdf-translation-runtime.ts'
        self.assertIn(f"export const PDF_ADAPTER = '{STRATEGY}'", host.read_text(encoding='utf-8'))

    def test_engine_workspace_is_short_unique_and_preserves_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / ('Bao 等 - ' + 'long title ' * 12 + '.pdf')
            fixture(source)
            original = source.read_bytes()
            with worker.engine_workspace(source) as first, worker.engine_workspace(source) as second:
                self.assertNotEqual(first.parent, second.parent)
                self.assertEqual(first.name, 'input.pdf')
                self.assertEqual(first.read_bytes(), original)
                self.assertEqual(second.read_bytes(), original)
                self.assertNotIn(source.stem, str(first))
                # 引擎写入真实 PDF，即使另一执行仍保持自己的文件句柄也互不占用。
                with fitz.open(first) as opened:
                    opened.save(second.parent / 'output.pdf')
            self.assertFalse(first.parent.exists())
            self.assertFalse(second.parent.exists())
            self.assertEqual(source.read_bytes(), original)

    def test_native_error_keeps_context_even_when_message_is_truncated(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.pdf'
            fixture(source)
            config = dict(source=str(source), directory=str(Path(directory) / ('task-' + 'a' * 64)))
            async def fail(config, staged):
                pdf = fitz.open()
                pdf.new_page()
                try:
                    pdf.save(staged.parent / ('x' * 100) / ('y' * 100) / 'missing.pdf')
                finally:
                    pdf.close()
            with patch.object(worker, 'run_in_workspace', fail):
                with self.assertRaises(RuntimeError) as caught:
                    asyncio.run(worker.run(config))
            message = str(caught.exception)
            self.assertIn('cannot open file', message)
            self.assertIn('Source PDF: ' + str(source), message)
            self.assertIn('Output directory: ' + config['directory'], message)
            self.assertIn('Engine workspace:', message)

    def test_failed_republication_keeps_previous_pair_and_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.pdf'
            fixture(source)
            old = worker.publish(source, source, root, [])
            manifest = (root/'artifact.json').read_bytes()
            replace = os.replace
            def fail_dual(source, target):
                if str(target).endswith('-dual.pdf'): raise OSError('disk full')
                return replace(source, target)
            with patch.object(worker.os, 'replace', fail_dual):
                with self.assertRaisesRegex(OSError, 'disk full'): worker.publish(source, source, root, [])
            self.assertEqual((root/'artifact.json').read_bytes(), manifest)
            for kind in ('mono', 'dual'):
                with fitz.open(root/f"{old['revision']}-{kind}.pdf") as pdf: self.assertEqual(len(pdf),3)

    def test_scans_rotation_dimensions_and_source_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.pdf"
            fixture(source)
            original = source.read_bytes()
            with fitz.open(source) as pdf:
                skipped = worker.scanned_pages(pdf)
            self.assertEqual(skipped, [1])
            artifact = worker.publish(source, source, root, skipped)
            self.assertEqual(artifact['pages'], 3)
            revision = artifact['revision']
            self.assertEqual(source.read_bytes(), original)
            with fitz.open(source) as a, fitz.open(root / f"{revision}-mono.pdf") as b, fitz.open(root / f"{revision}-dual.pdf") as c:
                for index in range(3):
                    self.assertEqual(a[index].rect, b[index].rect)
                    self.assertEqual(c[index].rect.width, a[index].rect.width * 2)
                    self.assertEqual(c[index].rect.height, a[index].rect.height)
                self.assertEqual(b[0].get_text(), a[0].get_text())

    def test_rejects_mismatched_output_without_publishing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture(root / "source.pdf")
            pdf = fitz.open(); pdf.new_page(); pdf.save(root / "wrong.pdf"); pdf.close()
            with self.assertRaisesRegex(ValueError, "page count"):
                worker.publish(root / "source.pdf", root / "wrong.pdf", root, [])
            self.assertFalse((root / 'artifact.json').exists())


def engine_smoke(root, ai=False):
    """完整引擎 + 合成中文翻译服务，保留引擎格式占位符。"""
    import re
    root = Path(root)
    source = root / "fixture.pdf"
    fixture(source)
    config = dict(root=str(root), source=str(source), directory=str(root / ("test-output-ai" if ai else "test-output")),
                  fingerprint=hashlib.sha256(source.read_bytes()).hexdigest(), configuration="fixture-v1", sourceLanguage="en", targetLanguage="zh-CN", machine=not ai)
    with (root / "engine.log").open("w", encoding="utf-8") as log:
        code = f"import faulthandler,runpy,sys; sys.path.insert(0, {str(WORKER.parent)!r}); faulthandler.dump_traceback_later(90, repeat=True); runpy.run_path({str(WORKER)!r}, run_name='__main__')"
        process = subprocess.Popen([sys.executable, "-u", "-c", code], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, encoding="utf-8", env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
        process.stdin.write(json.dumps(config) + "\n"); process.stdin.flush()
        events = []
        for line in process.stdout:
            event = json.loads(line); events.append(event["type"])
            if event["type"] == "translate":
                if ai and event['text'].startswith('Translate the document passages'):
                    rows, _ = json.JSONDecoder().raw_decode(event['text'].split('\n', 1)[1])
                    values = []
                    for row in reversed(rows):
                        parts = re.split(r'(<[^>]+>|\{[^}]+\})', row['input'])
                        translated = ''.join(part if part.startswith(('<', '{')) else re.sub(r'[A-Za-z][A-Za-z ,.]+', '科学研究保留证据。', part) for part in parts)
                        values.append(dict(id=row['id'], output=translated, future='ignored'))
                    process.stdin.write(json.dumps({'id': event['id'], 'text': json.dumps(values, ensure_ascii=False)}, ensure_ascii=False) + '\n'); process.stdin.flush()
                    continue
                passage = event["text"].split("Now translate the following text:\n", 1)[-1].strip() if ai else event["text"]
                # 仅替换文本节点；AI 测试完整往返排版标签，不把提示词当译文。
                parts = re.split(r"(<[^>]+>|\{[^}]+\})", passage)
                translated = "".join(part if part.startswith(("<", "{")) else re.sub(r"[A-Za-z][A-Za-z ,.]+", "科学研究保留证据。", part) for part in parts)
                process.stdin.write(json.dumps({"id": event["id"], "text": translated, "extra": "ignored"}, ensure_ascii=False) + "\n"); process.stdin.flush()
            elif event["type"] in ("complete", "error"):
                print(json.dumps(event, ensure_ascii=False), flush=True)
        code = process.wait(timeout=30)
        if code or "complete" not in events:
            raise RuntimeError(f"Engine smoke failed: {code}; inspect engine.log")
        print(f"Engine smoke passed ({events.count('translate')} requests)")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--engine":
        engine_smoke(sys.argv[2], ai="--ai" in sys.argv)
    else:
        unittest.main()
