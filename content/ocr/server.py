"""本机全文解析服务：回环鉴权、隔离子进程、可取消页进度与内容摘要缓存。"""
import base64
import hashlib
import importlib.util
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
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = 1
EXTRACTION_REVISION = 5

# 固定公开模型文件摘要；魔搭与 HF 同一模型，不随镜像 master 变化接受新权重。
MODELSCOPE_FILES = {
    "docling-layout-egret-large": {
        "config.json": "1e711ae115d2e7e0a0648eaa5a48efd496a79af807d60755bedc570ab70a84cb",
        "model.safetensors": "f79def9d4a0d4e6e62cab25ec7846d1579ef1ef657c39554363813f7d1a14f1b",
        "preprocessor_config.json": "cd38cd59999e7a95d68e487fbe5132df3d4e5c32a0836add57e6126ba0c4eaf1"
    },
    "docling-models": {
        "config.json": "9c34024dc28ff47b75818f415e769809798c29bf9bde6f2ccc63a4acb62396d9",
        "model_artifacts/tableformer/accurate/tableformer_accurate.safetensors": "2a7d6c924b3cd12fb99a09280ca9c33a89c5d60b93253617d2e088c1a40374d9",
        "model_artifacts/tableformer/fast/tableformer_fast.safetensors": "3119563aab5a7c96fda4d621119b63fd8806272b86c30936d15507616422f718",
        "model_artifacts/tableformer/accurate/tm_config.json": "984e122ceb8ccf84d84c9d2882f6f2302a44b4f1e577babd6289892c36f3cffd",
        "model_artifacts/tableformer/fast/tm_config.json": "dca6762508dddfae6d57d6cb4ef822c6000119dff0f3b6489db7413118c2622a"
    },
    "CodeFormulaV2": {
        "added_tokens.json": "002686b2efb9535c359458cd1121de8e1b58e67426a46e2bd4425843766a3a5e",
        "chat_template.json": "c9d21553af689882ac89ad8e8412164662d1605f6595119664e85626df7be421",
        "config.json": "98f55cfe07dd168f9fab1f1eec35f754b23631ea1a9a7c9759b1b7cb41ab76b1",
        "generation_config.json": "b17f1890b2b2baf172761c9c4d6eb956482ffa05964f357e67544ec998c9851f",
        "model.safetensors": "4b04e77af34c4e682a7ab1617628340d658f3c3dcd12456dd2a7fff805cf79d2",
        "preprocessor_config.json": "6cb6e36d6fcb88ca1502c4a26750715dc3e7dedddc9a8f17b27d8d167d1457e7",
        "processor_config.json": "e7bff42da73ae9eec9042ef20e066e11f1ee20f025358ff79131e3c0fb549b46",
        "special_tokens_map.json": "1b17e900a73384d256db6f1a7591fd0d95c09e6aede680022b047386b97afcba",
        "tokenizer.json": "5ec5d3780a2e01b140cf34f023eb600263855a99aacdc3eb0f2600d7b1b4ac96",
        "tokenizer_config.json": "37a0e94be9c9ab5197b2188e61cf764bbc015f45261013881fe37bd2fe8599e6",
        "vocab.json": "8922f7e91084b9862d270c16ce1027071214aa252a1567a4b410f952101005fc"
    }
}


def download_model(repo_id, local_dir=None, force=False, progress=False, revision=None):
    """Docling 下载边界：优先复用旧 HF/魔搭缓存，仅缺失时访问所选源。"""
    from huggingface_hub import snapshot_download
    from huggingface_hub.errors import LocalEntryNotFoundError
    name = repo_id.removeprefix("docling-project/")
    expected_revision = "v2.3.0" if name == "docling-models" else "main"
    files = MODELSCOPE_FILES.get(name) if repo_id == "docling-project/" + name and (revision or "main") == expected_revision else None
    if not force and local_dir is None:
        try:
            cached = Path(snapshot_download(repo_id, revision=revision, local_files_only=True))
            if files is None or all((cached / filename).is_file() for filename in files):
                return cached
        except LocalEntryNotFoundError:
            pass
    directory = Path(os.environ["HF_HOME"]) / "modelscope" / name if files else None
    if directory and not force and all(valid_model_file(directory / filename, digest) for filename, digest in files.items()):
        return directory
    if os.environ.get("JADENSE_OCR_MODEL_SOURCE") != "modelscope" or files is None or local_dir is not None:
        return Path(snapshot_download(repo_id, revision=revision, local_dir=local_dir, force_download=force,
                                      local_files_only=os.environ.get("HF_HUB_OFFLINE") == "1"))
    if os.environ.get("HF_HUB_OFFLINE") == "1":
        raise FileNotFoundError(f"OCR model is not cached: {repo_id}")
    for filename, digest in files.items():
        target = directory / filename
        if not force and valid_model_file(target, digest):
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + ".incomplete")
        print(f"Downloading ModelScope: ds4sd/{name}/{filename}", flush=True)
        try:
            # 固定公开 URL，无 SDK 凭据、无 PDF；失败不覆盖已完成文件。
            url = f"https://www.modelscope.cn/models/ds4sd/{name}/resolve/master/{filename}"
            with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if not valid_model_file(temporary, digest):
                raise ValueError(f"ModelScope checksum mismatch: {name}/{filename}")
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    return directory


