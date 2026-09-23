"""BabelDOC 0.6.4 的解析检查点与渐进排版；不修改第三方安装目录。

worker 提供原子发布，适配器负责有效译文映射；本模块仅持有未翻译版面。
SPDX-License-Identifier: AGPL-3.0-or-later
"""
from dataclasses import fields, is_dataclass
import hashlib
import json
from pathlib import Path
import shutil
import time
import uuid
from typing import get_args, get_origin

from batch_adapter import atomic_replace

LAYOUT_VERSION = 'layout-v1'


def clone_document(document):
    """沿用版面缓存格式复制文档，将惰性绘图链迭代展开为字符串。

    deepcopy 会递归遍历 BabelDOC 的长 parent 链；序列化只保留排版需要的
    指令值，恢复后译文和排版修改仍与原始版面完全隔离。
    """
    from babeldoc.format.pdf.document_il.xml_converter import XMLConverter

    return restore_document(type(document), json.loads(XMLConverter().to_json(document)))


def restore_document(model, value):
    """恢复上游 dataclass 字段名 JSON；XML 别名解析器不能读取其 JSON 导出。"""
    values = {}
    for field in fields(model):
        if field.name not in value:
            continue
        item, kind = value[field.name], field.type
        if item is not None:
            if get_origin(kind) is list:
                child = get_args(kind)[0]
                if is_dataclass(child): item = [restore_document(child, row) for row in item]
            else:
                child = next((part for part in (get_args(kind) or (kind,)) if is_dataclass(part)), None)
                if child: item = restore_document(child, item)
        values[field.name] = item
    return model(**values)


