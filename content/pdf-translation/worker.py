"""本地 PDF 排版进程：stdin 接收可信任务/翻译回复，stdout 仅发 JSON 协议。

Provider 请求由 Zotero 发出；此文件不接触凭据，不修改原 PDF。
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import asyncio
import contextlib
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import uuid
from concurrent.futures import Future
from batch_adapter import install_adapter, IncompleteTranslation, ProviderFailure, atomic_replace, STRATEGY as ADAPTER

ENGINE = "babeldoc-0.6.4-v1"
OUTPUT = sys.stdout
LOCK = threading.Lock()


def emit(**message):
    with LOCK:
        OUTPUT.write(json.dumps(message, ensure_ascii=True) + "\n")
        OUTPUT.flush()


def fingerprint(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def setup_cache(root, asset_root=None):
    # 在导入引擎其他模块前指定独立资产目录，不污染 OCR 环境。
    import babeldoc.const as const
    bundled = Path(root) / 'runtime' / 'assets'
    const.CACHE_FOLDER = Path(asset_root) if asset_root else (bundled if bundled.is_dir() else Path(root) / "assets")
    const.CACHE_FOLDER.mkdir(parents=True, exist_ok=True)
    const.TIKTOKEN_CACHE_FOLDER = const.CACHE_FOLDER / "tiktoken"
    const.TIKTOKEN_CACHE_FOLDER.mkdir(exist_ok=True)
    os.environ["TIKTOKEN_CACHE_DIR"] = str(const.TIKTOKEN_CACHE_FOLDER)


def scanned_pages(document):
    """没有有效文字的页面原样保留；不声称已完成扫描图像翻译。"""
    return [index for index, page in enumerate(document)
            if not any(char.isalpha() for char in page.get_text())]


def publish(source_path, translated_path, directory, skipped, metadata=None):
    """验证后原子写入 mono/dual；左右对照始终使用完整原页。"""
    import pymupdf as fitz
    directory = Path(directory)
    revision = uuid.uuid4().hex
    with fitz.open(source_path) as source, fitz.open(translated_path) as translated:
        if len(source) != len(translated):
            raise ValueError("Translated page count differs from source")
        mono, dual = fitz.open(), fitz.open()
        try:
            for index, original in enumerate(source):
                target = translated[index]
                if any(abs(a - b) > 1 for a, b in zip(original.rect, target.rect)):
                    raise ValueError(f"Translated page size differs: {index + 1}")
                selected = source if index in skipped else translated
                mono.insert_pdf(selected, from_page=index, to_page=index)
                width, height = original.rect.width, original.rect.height
                page = dual.new_page(width=width * 2, height=height)
                if original.get_contents():
                    page.show_pdf_page(fitz.Rect(0, 0, width, height), source, index)
                if selected[index].get_contents():
                    page.show_pdf_page(fitz.Rect(width, 0, width * 2, height), selected, index)
            for name, document in (("mono", mono), ("dual", dual)):
                temporary = directory / f"{revision}-{name}.tmp.pdf"
                document.save(temporary, garbage=4, deflate=True)
                with fitz.open(temporary) as checked:
                    if len(checked) != len(source):
                        raise ValueError("PDF output verification failed")
                os.replace(temporary, directory / f"{revision}-{name}.pdf")
            artifact = {**(metadata or {}), 'revision': revision, 'pages': len(source), 'skipped': skipped}
            temporary = directory / 'artifact.tmp.json'
            temporary.write_text(json.dumps(artifact, ensure_ascii=True), encoding='utf-8')
            atomic_replace(temporary, directory / 'artifact.json')
            return artifact
        finally:
            mono.close()
            dual.close()


@contextlib.contextmanager
def engine_workspace(source):
    """每次执行独享短路径副本，避开旧任务占用；缓存和正式产物仍由任务目录持有。"""
    with tempfile.TemporaryDirectory(prefix="jdx-pdf-", ignore_cleanup_errors=True) as folder:
        staged = Path(folder) / "input.pdf"
        shutil.copyfile(source, staged)
        yield staged


async def run(config):
    with engine_workspace(config["source"]) as staged:
        try:
            await run_in_workspace(config, staged)
        except IncompleteTranslation:
            raise
        except Exception as error:
            # MuPDF 的定长错误缓冲可能被长路径填满；上下文独立附加，不能依赖原生消息尾部。
            raise RuntimeError(f"{type(error).__name__}: {error}\n"
                               f"Source PDF: {config['source']}\n"
                               f"Engine workspace: {staged.parent}\n"
                               f"Output directory: {config['directory']}") from error


async def run_in_workspace(config, staged):
    import pymupdf as fitz
    from babeldoc.translator.translator import BaseTranslator
    from babeldoc.format.pdf.high_level import async_translate
    from babeldoc.format.pdf.translation_config import TranslationConfig, WatermarkOutputMode

    source = Path(config["source"])
    directory = Path(config["directory"])
    directory.mkdir(parents=True, exist_ok=True)
    digest = fingerprint(source)
    if digest != config["fingerprint"] or fingerprint(staged) != digest:
        raise ValueError("Source PDF changed")
    with fitz.open(source) as pdf:
        skipped = scanned_pages(pdf)
        page_count = len(pdf)
    emit(type="progress", stage="preparing_pdf", percent=0, skipped=skipped)
    cache_path = directory / "segments.json"
    try:
        cache = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cache = {}
    rpc_lock = threading.Lock()
    waiting = {}
    disconnected = False
    cancelled = threading.Event()

    def replies():
        nonlocal disconnected
        try:
            for line in sys.stdin:
                reply = json.loads(line)
                with rpc_lock:
                    if reply.get('type') == 'cancel':
                        cancelled.set()
                        for pending in waiting.values():
                            if not pending.done(): pending.set_exception(ProviderFailure('CANCELLED', True))
                        continue
                    future = waiting.get(reply.get('id'))
                if future and not future.done(): future.set_result(reply)
        finally:
            with rpc_lock:
                disconnected = True
                for future in waiting.values():
                    if not future.done(): future.set_exception(ProviderFailure('CLIENT_DISCONNECTED', True))

    threading.Thread(target=replies, daemon=True).start()

    class Translator(BaseTranslator):
        name = "jadense-pdf"

        def __init__(self):
            super().__init__(config["sourceLanguage"], config["targetLanguage"], True)
            self.model = config["configuration"]

        def request(self, text, llm, operation=None):
            key = operation or hashlib.sha256(json.dumps([text, llm], ensure_ascii=True).encode()).hexdigest()
            # stdin 唯一读者按 ID 分发；只在登记和缓存落盘时持锁。
            with rpc_lock:
                if not llm and key in cache:
                    return cache[key]
                if cancelled.is_set(): raise ProviderFailure('CANCELLED', True)
                if disconnected: raise ProviderFailure('CLIENT_DISCONNECTED', True)
                future = waiting.get(key)
                owner = future is None
                if owner:
                    future = Future()
                    waiting[key] = future
            if owner:
                emit(type="translate", id=key, text=text, llm=llm)
            try:
                reply = future.result()
                if reply.get("error"):
                    issue = reply['error']
                    raise ProviderFailure(issue.get('code', 'PROVIDER_FAILED') if isinstance(issue, dict) else 'PROVIDER_FAILED',
                                          issue.get('stop', True) if isinstance(issue, dict) else True)
                result = reply.get("text")
                if not isinstance(result, str) or not result.strip():
                    raise ProviderFailure('EMPTY_TRANSLATION')
                if not llm:
                    with rpc_lock:
                        cache[key] = result
                        temporary = cache_path.with_suffix(".tmp")
                        temporary.write_text(json.dumps(cache, ensure_ascii=True), encoding="utf-8")
                        atomic_replace(temporary, cache_path)
                return result
            finally:
                if owner:
                    with rpc_lock: waiting.pop(key, None)

        def do_translate(self, text, rate_limit_params=None):
            return self.request(text, False)

        def do_llm_translate(self, text, rate_limit_params=None):
            if config.get("machine", False):
                raise NotImplementedError("Plain text translator")
            if text is None:  # BabelDOC 的能力探针，不是翻译请求。
                return None
            return self.request(text, True)

    output = source
    def publish_snapshot(output, coverage):
        # 已有有效译文不能被重试的原文占位或较旧快照覆盖。
        try:
            previous = json.loads((directory / 'artifact.json').read_text(encoding='utf-8'))
            same = previous.get('fingerprint') == digest and previous.get('configuration') == config['configuration']
            revision = previous.get('revision', '')
            readable = isinstance(revision, str) and len(revision) == 32 and all(c in '0123456789abcdef' for c in revision) and all((directory / f'{revision}-{kind}.pdf').is_file() for kind in ('mono', 'dual'))
            if same and readable and (coverage is None or (previous.get('coverage') or {}).get('translated', 0) > coverage['translated']):
                emit(type='artifact', artifact=previous)
                return
        except (OSError, ValueError):
            pass
        if fingerprint(source) != digest: raise ValueError('Source PDF changed during translation')
        artifact = publish(source, output, directory, skipped, dict(fingerprint=digest, configuration=config['configuration'],
                           strategy=config.get('strategy', ADAPTER), mode=config.get('mode', 'concise'), coverage=coverage))
        emit(type='artifact', artifact=artifact)

    if len(skipped) != page_count:
        from babeldoc.format.pdf import high_level
        from progressive_pipeline import install_pipeline
        install_adapter(high_level, config, emit)
        config['engine'] = ENGINE
        install_pipeline(high_level, config, emit, publish_snapshot)
        parameters = TranslationConfig(
            translator=Translator(), input_file=staged,
            lang_in=config["sourceLanguage"], lang_out=config["targetLanguage"],
            doc_layout_model=None, output_dir=staged.parent / "engine",
            working_dir=staged.parent / "work", pages=",".join(str(i + 1) for i in range(page_count) if i not in skipped),
            no_dual=True, use_rich_pbar=False, qps=1, pool_max_workers=1,
            auto_extract_glossary=False, disable_rich_text_translate=config.get("machine", False),
            skip_scanned_detection=True, watermark_output_mode=WatermarkOutputMode.NoWatermark,
        )
        result = None
        async for event in async_translate(parameters):
            if event["type"] == "finish":
                result = event["translate_result"]
                break  # 与 BabelDOC CLI 一致：finish 已携带完整产物，不再等待下一事件。
            elif event["type"] == "error":
                error = event.get('error', 'PDF layout failed')
                if isinstance(error, BaseException): raise error
                raise RuntimeError(str(error))
            elif event["type"].startswith("progress"):
                emit(type="progress", stage=event.get("stage", "layout"), percent=event.get("overall_progress", 0))
        if not result or not result.mono_pdf_path:
            raise RuntimeError("No translated PDF generated")
        output = result.mono_pdf_path
    if fingerprint(source) != digest:
        raise ValueError("Source PDF changed during translation")
    coverage = config.get('coverage', dict(total=0, translated=0, failed=0, preserved=0, failedPages=[]))
    publish_snapshot(output, coverage)
    artifact = json.loads((directory / 'artifact.json').read_text(encoding='utf-8'))
    emit(type="complete", pages=artifact['pages'], skipped=skipped, artifact=artifact, coverage=coverage)


def check_engine():
    """纯离线检查锁定版本、资产哈希、本机模型和 PDF 字体渲染，不发翻译请求。"""
    import importlib.metadata
    from unittest.mock import patch
    import babeldoc.const as const
    from babeldoc.assets.assets import generate_all_assets_file_list, verify_file
    if importlib.metadata.version('babeldoc') != '0.6.4':
        raise RuntimeError('Expected BabelDOC 0.6.4; reinstall the matching engine package.')
    emit(type='progress', stage='check', message='Verifying model and font files')
    for directory, files in generate_all_assets_file_list().items():
        for entry in files:
            if not verify_file(const.CACHE_FOLDER / directory / entry['name'], entry['sha3_256']):
                raise RuntimeError(f"Missing or damaged asset: {directory}/{entry['name']}. Import the offline package or repair the engine.")
    # 即使上游未来改为隐式下载，检测操作也不得联网。
    import httpx
    import requests
    with patch.object(httpx.AsyncClient, 'send', side_effect=RuntimeError('Engine check is offline')), \
            patch.object(httpx.Client, 'send', side_effect=RuntimeError('Engine check is offline')), \
            patch.object(requests.Session, 'send', side_effect=RuntimeError('Engine check is offline')):
        from babeldoc.docvision.doclayout import DocLayoutModel
        DocLayoutModel.load_available()
        import pymupdf
        document = pymupdf.open()
        page = document.new_page()
        page.insert_text((36, 36), 'Jadense engine check')
        if not page.get_pixmap().samples or 'Jadense' not in page.get_text():
            raise RuntimeError('PDF rendering check failed')
        document.close()
    emit(type='progress', stage='check', message='Offline model and PDF rendering checks passed')


def main():
    config = json.loads(sys.stdin.readline())
    with contextlib.redirect_stdout(sys.stderr):
        setup_cache(config["root"], config.get('assetRoot'))
        if config.get("operation") in ("prepare", "check"):
            for marker in (ENGINE, ADAPTER):
                (Path(config['root']) / marker).unlink(missing_ok=True)
            if config['operation'] == 'prepare':
                from babeldoc.assets.assets import warmup
                emit(type="progress", stage="assets", percent=0)
                warmup()
            check_engine()
            (Path(config["root"]) / ENGINE).write_text("ready", encoding="utf-8")
            (Path(config["root"]) / ADAPTER).write_text("ready", encoding="utf-8")
            emit(type="complete")
        else:
            asyncio.run(run(config))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit(type="error", category='incomplete' if isinstance(error, IncompleteTranslation) else 'engine', missing=getattr(error, 'missing', None), message=str(error))
        sys.exit(1)
