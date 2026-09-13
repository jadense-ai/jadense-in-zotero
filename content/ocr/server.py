"""本机全文解析服务：回环鉴权、隔离子进程、可取消页进度与内容摘要缓存。"""
import base64
import hashlib
import hmac
import io
import json
import subprocess
import os
import re
import math
from pathlib import Path
import secrets
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = 1
EXTRACTION_REVISION = 4


def model_environment(source):
    """仅本次识别子进程使用下载源；不修改宿主环境，不向镜像附带用户 Hub 凭据。"""
    environment = os.environ.copy()
    if source == "hf-mirror":
        environment["HF_ENDPOINT"] = "https://hf-mirror.com"
    environment["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    environment.setdefault("HF_HUB_ETAG_TIMEOUT", "30")
    environment.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "120")
    return environment


def formula_text(text):
    """版面模型漏标的纯等式也使用原图；含自然语言词语的正文继续翻译。"""
    words = re.findall(r"[^\W\d_]+", text, flags=re.UNICODE)
    return bool(re.search(r"[=≈≠≤≥∑∫]", text) and
                all(re.fullmatch(r"[A-Za-zΑ-Ωα-ω]{1,2}", word) and word.lower() not in {"is", "we", "as", "to", "in", "of", "an"}
                    or word.lower() in {"sin", "cos", "tan", "log", "exp", "lim", "max", "min"} for word in words))


def normalize_document(document, page_index):
    """按 Docling body 阅读顺序投影，坐标转成 PDF 左下原点；不暴露模型对象。"""
    blocks = []
    for item, _level in document.iterate_items():
        label = str(getattr(item, "label", "")).split(".")[-1].lower()
        layer = str(getattr(item, "content_layer", "body")).split(".")[-1].lower()
        if layer == "furniture" or label in {"page_header", "page_footer"}:
            continue
        prov = getattr(item, "prov", [])
        if not prov:
            continue
        page = document.pages[prov[0].page_no]
        locations = []
        for source in prov:
            bbox = source.bbox.to_bottom_left_origin(page_height=page.size.height)
            locations.append({"pageIndex": page_index, "rects": [[bbox.l, bbox.b, bbox.r, bbox.t]]})
        text = getattr(item, "text", "")
        if label == "table":
            text = item.export_to_markdown(doc=document)
        asset = None
        if label in {"formula", "picture"} or label in {"text", "list_item"} and formula_text(text):
            # OCR 数学字符不作为可靠 LaTeX；用原页裁图保留原始公式。
            bbox = prov[0].bbox.to_top_left_origin(page_height=page.size.height)
            image = page.image.pil_image
            sx, sy = image.width / page.size.width, image.height / page.size.height
            crop = image.crop((bbox.l * sx, bbox.t * sy, bbox.r * sx, bbox.b * sy))
            data = io.BytesIO(); crop.save(data, format="PNG")
            asset = "data:image/png;base64," + base64.b64encode(data.getvalue()).decode("ascii")
            text = ""
        if not text.strip() and not asset:
            continue
        blocks.append({"text": text, "kind": label, "locations": locations,
                       **({"image": asset} if asset else {})})
    return blocks


def convert(path, result_path, progress_path):
    """页范围转换仍由 Docling 决定页内阅读顺序；父进程可立即终止本次转换。"""
    try:
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions, LayoutObjectDetectionOptions
        from docling.datamodel.accelerator_options import AcceleratorOptions, AcceleratorDevice
        import pypdfium2
        pdf = pypdfium2.PdfDocument(path)
        total = len(pdf); pdf.close()
        options = PdfPipelineOptions(do_ocr=True, generate_page_images=True, images_scale=2)
        options.ocr_options = RapidOcrOptions(force_full_page_ocr=True)
        options.layout_options = LayoutObjectDetectionOptions.from_preset("layout_egret_large")
        options.accelerator_options = AcceleratorOptions(device=AcceleratorDevice.CPU, num_threads=4)
        options.enable_remote_services = False
        converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
        pages = []
        for index in range(total):
            Path(progress_path).write_text(json.dumps({"page": index + 1, "total": total}), encoding="utf8")
            result = converter.convert(path, page_range=(index + 1, index + 1))
            if str(result.status).split(".")[-1].lower() != "success":
                raise RuntimeError(f"OCR page {index + 1} was not fully converted")
            pages.append({"pageIndex": index, "blocks": normalize_document(result.document, index)})
        temp = Path(result_path + ".tmp")
        temp.write_text(json.dumps({"version": VERSION, "pages": pages}, ensure_ascii=False), encoding="utf8")
        temp.replace(result_path)
    except Exception as error:
        Path(progress_path).write_text(json.dumps({"error": str(error)}), encoding="utf8")
        raise


