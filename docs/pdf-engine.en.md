# PDF layout and translation engine setup (0.6.0 — unreleased)

[README](../README.en.md) · [中文完整指南](pdf-engine.md)

The BabelDOC 0.6.4 engine parses PDF layouts and typesets translated PDFs. It is separate from OCR. Ordinary chat, selection translation and text-layer Markdown extraction do not require it. Configure a full-document translation service separately; model requests may incur charges. Scanned pages remain in their original form.

## Automatic setup

Open **Settings → External dependencies → PDF translation engine**, or follow the dependency link under **Feature settings → Full translation**. Choose **Prepare PDF translation engine** and wait for **PDF translation engine ready**. First use of parallel translation also prepares the engine.

In this source candidate, the Windows x64 entry in [bundles.json](../content/pdf-translation/bundles.json) is still `published: false`. Automatic setup therefore uses the bundled `install.ps1` / `install.sh`: reuse or download uv, install isolated Python 3.12 and locked dependencies, then fetch models and fonts. GitHub, Python distribution, PyPI and asset downloads must be reachable. No preinstalled Python or system Python changes are needed.

After a complete ZIP is publicly released, verified and enabled in the manifest, Windows x64 can download that fixed bundle with partial-download recovery, up to three attempts per source, SHA-256 verification and offline checks. The reserved URL is not an available download yet.

The settings show the installation directory: `jadense-pdf-translation/` inside your Zotero **profile**, which may differ from your library data directory. Allow at least 3 GiB for the roughly 441 MiB archive, 940 MiB extracted runtime and replacement workspace.

## Manual download and offline import

Once available in [Releases](https://github.com/jadense-ai/jadense-in-zotero/releases), download `jadense-pdf-engine-0.6.4-1-windows-x64.zip` on a connected computer and transfer it. The attachment becomes available when v0.6.0 is published.

- Size: **462102143 bytes**.
- SHA-256: `b9b160f727f3bb962df8011a14131250c20753f64faac1793e902dbf6b6cf887`.
- Platform: **Windows x64 only**.

Choose **Import offline package** and select the ZIP without extracting it. The plugin verifies the hash, loads models and checks PDF rendering before replacing the runtime. Original PDFs and saved `tasks/` results are preserved. The complete bundle includes Python, dependencies, models and fonts; administrator access, Python and uv are not required.

## Repository fallback and manual setup

The repository fallback is [content/pdf-translation/](../content/pdf-translation/): installation scripts, lockfile and adapter source, **not a second binary ZIP or model mirror**. It still needs network access for dependencies and assets.

First choose **Check installed engine** to deploy bundled installation files; a missing-engine message is expected before installation. Copy the displayed directory and stop active layout jobs. If installation files are missing, use source matching your installed plugin version and copy `pyproject.toml`, `uv.lock`, `worker.py`, `batch_adapter.py`, `progressive_pipeline.py`, `install.ps1`, `install.sh`, `install-bundle.ps1` and `bundles.json` into that directory.

On Windows, replace the example path and run PowerShell:

```powershell
$pdfRuntime = 'C:\path\to\profile\jadense-pdf-translation'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$pdfRuntime\install.ps1" $pdfRuntime
if ($LASTEXITCODE -ne 0) { throw 'Engine dependency installation failed' }
@{ operation = 'prepare'; root = $pdfRuntime } | ConvertTo-Json -Compress | & "$pdfRuntime\.venv\Scripts\python.exe" -s "$pdfRuntime\worker.py"
@{ operation = 'check'; root = $pdfRuntime } | ConvertTo-Json -Compress | & "$pdfRuntime\.venv\Scripts\python.exe" -s "$pdfRuntime\worker.py"
```

On macOS/Linux:

```sh
pdf_runtime='/path/to/profile/jadense-pdf-translation'
sh "$pdf_runtime/install.sh" "$pdf_runtime"
# Continue only if installation succeeded.
printf '{"operation":"prepare","root":"%s"}\n' "$pdf_runtime" | "$pdf_runtime/.venv/bin/python" -s "$pdf_runtime/worker.py"
printf '{"operation":"check","root":"%s"}\n' "$pdf_runtime" | "$pdf_runtime/.venv/bin/python" -s "$pdf_runtime/worker.py"
```

Return to **Check installed engine**. It verifies versions, resource hashes, model loading and PDF rendering without downloading or calling translation services. Windows x64 has installation validation; macOS, Linux and Windows ARM64 have not been validated. Do not install an x64 Windows bundle on another platform.

## Recovery

Retry interrupted downloads or import a matching offline package. For missing or corrupt resources, use **Repair engine** or import again. Never disable hash checks or create ready markers yourself. Model/DLL errors may require system runtime or subprocess-policy fixes; changing the translation model will not repair the local engine. Installer error output, when present, is saved to `install.log` in the displayed directory. Review personal paths before sharing it.

OCR source settings do not change this engine's download source. If translation is partial but the engine is healthy, read/export completed output and retry missing segments instead of reinstalling.

Maintainers can use [the bundle builder](../scripts/build-pdf-engine.py) and [installation checker](../scripts/check-pdf-engine-install.py). Preserve [licenses](../THIRD_PARTY_NOTICES.md); never distribute user profiles, task output or credentials.
