"""本机 OCR 投影的轻量回归，不下载模型、不启动网络服务。"""
import unittest
from server import formula_text, normalize_document, model_environment, selection_regions, selection_image
from unittest.mock import patch
import os
from types import SimpleNamespace


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


if __name__ == "__main__":
    unittest.main()