def valid_model_file(path, digest):
    """校验镜像权重完整性，避免中断下载或远端文件变化被当作可用模型。"""
    try:
        with path.open("rb") as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest() == digest
    except OSError:
        return False


def configure_model_downloads():
    """只在识别子进程安装 Docling 2.126 下载适配，不改动包文件或全局 SDK。"""
    from docling.models.utils import hf_model_download
    hf_model_download.download_hf_model = download_model
    if os.environ.get("HF_HUB_OFFLINE") == "1":
        from rapidocr.utils.download_file import DownloadFile
        def offline_download(*_args, **_kwargs):
            raise FileNotFoundError("RapidOCR model is not cached; prepare OCR models in settings")
        # RapidOCR 不遵循 HF_HUB_OFFLINE；仍允许已缓存且摘要正确的权重。
        DownloadFile._make_http_request = offline_download


def model_environment(source):
    """仅本次识别子进程使用下载源；不修改宿主环境，不向镜像附带用户 Hub 凭据。"""
    environment = os.environ.copy()
    environment["JADENSE_OCR_MODEL_SOURCE"] = source if source in {"hf-mirror", "modelscope"} else "default"
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
        marker = getattr(item, "marker", "")
        if label == "list_item" and marker and not text.lstrip().startswith(marker):
            text = f"{marker} {text}"
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
        configure_model_downloads()
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



def model_files(root, selection=False):
    """就绪凭据绑定已验证的模型文件；缺失或改动后必须重新检查识别。"""
    roots = {"hub": Path(root) / "models"}
    spec = importlib.util.find_spec("rapidocr")
    if spec and spec.origin: roots["rapidocr"] = Path(spec.origin).parent / "models"
    # refs 决定实际加载的快照：比较内容而非易被重写的时间戳，仍检测目标变化。
    return {prefix + "/" + str(p.relative_to(directory)): [p.stat().st_size, hashlib.sha256(p.read_bytes()).hexdigest() if "refs" in p.relative_to(directory).parts else p.stat().st_mtime_ns]
            for prefix, directory in roots.items() for p in directory.rglob("*")
            if selection or not any(part in {"models--docling-project--CodeFormulaV2", "CodeFormulaV2"} for part in p.parts)
            if p.is_file() and not any(part in {".locks", ".cache", ".no_exist"} for part in p.relative_to(directory).parts)
            and not p.name.endswith((".lock", ".incomplete"))}



