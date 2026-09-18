"""本机 OCR 投影的轻量回归，不下载模型、不启动网络服务。"""
import unittest
import tempfile
from pathlib import Path
from server import model_files, model_check
from server import formula_text, normalize_document, model_environment, selection_regions, selection_image
from unittest.mock import patch
import os
from types import SimpleNamespace
import hashlib
import io
import json
from server import download_model, configure_model_downloads


class DownloadTests(unittest.TestCase):
    def test_old_hf_cache_works_without_network_after_source_change(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"HF_HOME": directory, "JADENSE_OCR_MODEL_SOURCE": "modelscope"}), patch("huggingface_hub.snapshot_download", return_value=directory) as snapshot, patch("urllib.request.urlopen") as network:
            (Path(directory) / "weight").write_bytes(b"old model")
            with patch("server.MODELSCOPE_FILES", {"docling-layout-egret-large": {"weight": "unused for HF"}}):
                self.assertEqual(download_model("docling-project/docling-layout-egret-large"), Path(directory))
            snapshot.assert_called_once_with("docling-project/docling-layout-egret-large", revision=None, local_files_only=True)
            network.assert_not_called()

    def test_modelscope_download_verifies_bytes_retries_and_reuses_offline(self):
        from huggingface_hub.errors import LocalEntryNotFoundError
        content = b"verified model"
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"HF_HOME": directory, "JADENSE_OCR_MODEL_SOURCE": "modelscope", "HF_HUB_OFFLINE": "0"}), patch("huggingface_hub.snapshot_download", side_effect=LocalEntryNotFoundError("missing")), patch("server.MODELSCOPE_FILES", {"docling-layout-egret-large": {"weight": hashlib.sha256(content).hexdigest()}}):
            with patch("urllib.request.urlopen", return_value=io.BytesIO(b"truncated")):
                with self.assertRaisesRegex(ValueError, "checksum"):
                    download_model("docling-project/docling-layout-egret-large")
            self.assertFalse(list(Path(directory).rglob("*.incomplete")))
            with patch("urllib.request.urlopen", return_value=io.BytesIO(content)) as network:
                cached = download_model("docling-project/docling-layout-egret-large")
                self.assertEqual((cached / "weight").read_bytes(), content)
                self.assertIn("modelscope.cn/models/ds4sd/", network.call_args.args[0])
            with patch.dict(os.environ, {"HF_HUB_OFFLINE": "1", "JADENSE_OCR_MODEL_SOURCE": "default"}), patch("urllib.request.urlopen") as network:
                self.assertEqual(download_model("docling-project/docling-layout-egret-large"), cached)
                network.assert_not_called()

    def test_offline_rapidocr_never_downloads_missing_weights(self):
        from rapidocr.utils.download_file import DownloadFile
        from docling.models.utils import hf_model_download
        with patch.object(DownloadFile, "_make_http_request"), patch.object(hf_model_download, "download_hf_model"), patch.dict(os.environ, {"HF_HUB_OFFLINE": "1"}), patch("requests.get") as network:
            configure_model_downloads()
            with self.assertRaisesRegex(FileNotFoundError, "RapidOCR"):
                DownloadFile._make_http_request("https://example.invalid/model", None)
            network.assert_not_called()

    def test_old_cache_is_verified_before_online_preparation(self):
        with tempfile.TemporaryDirectory() as directory, patch("importlib.metadata.version", return_value="test"), patch("server.importlib.util.find_spec", return_value=None), patch.dict(os.environ, {}, clear=False):
            root = Path(directory)
            (root / "models").mkdir()
            (root / "models" / "weight").write_bytes(b"existing")
            def recognize(command, **options):
                self.assertEqual(options["env"]["HF_HUB_OFFLINE"], "1")
                Path(command[4]).write_text(json.dumps({"pages": [{"blocks": [{"text": "readiness"}]}]}))
                return SimpleNamespace(returncode=0)
            with patch("server.subprocess.run", side_effect=recognize) as run:
                self.assertTrue(model_check(root, prepare=True))
                self.assertEqual(run.call_count, 1)
            self.assertTrue((root / "models-ready.json").exists())

    def test_missing_models_prepare_online_then_verify_offline(self):
        with tempfile.TemporaryDirectory() as directory, patch("importlib.metadata.version", return_value="test"), patch("server.importlib.util.find_spec", return_value=None), patch.dict(os.environ, {"JADENSE_OCR_MODEL_SOURCE": "modelscope"}):
            root = Path(directory)
            (root / "models").mkdir()
            (root / "models" / "weight").write_bytes(b"existing")
            modes = []
            def recognize(command, **options):
                modes.append(options["env"]["HF_HUB_OFFLINE"])
                self.assertEqual(options["env"]["JADENSE_OCR_MODEL_SOURCE"], "modelscope")
                if len(modes) == 1: return SimpleNamespace(returncode=2)
                Path(command[4]).write_text(json.dumps({"pages": [{"blocks": [{"text": "readiness"}]}]}))
                return SimpleNamespace(returncode=0)
            with patch("server.subprocess.run", side_effect=recognize):
                self.assertTrue(model_check(root, prepare=True))
            self.assertEqual(modes, ["1", "0", "1"])