def install_pipeline(high_level, config, emit, publish_snapshot):
    """替换单文档入口；保留上游任务监控与收尾，不重复调用已缓存解析阶段。"""
    from babeldoc.format.pdf.document_il import il_version_1
    from babeldoc.format.pdf.document_il.xml_converter import XMLConverter

    class SnapshotPDFCreator(high_level.PDFCreater):
        @staticmethod
        def save_pdf_with_timeout(pdf, output_path, translation_config, **options):
            # 渐进成果保留完整字体，不启动每次可等待 60 秒的字体/clean 子进程。
            options.pop('tag', None)
            options.pop('timeout', None)
            options['clean'] = False
            pdf.save(output_path, **options)
            return False

    def run(pm, parameters):
        parameters.progress_monitor = pm
        parameters.skip_clean = True
        # 字体与语言会影响公式/样式解析；Provider、批次及翻译范围不参与缓存身份。
        identity = dict(version=LAYOUT_VERSION, engine=config['engine'], source=config['fingerprint'],
                        attachment=config.get('layoutIdentity', config['directory']),
                        sourceLanguage=config['sourceLanguage'], targetLanguage=config['targetLanguage'])
        key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        cache = Path(config['root']) / 'layouts' / key
        prepared = parameters.get_working_file_path('input.pdf')
        converter = XMLConverter()
        reason = 'missing'
        try:
            manifest = json.loads((cache / 'layout.json').read_text(encoding='utf-8'))
            if manifest['identity'] != identity:
                raise ValueError('incompatible')
            revision = manifest['revision']
            if len(revision) != 32 or any(c not in '0123456789abcdef' for c in revision):
                raise ValueError('invalid revision')
            for suffix in ('pdf', 'json'):
                payload = (cache / f'{revision}.{suffix}').read_bytes()
                if hashlib.sha256(payload).hexdigest() != manifest['hashes'][suffix]:
                    raise ValueError('damaged checkpoint')
            docs = restore_document(il_version_1.Document, json.loads((cache / f'{revision}.json').read_text(encoding='utf-8')))
            shutil.copyfile(cache / f'{revision}.pdf', prepared)
            mediabox = {int(k): v for k, v in manifest['mediabox'].items()}
            for name in ('_rawBlocks', '_organized'):
                count = manifest.get('counts', {}).get(name)
                if isinstance(count, int) and count >= 0: config[name] = count
            emit(type='progress', stage='layout_cached', percent=0)
        except Exception as error:
            reason = 'missing' if isinstance(error, FileNotFoundError) else 'invalid'
            emit(type='progress', stage='parse', reason=reason, percent=0)
            document = high_level.open_pdf_with_save_fallback(parameters.input_file, prepared)
            try:
                try:
                    high_level.fix_null_page_content(document)
                    high_level.fix_filter(document)
                    high_level.fix_null_xref(document)
                except Exception:
                    pass  # 与上游一致：非必要修复失败不阻断可解析文档。
                mediabox = high_level.fix_media_box(document)
                document = high_level.save_pdf_with_same_path_fallback(document, prepared)
                from babeldoc.format.pdf.new_parser.native_parse import parse_prepared_pdf_with_new_parser_to_legacy_ir
                docs = parse_prepared_pdf_with_new_parser_to_legacy_ir(prepared, config=parameters, doc_pdf=document)
                docs = high_level.LayoutParser(parameters).process(docs, document)
                high_level.close_process_pool()
                high_level.ParagraphFinder(parameters).process(docs)
                high_level.StylesAndFormulas(parameters).process(docs)
            finally:
                document.close()
            # 清单最后提交；缓存写入失败仍允许本次翻译与成果发布。
            try:
                cache.mkdir(parents=True, exist_ok=True)
                revision = uuid.uuid4().hex
                converter.write_json(docs, cache / f'{revision}.json')
                shutil.copyfile(prepared, cache / f'{revision}.pdf')
                hashes = {suffix: hashlib.sha256((cache / f'{revision}.{suffix}').read_bytes()).hexdigest() for suffix in ('pdf', 'json')}
                manifest = dict(identity=identity, revision=revision, hashes=hashes, mediabox=mediabox,
                                counts={k: config[k] for k in ('_rawBlocks', '_organized') if k in config})
                temporary = cache / 'layout.tmp.json'
                temporary.write_text(json.dumps(manifest), encoding='utf-8')
                atomic_replace(temporary, cache / 'layout.json')
            except Exception:
                emit(type='warning', stage='layout_cache_failed')

        translator = high_level.ILTranslator(parameters.translator, parameters)
        last_publish = 0.0
        last_translated = -1
        last_result = None

        def render(document, coverage):
            nonlocal last_result
            if coverage['translated'] == 0:
                output = config['source']
            else:
                high_level.Typesetting(parameters).typesetting_document(document)
                result = SnapshotPDFCreator(prepared, document, parameters, mediabox).write(parameters)
                result.original_pdf_path = parameters.input_file
                high_level.fix_cmap(result, parameters)
                last_result = result
                output = result.mono_pdf_path
            publish_snapshot(output, coverage)

        def snapshot(original, force=False):
            nonlocal last_publish, last_translated
            if not force and last_translated > 0 and time.monotonic() - last_publish < 10:
                return
            try:
                document = clone_document(original)
                local = high_level.ILTranslator(parameters.translator, parameters)
                local.translate(document, render_only=True)
                coverage = config['coverage']
                if not force and coverage['translated'] <= last_translated:
                    return
                render(document, coverage)
                last_publish = time.monotonic()
                last_translated = coverage['translated']
            except Exception:
                emit(type='warning', stage='snapshot_failed')

        config['_snapshot'] = snapshot
        # 先发布原文占位，即使恢复缓存译文的排版失败也有可读原页。
        total = sum(bool(p.unicode and any(c.isalpha() for c in p.unicode)) for page in docs.page for p in page.pdf_paragraph)
        publish_snapshot(config['source'], dict(total=total, translated=0, failed=total, preserved=0, failedPages=[]))
        working = clone_document(docs)
        try:
            translator.translate(working)
            if config['coverage']['translated'] != last_translated:
                render(working, config['coverage'])
        except Exception:
            # 主流程故障也尝试仅从已落盘译文恢复；不再发送 Provider 请求。
            snapshot(docs, force=True)
            raise
        finally:
            config.pop('_snapshot', None)
        if last_result is None:
            from babeldoc.format.pdf.translation_config import TranslateResult
            untouched = parameters.get_working_file_path('untranslated.pdf')
            shutil.copyfile(config['source'], untouched)
            last_result = TranslateResult(mono_pdf_path=untouched, dual_pdf_path=None)
            last_result.original_pdf_path = parameters.input_file
        return last_result

    high_level._do_translate_single = run
