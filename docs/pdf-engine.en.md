# PDF layout and translation engine setup (0.6.0)

[README](../README.en.md) · [中文完整指南](pdf-engine.md)

The BabelDOC 0.6.4 engine parses PDF layouts and typesets translated PDFs. It is separate from OCR. Ordinary chat, selection translation and text-layer Markdown extraction do not require it. Configure a full-document translation service separately; model requests may incur charges. Scanned pages remain in their original form.

## Automatic setup

Open **Settings → External dependencies → Layout parsing engine**, or follow the dependency link under **Feature settings → Full translation**. Choose **Prepare PDF translation engine** and wait for **PDF translation engine ready**. First use of parallel translation also prepares the engine.

Source builds and ordinary PR previews keep the Windows x64 entry in [bundles.json](../content/pdf-translation/bundles.json) at `published: false`, so they do not point to unavailable assets. Tagged release builds temporarily write that release's exact URL and SHA-256 into the XPI and include the full bundle; the v0.6.5 release XPI can use it during automatic Windows x64 setup. Failed downloads, checksums or offline health checks report the install stage and retain the existing engine.

The previously released v0.6.0 engine ZIP remains available for manual import. The v0.6.5 Windows x64 offline suite will include the matching PDF and OCR engine ZIPs; see the [ZIP offline installation guide](usage-guide.md#windows-x64-zip-offline-installation) after that release is published.

The v0.6.5 candidate is not yet a public download. After release, get the complete ZIP and engine attachments from that version's GitHub Release. Before then, use the existing v0.6.0 PDF engine ZIP or source installer.

The settings show the installation directory: `jadense-pdf-translation/` inside your Zotero **profile**, which may differ from your library data directory. Allow at least 3 GiB for the roughly 441 MiB archive, 940 MiB extracted runtime and replacement workspace.

## Manual download and offline import

From [Releases](https://github.com/jadense-ai/jadense-in-zotero/releases), download `jadense-pdf-engine-0.6.4-1-windows-x64.zip` on a connected computer and transfer it. The attachment is available in v0.6.0.

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

The plugin starts its installer with `-ExecutionPolicy Bypass` in a separate PowerShell process, so the Windows default `Restricted` policy normally needs no change. `MachinePolicy`/`UserPolicy` Group Policy can override process settings, and AppLocker/WDAC or endpoint protection can block process launch or profile writes. Ask your administrator for an approved, scoped allow rule for the Zotero plugin operation; do not set machine-wide `Unrestricted`, disable antivirus, or repeatedly run Zotero as administrator. For certificate errors, check system time and trusted organizational certificates instead of bypassing TLS or package verification. A connection error alone does not establish that administrator privileges are needed.

## Recovery

Retry interrupted downloads or import a matching offline package. For missing or corrupt resources, use **Repair engine** or import again. Never disable hash checks or create ready markers yourself. Model/DLL errors may require system runtime or subprocess-policy fixes; changing the translation model will not repair the local engine. Installer error output, when present, is saved to `install.log` in the displayed directory. Review personal paths before sharing it.

OCR source settings do not change this engine's download source. If translation is partial but the engine is healthy, read/export completed output and retry missing segments instead of reinstalling.

Maintainers can use [the bundle builder](../scripts/build-pdf-engine.py) and [installation checker](../scripts/check-pdf-engine-install.py). Preserve [licenses](../THIRD_PARTY_NOTICES.md); never distribute user profiles, task output or credentials.