class FormulaTests(unittest.TestCase):
    def test_selection_scope_accepts_additive_fields_but_never_defaults_to_full_page(self):
        region = {"pageIndex": 1, "rects": [[1, 2, 5, 8]]}
        self.assertEqual(selection_regions([{**region, "extra": "ignored"}]), [region])
        for value in (None, [], [{"pageIndex": 0, "rects": []}], [{"pageIndex": 0, "rects": [[0, 0, float("nan"), 4]]}]):
            with self.assertRaises(ValueError):
                selection_regions(value)

    def test_selection_masks_unselected_pixels_between_regions(self):
        from PIL import Image
        source = Image.new("RGB", (100, 100), "black")
        image = selection_image(source, 100, 100, [[10, 70, 20, 80], [40, 50, 50, 60]])
        self.assertEqual(image.size, (40, 30))
        self.assertEqual(image.getpixel((0, 0)), (0, 0, 0))
        self.assertEqual(image.getpixel((20, 10)), (255, 255, 255))
        self.assertEqual(image.getpixel((39, 29)), (0, 0, 0))

    def test_model_download_source_is_per_job_and_preserves_cache(self):
        """只改变显式镜像任务的下载地址，未知值沿用用户环境及模型缓存。"""
        with patch.dict(os.environ, {"HF_ENDPOINT": "https://configured.invalid", "HF_HOME": "/existing/models", "HF_HUB_DOWNLOAD_TIMEOUT": "300"}, clear=True):
            mirror = model_environment("hf-mirror")
            self.assertEqual(mirror["HF_ENDPOINT"], "https://hf-mirror.com")
            self.assertEqual(mirror["HF_HUB_DISABLE_IMPLICIT_TOKEN"], "1")
            self.assertEqual(mirror["HF_HOME"], "/existing/models")
            self.assertEqual(mirror["HF_HUB_DOWNLOAD_TIMEOUT"], "300")
            self.assertEqual(model_environment("unknown")["HF_ENDPOINT"], "https://configured.invalid")
            self.assertEqual(os.environ["HF_ENDPOINT"], "https://configured.invalid")

    def test_ordered_pictures_tables_and_formulas(self):
        """版面适配必须保留普通插图，页脚剔除不影响图片和图注顺序。"""
        class Image:
            width = height = 100
            def crop(self, _rect):
                return self
            def save(self, stream, format):
                stream.write(b"synthetic PNG")

        class Box:
            l = b = 0
            r = t = 20
            def to_bottom_left_origin(self, **_options):
                return self
            def to_top_left_origin(self, **_options):
                return self

        def item(label, text):
            return SimpleNamespace(label=label, text=text, prov=[SimpleNamespace(page_no=1, bbox=Box())],
                                   export_to_markdown=lambda **_options: "| A | B |")
        items = [item("section_header", "Title"), item("picture", ""), item("caption", "Figure 1"),
                 item("table", "table"), item("formula", "x = 2"), item("page_footer", "Footer")]
        document = SimpleNamespace(iterate_items=lambda: [(row, 0) for row in items],
                                   pages={1: SimpleNamespace(size=SimpleNamespace(width=100, height=100), image=SimpleNamespace(pil_image=Image()))})
        blocks = normalize_document(document, 4)
        self.assertEqual([row["kind"] for row in blocks], ["section_header", "picture", "caption", "table", "formula"])
        self.assertTrue(blocks[1]["image"].startswith("data:image/png;base64,"))
        self.assertEqual(blocks[2]["text"], "Figure 1")
        self.assertEqual(blocks[3]["text"], "| A | B |")
        self.assertTrue(all(row["locations"][0]["pageIndex"] == 4 for row in blocks))

    def test_equations(self):
        for text in ("y0 = a0 x + b0", "E = mc2", "α = β + γ", "1 + 1 = 2", "y = sin(x)"):
            self.assertTrue(formula_text(text), text)

    def test_prose_remains_translatable(self):
        for text in ("The result is x = 2.", "结果 = 实验结果", "值 = 2", "This is an equation", "We use x = 2"):
            self.assertFalse(formula_text(text), text)


