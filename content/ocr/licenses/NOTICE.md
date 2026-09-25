# OCR runtime sources

The independent Python distribution retains its licenses under `python/`.
Python dependencies retain their upstream license files in `python/Lib/site-packages/`;
versions and source distribution locations are recorded in `uv.lock`.

Model weights are unchanged from their pinned upstream files:

- Docling layout egret large: Apache-2.0, https://huggingface.co/docling-project/docling-layout-egret-large
- Docling TableFormer models v2.3.0: CDLA-Permissive-2.0, https://huggingface.co/docling-project/docling-models/tree/v2.3.0
- RapidOCR weights: distributed by RapidAI, https://github.com/RapidAI/RapidOCR; retain the package licenses.

Full license texts for Apache-2.0 and CDLA-Permissive-2.0 are included alongside this notice.
The adapter and build scripts are delivered as source with the plugin distribution.