def selection_regions(value):
    """只投影选区坐标；没有可信范围时拒绝增强，不能扩大到整页或全文。"""
    if not isinstance(value, list) or not value:
        raise ValueError("Missing selection regions")
    result = []
    for region in value:
        page = region.get("pageIndex")
        rects = region.get("rects")
        if type(page) is not int or page < 0 or not isinstance(rects, list) or not rects:
            raise ValueError("Invalid selection region")
        for rect in rects:
            if not isinstance(rect, list) or len(rect) != 4 or not all(type(n) in (int, float) and math.isfinite(n) for n in rect) or rect[2] <= rect[0] or rect[3] <= rect[1]:
                raise ValueError("Invalid selection rectangle")
        result.append({"pageIndex": page, "rects": rects})
    return result


def selection_image(image, width, height, rects):
    """先遮蔽选区之外像素再裁剪；多栏空隙与未选正文不进入 OCR。"""
    from PIL import Image
    sx, sy = image.width / width, image.height / height
    masked = Image.new("RGB", image.size, "white")
    boxes = []
    for l, b, r, t in rects:
        box = (max(0, math.floor(l * sx)), max(0, math.floor((height - t) * sy)),
               min(image.width, math.ceil(r * sx)), min(image.height, math.ceil((height - b) * sy)))
        if box[2] > box[0] and box[3] > box[1]:
            masked.paste(image.crop(box), box); boxes.append(box)
    if not boxes:
        raise ValueError("Selection is outside the page")
    return masked.crop((min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)))


def convert_selection(path, result_path, progress_path, regions_path):
    """选文独立启用公式转 LaTeX；不改变全文公式裁图契约。"""
    image_path = Path(path + ".png")
    try:
        import pypdfium2
        from docling.document_converter import DocumentConverter, ImageFormatOption
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions, LayoutObjectDetectionOptions
        from docling.datamodel.accelerator_options import AcceleratorOptions, AcceleratorDevice
        regions = selection_regions(json.loads(Path(regions_path).read_text(encoding="utf8")))
        options = PdfPipelineOptions(do_ocr=True, do_formula_enrichment=True)
        options.ocr_options = RapidOcrOptions(force_full_page_ocr=True)
        options.layout_options = LayoutObjectDetectionOptions.from_preset("layout_egret_large")
        options.accelerator_options = AcceleratorOptions(device=AcceleratorDevice.CPU, num_threads=4)
        options.enable_remote_services = False
        converter = DocumentConverter(format_options={InputFormat.IMAGE: ImageFormatOption(pipeline_options=options)})
        parts = []
        with pypdfium2.PdfDocument(path) as pdf:
            for index, region in enumerate(regions):
                Path(progress_path).write_text(json.dumps({"page": index + 1, "total": len(regions)}), encoding="utf8")
                page = pdf[region["pageIndex"]]
                try:
                    # 当前坐标契约使用未旋转 PDF 页；旋转页降级，避免错误选区。
                    if page.get_rotation() != 0:
                        raise ValueError("Rotated selection OCR is unavailable")
                    width, height = page.get_size()
                    left, bottom, _, _ = page.get_bbox()
                    rects = [[l - left, b - bottom, r - left, t - bottom] for l, b, r, t in region["rects"]]
                    bitmap = page.render(scale=3)
                    try:
                        selection_image(bitmap.to_pil(), width, height, rects).save(image_path)
                    finally:
                        bitmap.close()
                finally:
                    page.close()
                result = converter.convert(image_path)
                if str(result.status).split(".")[-1].lower() != "success":
                    raise RuntimeError("Selection OCR was not fully converted")
                text = result.document.export_to_markdown()
                if not text.strip() or "<!-- formula-not-decoded -->" in text:
                    raise RuntimeError("Selection formula or text was not decoded")
                parts.append(text)
        temp = Path(result_path + ".tmp")
        temp.write_text(json.dumps({"text": "\n\n".join(parts)}, ensure_ascii=False), encoding="utf8")
        temp.replace(result_path)
    except Exception as error:
        Path(progress_path).write_text(json.dumps({"error": str(error)}), encoding="utf8")
        raise
    finally:
        image_path.unlink(missing_ok=True)
        Path(regions_path).unlink(missing_ok=True)