class ReadinessTests(unittest.TestCase):
    def test_automatic_recovery_verifies_old_cache_once_without_network(self):
        with tempfile.TemporaryDirectory() as directory, patch("importlib.metadata.version", return_value="test"), patch("server.importlib.util.find_spec", return_value=None):
            root = Path(directory)
            (root / "models").mkdir()
            (root / "models" / "weights.bin").write_bytes(b"old weights")
            def recognize(command, **options):
                self.assertEqual(options["env"]["HF_HUB_OFFLINE"], "1")
                Path(command[4]).write_text(json.dumps({"pages": [{"blocks": [{"text": "readiness"}]}]}))
                return SimpleNamespace(returncode=0)
            with patch("server.subprocess.run", side_effect=recognize) as run:
                self.assertTrue(model_check(root, prepare=True, allow_download=False))
                self.assertTrue(model_check(root, prepare=True, allow_download=False))
                self.assertEqual(run.call_count, 1)

    def test_automatic_recovery_never_downloads_missing_models(self):
        with tempfile.TemporaryDirectory() as directory, patch("importlib.metadata.version", return_value="test"), patch("server.importlib.util.find_spec", return_value=None):
            with patch("server.subprocess.run", return_value=SimpleNamespace(returncode=2)) as run:
                self.assertFalse(model_check(directory, prepare=True, allow_download=False))
                self.assertEqual(run.call_count, 1)
                self.assertEqual(run.call_args.kwargs["env"]["HF_HUB_OFFLINE"], "1")
            self.assertFalse((Path(directory) / "models-ready.json").exists())

    def test_valid_preparation_is_reused_and_hub_metadata_does_not_invalidate(self):
        from server import EXTRACTION_REVISION
        with tempfile.TemporaryDirectory() as directory, patch("importlib.metadata.version", return_value="test"), patch("server.importlib.util.find_spec", return_value=None):
            root = Path(directory)
            weights = root / "models" / "hub" / "models--example" / "snapshots" / "abc" / "model.bin"
            weights.parent.mkdir(parents=True)
            weights.write_bytes(b"weights")
            metadata = root / "models" / "hub" / "models--example" / "refs" / "main"
            metadata.parent.mkdir(parents=True)
            metadata.write_text("abc")
            receipt = {"revision": EXTRACTION_REVISION, "versions": {name: "test" for name in ("docling", "rapidocr", "onnxruntime")}, "files": model_files(root)}
            (root / "models-ready.json").write_text(json.dumps(receipt))
            metadata.write_text("abc")
            os.utime(metadata, ns=(1_000_000_000, 1_000_000_000))
            self.assertTrue(model_check(root))
            with patch("server.subprocess.run", side_effect=AssertionError("Repeated recognition")):
                self.assertTrue(model_check(root, prepare=True))
            metadata.write_text("different snapshot")
            self.assertFalse(model_check(root))

    def test_optional_formula_cache_changes_do_not_invalidate_full_document_models(self):
        with tempfile.TemporaryDirectory() as directory, patch("server.importlib.util.find_spec", return_value=None):
            root = Path(directory)
            formula = root / "models" / "modelscope" / "CodeFormulaV2" / "weight"
            formula.parent.mkdir(parents=True)
            before = model_files(root)
            formula.write_bytes(b"formula")
            self.assertEqual(model_files(root), before)
            self.assertTrue(model_files(root, selection=True))

    def test_model_changes_and_missing_files_invalidate_receipt(self):
        import json
        from server import EXTRACTION_REVISION
        with tempfile.TemporaryDirectory() as directory, patch("importlib.metadata.version", return_value="test"), patch("server.importlib.util.find_spec", return_value=None):
            root = Path(directory)
            (root / "models").mkdir()
            weights = root / "models" / "weights.bin"
            weights.write_bytes(b"test weights")
            receipt = {"revision": EXTRACTION_REVISION, "versions": {name: "test" for name in ("docling", "rapidocr", "onnxruntime")}, "files": model_files(root)}
            (root / "models-ready.json").write_text(json.dumps(receipt))
            self.assertTrue(model_check(root))
            weights.write_bytes(b"changed weights")
            self.assertFalse(model_check(root))
            weights.unlink()
            self.assertFalse(model_check(root))


if __name__ == "__main__":
    unittest.main()
