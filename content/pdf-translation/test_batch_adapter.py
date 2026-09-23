"""容量与补缺回归：无网络、无真实论文，直接调用生产适配器。"""
import json
import unittest
import tempfile
import threading
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from batch_adapter import batches, fits, prompt, parse_outputs, split_row, valid_output, install_adapter, ProviderFailure, merge_fragments, preserved, repeated_margins

BUDGET = dict(batchTokens=1600, contextWindow=16384, maxOutputTokens=8192)
measure = lambda text: (len(text) + 2) // 3


class BatchingTests(unittest.TestCase):
    def test_repairs_local_json_without_guessing_passage_identity_or_truncated_text(self):
        rows = [dict(id='a', text='First {v1}.'), dict(id='b', text='Second.'), dict(id='c', text='Third.')]
        fixtures = [
            ('Here is the translation:\n```json\n[{"id":"a","output":"译文 {v1}。",},{"id":"b","output":"第二段。"},]\n```', {'a': '译文 {v1}。', 'b': '第二段。'}),
            ('[{"id":"a","output":"译文 {v1}。"},{"id":"b","output":"第二段。"},{"id":"c","output":"截断', {'a': '译文 {v1}。', 'b': '第二段。'}),
            ('{"a":"译文 {v1}。","b":"第二段。"}', {'a': '译文 {v1}。', 'b': '第二段。'}),
            ('{"translations":[{"id":"a","translation":"译文 {v1}。"}]}', {'a': '译文 {v1}。'}),
        ]
        for raw, expected in fixtures:
            with self.subTest(raw=raw): self.assertEqual(parse_outputs(raw, rows), expected)

    def test_local_repair_preserves_content_and_refuses_ambiguous_or_missing_markers(self):
        rows = [dict(id='a', text='Text <b0>bold</b0> {v1} ⟦F2⟧'), dict(id='b', text='Second')]
        encoded = [{"id": "a", "output": "译文 &lt;b0&gt;加粗&lt;/b0&gt; ｛ v1 ｝ ⟦ F2 ⟧"}]
        self.assertEqual(parse_outputs(json.dumps(encoded), rows), {'a': '译文 <b0>加粗</b0> {v1} ⟦F2⟧'})
        self.assertEqual(parse_outputs('[{"id":"b","output":"same"},{"id":"b","output":"same"}]', rows), {'b': 'same'})
        self.assertEqual(parse_outputs('[{"id":"b","output":"one"},{"id":"b","output":"two"}]', rows), {})
        self.assertEqual(parse_outputs('[{"output":"no ID"}]', rows), {})
        self.assertEqual(parse_outputs(json.dumps([dict(id='a', output='Missing placeholders')]), rows), {})
        self.assertEqual(parse_outputs("[{'id':'b','output':'literal ,} and quote \"hello\"'}]", rows), {'b': 'literal ,} and quote "hello"'})
        self.assertEqual(parse_outputs('[{"id":"b","output":"line one\nline two"}]', rows), {'b': 'line one\nline two'})
        self.assertEqual(parse_outputs(r'[{"id":"b","output":"math \(x\)"}]', rows), {'b': r'math \(x\)'})
        nested = json.dumps([dict(id='b', output='Example: {"id":"a","output":"must remain text"}')])
        self.assertEqual(parse_outputs(nested[:-1], [dict(id='b', text='Example: {"id":"a","output":"must remain text"}')]), {'b': 'Example: {"id":"a","output":"must remain text"}'})
        self.assertEqual(parse_outputs('[{"id":"b","output":"complete text"', rows), {'b': 'complete text'})
        self.assertEqual(parse_outputs('[{"id":"a","id":"b","output":"ambiguous"}]', rows), {})
        self.assertEqual(parse_outputs('[{"id":"b","output":"one","output":"two"}]', rows), {})
        self.assertEqual(parse_outputs('[{"id":"b","output":"same","future":1,"future":2}]', rows), {'b': 'same'})
        self.assertEqual(parse_outputs("[{'id':'a','id':'b','output':'ambiguous'}]", rows), {})

    def test_chinese_font_reduction_preserves_shared_source_and_formula_styles(self):
        from batch_adapter import reduce_chinese_font_size
        from babeldoc.format.pdf.document_il.il_version_1 import PdfParagraphComposition, PdfSameStyleUnicodeCharacters
        for language, expected in [('zh-CN', 8.5), ('zh-TW', 8.5), ('en', 10)]:
            with self.subTest(language=language):
                target = paragraph('Source')
                source_style = target.pdf_style
                original = target.pdf_paragraph_composition[0]
                translated = PdfSameStyleUnicodeCharacters(unicode='中文译文', pdf_style=source_style)
                target.pdf_paragraph_composition.append(PdfParagraphComposition(pdf_same_style_unicode_characters=translated))
                reduce_chinese_font_size(target, language)
                self.assertEqual(translated.pdf_style.font_size, expected)
                self.assertEqual(source_style.font_size, 10)
                self.assertIs(original.pdf_line.pdf_character[0].pdf_style, source_style)

    def test_machine_capacity_preserves_legacy_prompt_boundary(self):
        row = dict(id='legacy', text='Original content.', label='text')
        output = measure(row['text']) * 3 + 512 + measure(json.dumps([{'id': row['id'], 'output': ''}]))
        budget = {**BUDGET, 'contextWindow': measure(prompt([row], 'zh-CN', cross_layout=False)) + output}
        self.assertTrue(fits([row], measure, {**budget, 'machine': True}, 'zh-CN'))
        self.assertFalse(fits([row], measure, budget, 'zh-CN'))

    def test_capacity_boundaries_report_the_limiting_budget(self):
        rows = [dict(id=str(i), text='中文正文 {v1}<b0>强调</b0>。' * 3, label='text', context='Heading') for i in range(3)]
        source = measure(rows[0]['text'])
        pair_output = 2 * source * 3 + 512 + measure(json.dumps([{'id': row['id'], 'output': ''} for row in rows[:2]]))
        for reason, budget in [
            ('source', {**BUDGET, 'batchTokens': source}),
            ('context', {**BUDGET, 'contextWindow': measure(prompt(rows[:2], 'zh-CN')) + pair_output - 1}),
        ]:
            with self.subTest(reason=reason):
                ends = Counter()
                groups = list(batches(rows, measure, budget, 'zh-CN', ends))
                self.assertEqual(groups, [[row] for row in rows])
                self.assertEqual(ends, {reason: 2, 'end': 1})
                self.assertTrue(all(fits(group, measure, budget, 'zh-CN') for group in groups))

    def test_page_column_breaks_do_not_waste_capacity_or_merge_styles(self):
        rows = [dict(id=str(i), text=f'Passage {i} <b0>evidence</b0> {{v1}}.' * 4,
                     label=['title', 'text', 'caption', 'footnote'][i % 4],
                     context=f'Section {i // 8}', breakBefore=i % 4 == 0) for i in range(24)]
        # 固定三页双栏，每栏四段；复现旧页面/栏目强制断点作为对照。
        old, pending = [], []
        for row in rows:
            if pending and (row['breakBefore'] or not fits(pending + [row], measure, BUDGET, 'zh-CN')):
                old.append(pending); pending = []
            pending.append(row)
        if pending: old.append(pending)
        groups = list(batches(rows, measure, BUDGET, 'zh-CN'))
        self.assertLess(len(groups), len(old))
        self.assertEqual([row for group in groups for row in group], rows)
        self.assertTrue(all(fits(group, measure, BUDGET, 'zh-CN') for group in groups))
        for group in groups:
            returned = json.dumps([dict(id=row['id'], output=row['text'], extra=True) for row in reversed(group)])
            self.assertEqual(parse_outputs(returned, group), {row['id']: row['text'] for row in group})
        tokens = sum(measure(row['text']) for row in rows)
        print(json.dumps(dict(fixture='three-pages-two-columns', old_requests=len(old), new_requests=len(groups),
                              old_rows=len(rows)/len(old), new_rows=len(rows)/len(groups),
                              old_fill=tokens/len(old)/1600, new_fill=tokens/len(groups)/1600, repairs=0)))

    def test_reduces_requests_and_keeps_every_passage(self):
        rows = [dict(id=str(i), text='Evidence ' * 34, label='text') for i in range(60)]
        groups = list(batches(rows, measure, BUDGET, 'zh-CN'))
        self.assertEqual([row for group in groups for row in group], rows)
        self.assertTrue(all(fits(group, measure, BUDGET, 'zh-CN') for group in groups))
        # 旧 200-token 规则为每两段一批（30 次），新策略不超过 6 次。
        self.assertLessEqual(len(groups), 6)
        print(json.dumps(dict(old_requests=30, new_requests=len(groups), reduction=1-len(groups)/30)))

    def test_long_paragraph_is_lossless_and_never_splits_markers(self):
        text = ('Long sentence with evidence. ' * 100) + '{v1}<b0>Preserved format</b0>⟦F2⟧' + (' Second sentence.' * 100)
        row = dict(id='p1', text=text, label='text')
        budget = {**BUDGET, 'batchTokens': 200}
        parts = split_row(row, measure, budget, 'zh-CN')
        self.assertEqual(''.join(part['text'] for part in parts), text)
        self.assertEqual(len({part['id'] for part in parts}), len(parts))
        self.assertTrue(all(fits([part], measure, budget, 'zh-CN') for part in parts))
        self.assertTrue(any('{v1}' in part['text'] for part in parts))

    def test_maps_reordered_ids_and_contains_duplicate_missing_and_formula_damage(self):
        rows = [dict(id=str(i), text='hello {v1}') for i in range(4)]
        values = [dict(id='2', output='译文 {v1}', future=True), dict(id='1', output='译文'), dict(id='0', output='a {v1}'), dict(id='0', output='b {v1}'), dict(id='unknown', output='ignored')]
        self.assertEqual(parse_outputs(json.dumps(values), rows), {'2': '译文 {v1}'})
        self.assertEqual(parse_outputs('not JSON', rows), {})
        self.assertFalse(valid_output('a {v1}', 'b {v2}'))
        self.assertFalse(valid_output('a {v1}', 'b {v1}{v1}'))

    def test_accounts_for_prompt_and_output_not_just_source(self):
        row = dict(id='x', text='source ' * 10, label='text', context='Heading ' * 100)
        self.assertFalse(fits([row], measure, {**BUDGET, 'contextWindow': 500}, 'zh-CN'))
        self.assertTrue(fits([row], measure, {**BUDGET, 'maxOutputTokens': 520}, 'zh-CN'))

    def test_output_budget_is_only_used_to_reconstruct_legacy_boundaries(self):
        rows = [dict(id=str(i), text='Evidence ' * 20, label='text') for i in range(3)]
        budget = {**BUDGET, 'maxOutputTokens': 800}
        self.assertEqual(list(batches(rows, measure, budget, 'zh-CN')), [rows])
        self.assertEqual(list(batches(rows, measure, budget, 'zh-CN', legacy=True)), [[row] for row in rows])
        long = dict(id='long', text='Evidence ' * 80, label='text')
        self.assertGreater(len(split_row(long, measure, budget, 'zh-CN')), 1)
        self.assertEqual(split_row(long, measure, {key: value for key, value in budget.items() if key != 'maxOutputTokens'}, 'zh-CN'), [long])

    def test_repairs_only_missing_once_and_preserves_identity_after_uncertain_result(self):
        module = SimpleNamespace()
        install_adapter(module, {}, lambda **event: None)
        with tempfile.TemporaryDirectory() as directory:
            adapter = module.ILTranslatorLLMOnly.__new__(module.ILTranslatorLLMOnly)
            adapter.lock = threading.Lock()
            adapter.cache = {}
            adapter.cache_path = Path(directory) / 'cache.json'
            adapter.base = SimpleNamespace(calc_token_count=measure)
            adapter.config = SimpleNamespace(raise_if_cancelled=lambda: None)
            adapter.language = 'zh-CN'
            adapter.stats = dict(batches=0, repairs=0, completed=0, batchTokens=[])
            rows = [dict(id=str(i), text='hello {v1}', label='text') for i in range(3)]
            calls = []
            def request(text, llm, operation):
                inputs = json.loads(text.split('\n', 1)[1]); calls.append((operation, inputs))
                if len(calls) == 1:
                    return json.dumps([dict(id=inputs[0]['id'], output='译文 {v1}')])
                if len(calls) == 2:
                    raise TimeoutError('unconfirmed provider result')
                return json.dumps([dict(id=row['id'], output='译文 {v1}') for row in inputs])
            adapter.translator = SimpleNamespace(request=request)
            with self.assertRaises(TimeoutError): adapter.translate_batch(rows)
            self.assertEqual(adapter.cache['0'], '译文 {v1}')
            self.assertEqual([r['id'] for r in calls[1][1]], ['p1'])
            adapter.cache = json.loads(adapter.cache_path.read_text())
            adapter.translate_batch(rows)
            self.assertEqual(calls[1], calls[2])
            self.assertTrue(all(valid_output(row['text'], adapter.cache[row['id']]) for row in rows))

    def test_invalid_json_stops_after_two_repairs_and_manual_retry_gets_new_generation(self):
        module = SimpleNamespace()
        install_adapter(module, {}, lambda **event: None)
        with tempfile.TemporaryDirectory() as directory:
            adapter = module.ILTranslatorLLMOnly.__new__(module.ILTranslatorLLMOnly)
            adapter.lock, adapter.cache = threading.Lock(), {}
            adapter.cache_path = Path(directory) / 'cache.json'
            adapter.base = SimpleNamespace(calc_token_count=measure)
            adapter.config = SimpleNamespace(raise_if_cancelled=lambda: None)
            adapter.language = 'zh-CN'
            adapter.stats = dict(batches=0, repairs=0, completed=0, batchTokens=[])
            calls = []
            def request(text, llm, operation): calls.append(operation); return 'invalid JSON'
            adapter.translator = SimpleNamespace(request=request)
            rows = [dict(id='1', text='hello', label='text')]
            adapter.translate_batch(rows)
            self.assertEqual(len(calls), 3)
            adapter.translate_batch(rows)
            self.assertEqual(len(set(calls)), 6)