def model_check(root, prepare=False, selection=False, allow_download=True):
    """设置页显式下载并离线识别合成 PDF；普通准入只检查版本及已验证文件。"""
    from importlib.metadata import version
    root = Path(root)
    os.environ["HF_HOME"] = str(root / "models")
    marker = root / ("selection-models-ready.json" if selection else "models-ready.json")
    versions = {name: version(name) for name in ("docling", "rapidocr", "onnxruntime")}
    # 先复用有效凭据，下载元数据不属于识别模型；兼容旧凭据中过宽的文件列表。
    try:
        saved = json.loads(marker.read_text(encoding="utf8"))
        files = model_files(root, selection)
        recorded = {name: value for name, value in saved["files"].items()
                    if not any(part in {".locks", ".cache", ".no_exist"} for part in Path(name).parts)}
        ready = saved.get("revision") == EXTRACTION_REVISION and saved.get("versions") == versions and bool(recorded) and all(files.get(name) == value for name, value in recorded.items())
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        ready = False
    if ready or not prepare:
        print(json.dumps({"modelsReady": ready}), flush=True)
        return ready
    if prepare:
        from PIL import Image, ImageDraw, ImageFont
        image = Image.new("RGB", (1200, 1600), "white")
        draw = ImageDraw.Draw(image)
        font = ImageFont.load_default(size=34)
        draw.text((100, 180), "OCR readiness verification", font=font, fill="black")
        draw.text((100, 260), "Research methods and results.", font=font, fill="black")
        source, result, progress = [root / name for name in ("readiness.pdf", "readiness.json", "readiness.progress")]
        regions = root / "readiness.regions"
        image.save(source, "PDF", resolution=144)
        try:
            environment = model_environment(os.environ.get("JADENSE_OCR_MODEL_SOURCE"))
            environment["HF_HUB_OFFLINE"] = "1"
            environment["HF_HOME"] = str(root / "models")
            result.unlink(missing_ok=True)
            command = [sys.executable, str(Path(__file__).resolve()), "--convert", str(source), str(result), str(progress)]
            if selection:
                # 合成 PDF 为 600×800 pt，只验证选文独有模型，不读取用户文献。
                regions.write_text(json.dumps([{"pageIndex": 0, "rects": [[0, 0, 600, 800]]}]), encoding="utf8")
                command = [sys.executable, str(Path(__file__).resolve()), "--selection", str(source), str(result), str(progress), str(regions)]
            options = {"stdin": subprocess.DEVNULL, "creationflags": subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0}
            # 旧版没有 models-ready.json；先离线验证旧缓存，不因升级强制联网或重下。
            offline = subprocess.run(command, env=environment, **options)
            if offline.returncode != 0:
                if not allow_download:
                    print(json.dumps({"modelsReady": False}), flush=True)
                    return False
                online = {**environment, "HF_HUB_OFFLINE": "0"}
                if selection: regions.write_text(json.dumps([{"pageIndex": 0, "rects": [[0, 0, 600, 800]]}]), encoding="utf8")
                subprocess.run(command, env=online, check=True, **options)
                result.unlink(missing_ok=True)
                if selection: regions.write_text(json.dumps([{"pageIndex": 0, "rects": [[0, 0, 600, 800]]}]), encoding="utf8")
                subprocess.run(command, env=environment, check=True, **options)
            data = json.loads(result.read_text(encoding="utf8"))
            text = data.get("text", "") if selection else " ".join(b.get("text", "") for p in data["pages"] for b in p["blocks"])
            if "readiness" not in text.lower():
                raise RuntimeError("OCR readiness sample was not recognized")
            temporary = marker.with_suffix(".tmp")
            temporary.write_text(json.dumps({"revision": EXTRACTION_REVISION, "versions": versions, "files": model_files(root, selection)}), encoding="utf8")
            temporary.replace(marker)
        finally:
            for path in (source, result, progress, regions): path.unlink(missing_ok=True)
    try:
        saved = json.loads(marker.read_text(encoding="utf8"))
        files = model_files(root, selection)
        ready = saved.get("revision") == EXTRACTION_REVISION and saved.get("versions") == versions and bool(saved.get("files")) and all(files.get(name) == value for name, value in saved["files"].items())
    except (OSError, ValueError, TypeError):
        ready = False
    print(json.dumps({"modelsReady": ready}), flush=True)
    return ready


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
        configure_model_downloads()
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
                                               env={**model_environment(self.headers.get("X-Jadense-OCR-Model-Source")), **({"HF_HUB_OFFLINE": "1"} if not regions else {})},
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
    if len(sys.argv) > 1 and sys.argv[1] in {"--prepare-models", "--check-models", "--prepare-selection-models", "--verify-models"}:
        if not model_check(sys.argv[2], sys.argv[1] != "--check-models", sys.argv[1] == "--prepare-selection-models", sys.argv[1] != "--verify-models"): sys.exit(2)
    elif len(sys.argv) > 1 and sys.argv[1] == "--selection":
        convert_selection(*sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "--convert":
        convert(*sys.argv[2:])
    else:
        config = json.loads(sys.stdin.readline())
        root = Path(config["root"]).resolve()
        os.environ["HF_HOME"] = str(root / "models")
        serve(str(root / "cache"), config["token"])