class State:
    def __init__(self, root, token):
        self.root, self.token = Path(root), token
        self.root.mkdir(parents=True, exist_ok=True)
        self.jobs = {}
        self.lock = threading.Lock()

    def cancel(self, job):
        process = job.get("process")
        if process and process.poll() is None:
            process.terminate(); process.wait(timeout=5)
        job["cancelled"] = True
        Path(job["source"]).unlink(missing_ok=True)
        Path(job["source"] + ".png").unlink(missing_ok=True)
        Path(job["source"] + ".regions").unlink(missing_ok=True)


def serve(root, token):
    state = State(root, token)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # 不记录 PDF、凭证或请求正文。

        def reply(self, status, data):
            content = json.dumps(data).encode("utf8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers(); self.wfile.write(content)

        def authorized(self):
            # 无 CORS、无浏览器 Origin；精确 Bearer 防止恶意网页读取本机附件。
            if self.headers.get("Origin") or not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                self.reply(403, {"error": "Unauthorized local OCR request"}); return False
            return True

        def do_POST(self):
            if not self.authorized(): return
            if self.path not in {"/jobs", "/selection-jobs"}: return self.reply(404, {})
            regions = None
            if self.path == "/selection-jobs":
                try: regions = selection_regions(json.loads(self.headers.get("X-Jadense-OCR-Selection", "null")))
                except (ValueError, TypeError, AttributeError): return self.reply(400, {"error": "Invalid selection"})
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0: return self.reply(400, {"error": "Empty PDF"})
            with state.lock:
                if any(j.get("process") and j["process"].poll() is None and not Path(j["result"]).exists() for j in state.jobs.values()):
                    return self.reply(409, {"error": "OCR is processing another document"})
                data = self.rfile.read(length)
                mode = ("selection-v1-" + json.dumps(regions, sort_keys=True)) if regions else ""
                digest = hashlib.sha256(data + mode.encode() + f"docling-2.126.0-rapidocr-3.9.2-v{VERSION}-r{EXTRACTION_REVISION}".encode()).hexdigest()
                result = state.root / (digest + ".json")
                job_id = secrets.token_hex(16)
                source = state.root / (job_id + ".pdf")
                progress = state.root / (job_id + ".progress")
                job = {"source": str(source), "result": str(result), "progress": str(progress)}
                if not result.exists():
                    source.write_bytes(data)
                    args = ["--convert", str(source), str(result), str(progress)]
                    if regions:
                        region_path = str(source) + ".regions"
                        Path(region_path).write_text(json.dumps(regions), encoding="utf8")
                        args = ["--selection", str(source), str(result), str(progress), region_path]
                    process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), *args], stdin=subprocess.DEVNULL,
                                               env=model_environment(self.headers.get("X-Jadense-OCR-Model-Source")),
                                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
                    job["process"] = process
                state.jobs[job_id] = job
                self.reply(200, {"id": job_id})

        def do_GET(self):
            if not self.authorized(): return
            if self.path == "/health": return self.reply(200, {"version": VERSION})
            job = state.jobs.get(self.path.removeprefix("/jobs/"))
            if not job: return self.reply(404, {})
            if job.get("cancelled"): return self.reply(200, {"state": "cancelled"})
            if Path(job["result"]).exists():
                Path(job["source"]).unlink(missing_ok=True)
                return self.reply(200, {"state": "complete", "result": json.loads(Path(job["result"]).read_text(encoding="utf8"))})
            try: progress = json.loads(Path(job["progress"]).read_text(encoding="utf8"))
            except (FileNotFoundError, json.JSONDecodeError): progress = {}
            if "error" in progress or job["process"].poll() is not None:
                Path(job["source"]).unlink(missing_ok=True)
                return self.reply(200, {"state": "error", "error": progress.get("error", "OCR process stopped")})
            self.reply(200, {"state": "running", **progress})

        def do_DELETE(self):
            if not self.authorized(): return
            job = state.jobs.get(self.path.removeprefix("/jobs/"))
            if job: state.cancel(job)
            self.reply(200, {})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(json.dumps({"port": server.server_port, "version": VERSION}), flush=True)
    # 插件结束关闭 stdin，服务终止自身创建的 OCR 子进程。
    def watch_parent():
        sys.stdin.read()
        for job in state.jobs.values(): state.cancel(job)
        server.shutdown()
    threading.Thread(target=watch_parent, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selection":
        convert_selection(*sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "--convert":
        convert(*sys.argv[2:])
    else:
        config = json.loads(sys.stdin.readline())
        root = Path(config["root"]).resolve()
        os.environ["HF_HOME"] = str(root / "models")
        serve(str(root / "cache"), config["token"])