def paragraph(text, x=40, y=600, label='text'):
    from babeldoc.format.pdf.document_il.il_version_1 import PdfParagraph, PdfStyle, Box, PdfParagraphComposition, PdfCharacter, PdfLine, VisualBbox
    style = PdfStyle(font_id='F1', font_size=10)
    chars = [PdfCharacter(char_unicode=c, pdf_style=style, box=Box(x+i*5, y, x+(i+1)*5, y+10), visual_bbox=VisualBbox(box=Box(x+i*5, y, x+(i+1)*5, y+10))) for i, c in enumerate(text)]
    return PdfParagraph(unicode=text, layout_label=label, layout_id=1, xobj_id=0, box=Box(x,y,x+len(text)*5,y+10), pdf_style=style,
                        pdf_paragraph_composition=[PdfParagraphComposition(pdf_line=PdfLine(pdf_character=chars))])


def document(paragraphs):
    return SimpleNamespace(page=[SimpleNamespace(pdf_font=[], pdf_xobject=[], pdf_paragraph=paragraphs, cropbox=SimpleNamespace(box=SimpleNamespace(y=0,y2=800)))])


class ResilienceTests(unittest.TestCase):
    def test_compact_lines_salvage_complete_passages_and_retry_only_truncated_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            def request(text, *args, **kwargs):
                inputs = json.loads(text.split('\n', 1)[1]); calls.append(inputs)
                self.assertIn('one JSON object per line', text)
                self.assertEqual([row['id'] for row in inputs], [f'p{i + 1}' for i in range(len(inputs))])
                if len(calls) == 1:
                    return '{"p2":"第二段 {v1}"}\n{"p1":"第一段"}\n{"p3":"截断'
                self.assertEqual([row['input'] for row in inputs], ['Third'])
                return '{"p1":"第三段"}'
            adapter, _ = self.adapter(directory, request)
            rows = [dict(id='a' * 64, text='First', label='text'), dict(id='b' * 64, text='Second {v1}', label='text'), dict(id='c' * 64, text='Third', label='text')]
            adapter.translate_batch(rows)
            self.assertEqual(len(calls), 2)
            self.assertEqual([adapter.cache[row['id']] for row in rows], ['第一段', '第二段 {v1}', '第三段'])
            wire = '\n'.join(json.dumps({f'p{i + 1}': ''}) for i in range(len(rows)))
            legacy = json.dumps([dict(id=row['id'], output='') for row in rows])
            self.assertLess(len(wire), len(legacy) / 4)

    def test_compact_lines_contain_duplicate_ids_and_preserve_multiline_text(self):
        rows = [dict(id='p1', text='first'), dict(id='p2', text='second')]
        self.assertEqual(parse_outputs('{"p1":"one"}\n{"p1":"two"}\n{"p2":"line one\\nline two"}', rows), {'p2': 'line one\nline two'})
        self.assertEqual(parse_outputs('{"p1":"one","p1":"two"}\n{"p2":"complete"}', rows), {'p2': 'complete'})

    def test_restart_regroups_only_missing_across_previous_batch_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            budget = {**BUDGET, 'batchTokens': 20}
            rows = [dict(id=str(i), text=f'Source paragraph number {i}.', label='text') for i in range(6)]
            calls = []
            def request(text, *args, **kwargs):
                inputs = json.loads(text.split('\n', 1)[1]); calls.append([row['input'] for row in inputs])
                return '\n'.join(json.dumps({row['id']: 'translated'}) for row in inputs)
            adapter, _ = self.adapter(directory, request, budget=budget)
            original = list(batches(rows, measure, budget, 'zh-CN'))
            self.assertEqual([len(group) for group in original], [2, 2, 2])
            adapter.save({row['id']: 'already recovered' for row in rows[::2]})
            adapter, _ = self.adapter(directory, request, budget=budget)
            adapter.stats['batchEndReasons'] = Counter()
            for group in adapter.scheduled_batches(rows): adapter.translate_batch(group)
            self.assertEqual(calls, [[rows[1]['text'], rows[3]['text']], [rows[5]['text']]])
            self.assertTrue(all(adapter.cache[row['id']] == 'already recovered' for row in rows[::2]))

    def test_restart_preserves_frozen_legacy_request_before_regrouping(self):
        from batch_adapter import digest, STRATEGY
        with tempfile.TemporaryDirectory() as directory:
            rows = [dict(id=str(i), text=f'Source paragraph {i}.', label='text') for i in range(3)]
            batch_id = digest([row['id'] for row in rows])
            calls = []
            def request(text, llm, operation):
                calls.append((text, operation))
                return '[{"id":"1","output":"recovered"}]'
            adapter, _ = self.adapter(directory, request)
            adapter.save({'0': 'already recovered', '2': 'already recovered'}, batch_id,
                         dict(cycle=0, attempt=1, shrink=True, ids=['1'], groups=[['1']], cursor=0))
            adapter, _ = self.adapter(directory, request)
            adapter.stats['batchEndReasons'] = Counter()
            for group in adapter.scheduled_batches(rows): adapter.translate_batch(group)
            self.assertEqual(calls, [(prompt([rows[1]], 'zh-CN'), digest([STRATEGY, batch_id, 0, 1, ['1']]))])
            self.assertEqual(adapter.cache['1'], 'recovered')

    def test_restart_recovers_compact_frozen_group_with_same_input_and_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            rows = [dict(id=str(i), text=f'Source paragraph {i}.', label='text') for i in range(4)]
            calls = []
            def request(text, llm, operation):
                inputs = json.loads(text.split('\n', 1)[1]); calls.append((text, operation))
                if len(calls) == 1: return '{"p1":"saved"}\n{"p2":"saved"}'
                if len(calls) == 2: raise TimeoutError('unconfirmed')
                return '\n'.join(json.dumps({row['id']: 'recovered'}) for row in inputs)
            adapter, _ = self.adapter(directory, request)
            with self.assertRaises(TimeoutError): adapter.translate_batch(rows)
            adapter, _ = self.adapter(directory, request)
            adapter.stats['batchEndReasons'] = Counter()
            for group in adapter.scheduled_batches(rows): adapter.translate_batch(group)
            self.assertEqual(calls[1], calls[2])
            retried = [row['input'] for text, _ in calls[1:] for row in json.loads(text.split('\n', 1)[1])]
            self.assertNotIn(rows[0]['text'], retried)
            self.assertNotIn(rows[1]['text'], retried)
            self.assertTrue(all(valid_output(row['text'], adapter.cache[row['id']]) for row in rows))

    def test_repaired_structure_completes_batch_without_another_provider_call(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            def request(text, *args, **kwargs):
                rows = json.loads(text.split('\n', 1)[1]); calls.append(rows)
                return 'Translations follow:\n```json\n' + json.dumps([dict(id=row['id'], translation='translated') for row in rows])[:-1]
            adapter, _ = self.adapter(directory, request)
            rows = [dict(id=str(i), text='Source paragraph.', label='text') for i in range(4)]
            adapter.translate_batch(rows)
            self.assertEqual(len(calls), 1)
            self.assertEqual(adapter.stats['repairs'], 0)
            self.assertTrue(all(adapter.cache[str(i)] == 'translated' for i in range(4)))

    def test_shrinks_batches_then_repairs_single_passages_without_retranslating_success(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            def request(text, *args, **kwargs):
                rows = json.loads(text.split('\n', 1)[1]); calls.append([row['input'] for row in rows])
                if len(calls) == 1:
                    return json.dumps([dict(id=rows[0]['id'], output='translated')])
                if len(rows) > 1: return 'invalid JSON'
                return json.dumps([dict(id=rows[0]['id'], output='translated')])
            adapter, _ = self.adapter(directory, request)
            rows = [dict(id=str(i), text=f'Source paragraph {i}.', label='text') for i in range(6)]
            adapter.translate_batch(rows)
            self.assertEqual([len(group) for group in calls], [6, 3, 2, 1, 1, 1, 1, 1])
            self.assertTrue(all('Source paragraph 0.' not in group for group in calls[1:]))
            self.assertTrue(all(adapter.cache[str(i)] == 'translated' for i in range(6)))

    def adapter(self, directory, request, mode='concise', budget=BUDGET):
        config = dict(directory=directory, mode=mode, workers=1)
        module = SimpleNamespace()
        install_adapter(module, config, lambda **event: None)
        adapter = module.ILTranslatorLLMOnly.__new__(module.ILTranslatorLLMOnly)
        adapter.lock, adapter.stop_dispatch = threading.Lock(), threading.Event()
        adapter.cache_path = Path(directory)/'paragraphs-v3.json'
        adapter.cache = json.loads(adapter.cache_path.read_text()) if adapter.cache_path.exists() else {}
        adapter.passages, adapter.machine = [], False
        adapter.budget, adapter.language = budget, 'zh-CN'
        adapter.stats = dict(total=0, completed=0, cacheHits=0, batches=0, repairs=0, batchTokens=[])
        adapter.config = SimpleNamespace(raise_if_cancelled=lambda: None)
        def post(p, tracker, prepared, text): p.unicode = text
        adapter.base = SimpleNamespace(calc_token_count=measure, pre_translate_paragraph=lambda p,*args: (p.unicode,SimpleNamespace(unicode=p.unicode)), post_translate_paragraph=post)
        adapter.translator = SimpleNamespace(request=request)
        return adapter, config

    def test_cross_page_column_requests_restore_each_paragraph_and_context(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            def request(text, *args, **kwargs):
                inputs = json.loads(text.split('\n', 1)[1]); calls.append(inputs)
                return json.dumps([dict(id=row['id'], output='译文 ' + row['input']) for row in reversed(inputs)])
            adapter, config = self.adapter(directory, request, mode='full')
            pages = []
            for page in range(3):
                items = [paragraph(f'Section {page}.', 40, 700, 'title'),
                         paragraph(f'Body {page} <b0>bold</b0>.', 40, 600),
                         paragraph(f'Caption {page} {{v1}}.', 320, 700, 'caption'),
                         paragraph(f'Footnote {page}.', 320, 600, 'footnote')]
                pages.append(document(items).page[0])
            docs = SimpleNamespace(page=pages)
            source = [[p.unicode for p in page.pdf_paragraph] for page in pages]
            adapter.translate(docs)
            self.assertEqual(len(calls), 1)
            self.assertEqual(adapter.stats['batchRows'], [12])
            self.assertEqual(adapter.stats['batchEndReasons'], {'end': 1})
            self.assertEqual(adapter.stats['repairs'], 0)
            self.assertEqual(config['coverage']['translated'], 12)
            self.assertEqual(config['coverage']['failed'], 0)
            for page_index, page in enumerate(pages):
                self.assertEqual([p.unicode for p in page.pdf_paragraph], ['译文 ' + text for text in source[page_index]])
                self.assertEqual([row['context'] for row in calls[0][page_index*4:(page_index+1)*4]], [f'Section {page_index}.'] * 4)

    def test_cancelled_batch_does_not_dispatch_or_change_cached_output(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter, _ = self.adapter(directory, lambda *args, **kwargs: self.fail('cancelled request dispatched'))
            adapter.stop_dispatch.set()
            adapter.translate_batch([dict(id='x', text='Original.', label='text')])
            self.assertNotIn('x', adapter.cache)

    def test_partial_results_keep_originals_and_retry_only_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            def request(text, *args, **kwargs):
                rows=json.loads(text.split('\n',1)[1]); calls.append(rows)
                return json.dumps([dict(id=rows[0]['id'], output='translated')]) if len(calls)==1 else 'invalid'
            adapter, config = self.adapter(directory, request)
            originals = [paragraph('Sentence number '+str(i)+'.', y=600-i*40) for i in range(3)]
            docs = document(originals[:]); adapter.translate(docs)
            self.assertEqual(config['coverage']['translated'],1)
            self.assertEqual(config['coverage']['failed'],2)
            self.assertIs(docs.page[0].pdf_paragraph[1],originals[1])
            self.assertEqual(len(calls),5)
            def retry(text,*args,**kwargs):
                rows=json.loads(text.split('\n',1)[1]); self.assertEqual(len(rows),2)
                return json.dumps([dict(id=row['id'],output='repaired') for row in rows])
            adapter, config = self.adapter(directory,retry)
            adapter.translate(document(originals[:]))
            self.assertEqual(config['coverage']['failed'],0)
            self.assertEqual(adapter.stats['cacheHits'],1)

    def test_service_error_stops_dispatch_but_all_originals_remain(self):
        with tempfile.TemporaryDirectory() as directory:
            calls=[]
            def request(*args,**kwargs): calls.append(1); raise ProviderFailure('RATE_LIMITED',True)
            adapter,config=self.adapter(directory,request,budget={**BUDGET,'batchTokens':20})
            originals=[paragraph('Sentence number '+str(i)+'.', y=600-i*40) for i in range(8)]
            docs=document(originals[:]); adapter.translate(docs)
            self.assertEqual(len(calls),1)
            self.assertEqual(config['coverage']['translated'],0)
            self.assertEqual(config['coverage']['failed'],8)
            self.assertEqual(docs.page[0].pdf_paragraph,originals)

    def test_split_paragraph_never_exposes_half_translated_text(self):
        with tempfile.TemporaryDirectory() as directory:
            count=[]
            def request(text,*args,**kwargs):
                rows=json.loads(text.split('\n',1)[1]); count.append(1)
                return json.dumps([dict(id=rows[0]['id'],output='first part')]) if len(count)==1 else 'invalid'
            adapter,config=self.adapter(directory,request,budget={**BUDGET,'batchTokens':40})
            original=paragraph('Long sentence. '*60)
            docs=document([original]); adapter.translate(docs)
            self.assertEqual(config['coverage']['failed'],1)
            self.assertIs(docs.page[0].pdf_paragraph[0],original)
            self.assertGreater(len(adapter.cache),1)

    def test_fragment_join_preserves_table_column_and_original_characters(self):
        a,b,c=paragraph('market',40,label='fallback_line'),paragraph('beta',72,label='fallback_line'),paragraph('Other column',160,label='fallback_line')
        original_top = a.box.y2
        # 模拟空格旧字体造成的异常高包围盒，不能把整行抬到表格横线。
        a.box.y2 += 20
        c.box.y2 += 20
        groups=merge_fragments(document([a,b,c]).page[0])
        self.assertEqual(len(groups),2)
        self.assertEqual(groups[0][0].unicode,'market beta')
        self.assertEqual(a.unicode,'market')
        self.assertEqual(groups[0][1],[a,b])
        self.assertLessEqual(groups[0][0].box.y2, original_top)
        self.assertEqual(groups[1][1],[c])
        self.assertLessEqual(groups[1][0].box.y2, original_top)
        # 合并发生在 StylesAndFormulas 之前，必须保留其接受的 PdfLine 形状。
        from babeldoc.format.pdf.document_il.midend.styles_and_formulas import StylesAndFormulas
        styles=StylesAndFormulas.__new__(StylesAndFormulas)
        styles.process_page_styles(SimpleNamespace(pdf_paragraph=[groups[0][0]]))
        self.assertIsNotNone(groups[0][0].pdf_style)
        self.assertTrue(groups[0][0].pdf_paragraph_composition)

    def test_repeated_margins_do_not_exclude_academic_footnotes(self):
        pages=[]
        for i in range(3):
            header=paragraph('Journal 2026',y=770,label='abandon')
            footnote=paragraph('Academic footnote '+str(i),y=20,label='abandon')
            pages.append(document([header,footnote]).page[0])
        repeated=repeated_margins(SimpleNamespace(page=pages))
        self.assertEqual(preserved(pages[0].pdf_paragraph[0],pages[0],'concise',repeated),(True,True))
        self.assertEqual(preserved(pages[0].pdf_paragraph[1],pages[0],'concise',repeated),(False,False))
        self.assertEqual(preserved(pages[0].pdf_paragraph[0],pages[0],'full',repeated),(False,True))

    def test_full_mode_reuses_margins_and_never_translates_numeric_cells(self):
        with tempfile.TemporaryDirectory() as directory:
            requests=[]
            def request(text,*args,**kwargs):
                rows=json.loads(text.split('\n',1)[1]); requests.extend(rows)
                return json.dumps([dict(id=row['id'],output='translated') for row in rows])
            adapter,config=self.adapter(directory,request,mode='full')
            pages=[]
            for i in range(3):
                pages.append(document([paragraph('Journal 2026',y=770,label='abandon'), paragraph('Result '+str(i)+'.'), paragraph('(0.23)***',y=300)]).page[0])
            docs=SimpleNamespace(page=pages); adapter.translate(docs)
            self.assertEqual(config['coverage']['deduplicated'],2)
            self.assertEqual(config['coverage']['translated'],6)
            self.assertEqual(len(requests),4)
            self.assertTrue(all(page.pdf_paragraph[-1].unicode=='(0.23)***' for page in docs.page))

    def test_validation_reasons_are_structural_and_do_not_contain_response(self):
        from collections import Counter
        reasons=Counter()
        parse_outputs('[{"id":"a","output":"private text"}]', [dict(id='a',text='formula {v1}'),dict(id='b',text='missing')],reasons)
        self.assertEqual(reasons,{'placeholder_mismatch':1,'missing_id':1})


if __name__ == '__main__': unittest.main()
