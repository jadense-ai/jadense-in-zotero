# PDF layout and translation engine setup (0.6.6)

[README](../README.en.md) · [中文完整指南](pdf-engine.md)

The BabelDOC 0.6.4 engine parses PDF layouts and typesets translated PDFs. It is separate from OCR. Ordinary chat, selection translation and text-layer Markdown extraction do not require it. Configure a full-document translation service separately; model requests may incur charges. Scanned pages remain in their original form.

## Automatic setup

Open **Settings → External dependencies → Layout parsing engine**, or follow the dependency link under **Feature settings → Full translation**. Choose **Prepare PDF translation engine** and wait for **PDF translation engine ready**. First use of parallel translation also prepares the engine.

The Windows x64 release can download its engine automatically. If that download is unavailable, import the engine ZIP from the complete offline suite below. The plugin resumes interrupted automatic downloads and checks the result. For a ZIP you select manually, it extracts the package and checks Python, models, fonts and PDF rendering before replacing an existing engine.

The settings show the installation directory: `jadense-pdf-translation/` inside your Zotero **profile**, which may differ from your library data directory. Allow at least 3 GiB for the archive, extracted runtime and replacement workspace.

## Manual download and offline import

On a connected computer, open the [v0.6.6 release](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.6.6) and download `jadense-in-zotero-v0.6.6-windows-x64-offline.zip`. Transfer it to the Windows x64 computer and extract the outer ZIP.

1. Install `jadense-in-zotero-v0.6.6.xpi` from the extracted folder, then restart Zotero.
2. Open **Settings → External dependencies → Layout parsing engine → Import offline package** and select `jadense-pdf-engine-*.zip` from that folder. Keep this engine ZIP intact.
3. Wait for **PDF translation engine ready**. Original PDFs and saved `tasks/` results are preserved.

The suite includes Python, dependencies, models and fonts; administrator access, preinstalled Python and uv are not required.

If the check reports a missing VC++ runtime or a DLL load error under a deeply nested custom Zotero profile, use the [offline ZIP troubleshooting steps](usage-guide.md#windows-x64-zip-offline-installation) to verify the official x64 runtime and the profile path. For `Unexpected UTF-8 BOM`, upgrade the plugin to 0.6.6 and import the original engine ZIP again; the older Python request reader could not handle a leading BOM.

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

<a id="network-environment"></a>

## Network, proxy and managed environments

Browser access and working AI requests do not prove installer connectivity. GitHub Releases redirect downloads to asset hosts; source installation also needs Python, PyPI and model resources. Browser proxy extensions and OCR download-source settings do not configure this installer. Prefer the complete offline ZIP on restricted networks; it needs neither administrator privileges nor preinstalled Python/uv.

If an approved local HTTP proxy is needed for manual installation, first click **Check installed engine** to deploy the scripts. In a temporary **Windows PowerShell** window, replace the directory and HTTP port, then run all commands in that same window:

```powershell
$pdfRuntime = 'C:\path\to\profile\jadense-pdf-translation'
$pdfProxy = 'http://127.0.0.1:7890' # Example: replace with the actual HTTP proxy port
$env:HTTPS_PROXY = $pdfProxy
$env:HTTP_PROXY = $pdfProxy
[Net.WebRequest]::DefaultWebProxy = [Net.WebProxy]::new($pdfProxy)
& "$pdfRuntime\install.ps1" $pdfRuntime
if ($LASTEXITCODE -ne 0) { throw 'Dependency setup failed. Check network/proxy or import the complete package.' }
@{ operation = 'prepare'; root = $pdfRuntime } | ConvertTo-Json -Compress | & "$pdfRuntime\.venv\Scripts\python.exe" -s "$pdfRuntime\worker.py"
if ($LASTEXITCODE -ne 0) { throw 'Model setup failed. Check download errors or import the complete package.' }
@{ operation = 'check'; root = $pdfRuntime } | ConvertTo-Json -Compress | & "$pdfRuntime\.venv\Scripts\python.exe" -s "$pdfRuntime\worker.py"
```

These settings apply only to this window and child processes; closing the window ends them without changing system configuration. Older PowerShell uv downloads do not necessarily read `HTTPS_PROXY`, so the example also sets the .NET proxy and invokes the script with `&` in the same process. Use an HTTP endpoint, not a SOCKS endpoint. This example assumes a local proxy without authentication; ask your administrator about authenticated proxies and never post passwords in logs. If script execution is blocked, prefer offline import or contact your administrator rather than permanently relaxing machine-wide policy.

The plugin starts its installer with `-ExecutionPolicy Bypass` in a separate PowerShell process, so the Windows default `Restricted` policy normally needs no change. If a process or profile write is blocked, follow the [specific Windows troubleshooting steps](usage-guide.md#windows-x64-zip-offline-installation): inspect `Get-ExecutionPolicy -List`, Windows Security protection history and the named blocked program, then retry. For certificate errors, check system time and trusted certificates. A connection error alone does not establish that administrator privileges are needed.

## Recovery

Retry interrupted downloads or import the original offline package. For missing or corrupt resources, use **Repair engine** or import again. Model/DLL errors may require the official system runtime or an allowed subprocess; changing the translation model will not repair the local engine. Installer error output, when present, is saved to `install.log` in the displayed directory. Review personal paths before sharing it.

OCR source settings do not change this engine's download source. If translation is partial but the engine is healthy, read/export completed output and retry missing segments instead of reinstalling.

Maintainers can use [the bundle builder](../scripts/build-pdf-engine.py) and [installation checker](../scripts/check-pdf-engine-install.py). Preserve [licenses](../THIRD_PARTY_NOTICES.md); never distribute user profiles, task output or credentials.
