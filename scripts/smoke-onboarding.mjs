/**
 * 入门教学的原生专项验收。只在新建 profile/data 中加载实际 XPI，使用本机合成 BYOK 服务。
 * 伴随插件驱动实际 Manager DOM；不读取用户资料、不发送收费请求、不安装大型外置引擎。
 */
/* global Zotero, Components, ChromeUtils, IOUtils, PathUtils */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFile, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { buildReleasePaths, loadReleaseContext } from './release-common.mjs'

const COMPANION_ID = 'onboarding-smoke@jadense.invalid'
const SYNTHETIC_KEY = 'synthetic-onboarding-key-only'
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const option = (args, name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined

/** 首次明确派发返回可恢复失败；第二次返回完整回复，检查 hello 的真实业务链路。 */
async function startStub() {
  const requests = [], failures = []
  const server = createServer(async (request, response) => {
    const json = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
    try {
      if (request.url !== '/v1/chat/completions' || request.method !== 'POST') throw new Error(`Unexpected local request: ${request.method} ${request.url}`)
      if (request.headers.authorization !== `Bearer ${SYNTHETIC_KEY}`) throw new Error('Synthetic BYOK identity was not used')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (payload.model !== 'synthetic-onboarding-model' || payload.messages?.length !== 1
        || payload.messages[0].role !== 'user' || payload.messages[0].content !== '你好') throw new Error('Hello included unexpected source material, history, or model')
      requests.push({ method: request.method, path: request.url, prompt: '你好', stream: payload.stream })
      if (requests.length === 1) { json(400, { error: { message: 'SYNTHETIC_HELLO_FAILURE: correct the local fixture and retry', type: 'invalid_request_error' } }); return }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好，入门教学连接成功。SYNTHETIC_ONBOARDING_HELLO' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    } catch (error) { failures.push(String(error)); json(500, { error: String(error) }) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${server.address().port}`, requests, failures }
}

/** 序列化到隔离伴随插件，所有断言均来自实际 Gecko 文档与本地存储。 */
async function runHarness(config) {
  const report = { state: 'running', stage: 'startup', checks: [], screenshots: [], layouts: [] }
  const persist = () => IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2))
  const stage = async value => { report.stage = value; await persist() }
  const assert = (value, reason) => { if (!value) throw new Error(reason) }
  const normalize = value => String(value).replace(/\\/g, '/').replace(/\/$/u, '').toLowerCase()
  const waitFor = async (predicate, label, timeout = 20000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const value = await predicate()
      if (value) return value
      await Zotero.Promise.delay(80)
    }
    throw new Error(`Timed out: ${label}`)
  }
  let manager
  try {
    await Zotero.initializationPromise
    await Zotero.uiReadyPromise
    assert(normalize(Zotero.Profile.dir) === normalize(config.profileDir), 'Refusing a non-isolated profile')
    assert(normalize(Zotero.DataDirectory.dir) === normalize(config.dataDir), 'Refusing a non-isolated data directory')
    await waitFor(() => Zotero.Reader._registeredListeners.some(entry => entry.pluginID === config.pluginID), 'release runtime')
    Zotero.Prefs.set('extensions.jadenseInZotero.baseUrl', config.origin)
    Zotero.Prefs.set('extensions.jadenseInZotero.starInvitation', JSON.stringify({ uses: 0, lastPrompt: Date.now(), outcome: 'later' }), true)
    let doc
    const openManager = async () => {
      manager = Zotero.getMainWindow().openDialog('chrome://jadense-in-zotero/content/manager.xhtml?section=chat', 'jadense-onboarding-smoke',
        'chrome,dialog=no,titlebar,resizable,width=1100,height=850', { zotero: Zotero, section: 'chat', pluginID: config.pluginID })
      await waitFor(() => manager.document.readyState === 'complete' && manager.document.querySelector('.jdx-chat-message-list'), 'Manager document')
      doc = manager.document
    }
    await openManager()
    const dialog = () => doc.getElementById('jadense-quick-start-dialog')
    const visible = node => Boolean(node && !node.hidden && node.getClientRects().length)
    const active = () => dialog()?.open ? dialog() : doc.getElementById('jadense-onboarding-progress')
    const step = () => active()?.dataset.onboardingStep
    const action = name => [...doc.querySelectorAll(`[data-onboarding-action="${name}"]`)].find(visible)
    const click = async name => {
      await waitFor(() => action(name) || action('resume'), `visible action ${name} or progress banner`)
      if (!action(name)) { action('resume').click(); await Zotero.Promise.delay(80) }
      const button = await waitFor(() => action(name), `visible action ${name}`)
      assert(!button.disabled, `${name} is disabled`); button.click(); await Zotero.Promise.delay(100)
    }
    const expectStep = expected => waitFor(() => step() === expected, `onboarding step ${expected}; current ${step()}`)
    const screenshot = async name => {
      const { capture } = ChromeUtils.importESModule('chrome://remote/content/shared/Capture.sys.mjs')
      const target = Components.utils.unwaiveXrays(manager)
      const canvas = await capture.canvas(target, target.browsingContext || target.docShell?.browsingContext, 0, 0, manager.innerWidth, manager.innerHeight)
      const binary = manager.atob(capture.toBase64(canvas, 'image/png'))
      const file = PathUtils.join(config.outputDir, `${name}.png`)
      await IOUtils.write(file, Uint8Array.from(binary, c => c.charCodeAt(0)))
      report.screenshots.push(file)
    }
    const layout = async name => {
      await Zotero.Promise.delay(150)
      const panel = active(), rect = panel.getBoundingClientRect()
      assert(panel.scrollWidth <= panel.clientWidth + 2, `${name}: tutorial horizontal overflow`)
      assert(rect.left >= -2 && rect.right <= manager.innerWidth + 2, `${name}: tutorial outside viewport`)
      const buttons = [...panel.querySelectorAll('button')].filter(visible)
      assert(buttons.length, `${name}: no reachable actions`)
      for (const button of buttons) {
        const bounds = button.getBoundingClientRect()
        assert(bounds.left >= rect.left - 2 && bounds.right <= rect.right + 2, `${name}: action outside tutorial`)
      }
      report.layouts.push({ name, viewportWidth: manager.innerWidth, viewportHeight: manager.innerHeight, panelWidth: rect.width, scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth })
      await screenshot(name)
    }
    await stage('first-use-and-appearance')
    await expectStep('choose')
    assert(dialog().open, 'First use did not open the tutorial modal')
    assert(config.language === 'en-US' ? dialog().textContent.includes('Choose how to connect to AI') : dialog().textContent.includes('先选择一种 AI 配置方式'), 'Onboarding does not use the startup language')
    for (const theme of ['light', 'dark']) {
      Zotero.Prefs.set('extensions.jadenseInZotero.theme', theme, true)
      manager.resizeTo(1100, 850)
      Zotero.Prefs.set('extensions.jadenseInZotero.fontScale', 100, true)
      await layout(`choose-${config.language}-${theme}-1100`)
      manager.resizeTo(720, 850)
      Zotero.Prefs.set('extensions.jadenseInZotero.fontScale', 150, true)
      await layout(`choose-${config.language}-${theme}-720-150`)
    }
    report.checks.push('first-use-modal', `native-${config.language}-light-dark-1100-720-150-layout`)
    Zotero.Prefs.set('extensions.jadenseInZotero.fontScale', 100, true)
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', 'light', true)
    manager.resizeTo(1100, 850)
    await stage('token-entry-and-skip-confirmation')
    await click('route-jadense')
    await expectStep('configure')
    if (dialog().open) await click('open-config')
    await waitFor(() => doc.getElementById('jadense-settings-tab-connection')?.getAttribute('aria-selected') === 'true', 'token configuration entry')
    await click('skip'); await expectStep('skip')
    assert(dialog().open, 'Skip warning is not modal')
    await screenshot('skip-warning')
    await click('continue'); await expectStep('configure')
    await click('skip'); await expectStep('skip'); await click('confirm-skip'); await expectStep('community')
    assert(dialog().textContent.includes('455214858'), 'Skip did not show the requested QQ group')
    await screenshot('skip-community')
    manager.close(); await openManager(); await expectStep('community')
    assert(dialog().textContent.includes('455214858'), 'Pending community invitation was lost after window close')
    await click('close-community')
    assert(!dialog().open, 'Community close did not dismiss the modal')
    report.checks.push('token-settings-entry', 'skip-warning-cancel-confirm', 'skip-community-pending-resume-qq-close')
    await stage('help-reopen-and-byok-entry')
    doc.getElementById('jadense-help-toggle').click()
    doc.getElementById('jadense-help-onboarding').click()
    await expectStep('choose')
    await click('route-byok'); await expectStep('configure')
    if (dialog().open) await click('open-config')
    await waitFor(() => doc.getElementById('jadense-settings-tab-ai')?.getAttribute('aria-selected') === 'true', 'BYOK configuration entry')
    report.checks.push('help-reopens-tutorial', 'byok-settings-entry')
    Zotero.Prefs.set('extensions.jadenseInZotero.byokConfig', JSON.stringify({ version: 2, activeProviderId: 'onboarding-provider', activeModelId: 'onboarding-model',
      providers: [{ id: 'onboarding-provider', name: 'Synthetic onboarding', protocol: 'openai-chat-completions', baseUrl: config.origin + '/v1', apiKey: config.key }],
      models: [{ id: 'onboarding-model', providerId: 'onboarding-provider', name: 'Synthetic hello', model: 'synthetic-onboarding-model', maxOutputTokens: 256 }] }))
    Zotero.Prefs.set('extensions.jadenseInZotero.aiModelSettings', JSON.stringify({ version: 1, followChatModel: true, models: { chat: { route: 'byok', modelId: 'onboarding-model' } } }), true)
    doc.getElementById('jadense-manager-nav-chat').click()
    const draft = doc.getElementById('jadense-chat-input')
    draft.value = 'SYNTHETIC_UNSENT_DRAFT_MUST_SURVIVE'
    draft.dispatchEvent(new manager.Event('input', Components.utils.cloneInto({ bubbles: true }, manager)))
    const file = new manager.File(manager.Array.of('SYNTHETIC_UNSENT_ATTACHMENT_MUST_NOT_BE_SENT'), 'onboarding-unsent.md', Components.utils.cloneInto({ type: 'text/markdown' }, manager))
    const transfer = new manager.DataTransfer(); transfer.items.add(file)
    const upload = doc.getElementById('jadense-chat-image-input'); upload.files = transfer.files
    upload.dispatchEvent(new manager.Event('change', Components.utils.cloneInto({ bubbles: true }, manager)))
    await waitFor(() => doc.querySelector('#jadense-chat-image-preview .jdx-chat-file-name')?.textContent === 'onboarding-unsent.md', 'synthetic unsent attachment')
    const assertDraft = () => {
      assert(doc.getElementById('jadense-chat-input').value === 'SYNTHETIC_UNSENT_DRAFT_MUST_SURVIVE', 'Tutorial cleared or replaced the existing unsent draft')
      assert(doc.querySelector('#jadense-chat-image-preview .jdx-chat-file-name')?.textContent === 'onboarding-unsent.md', 'Tutorial removed the unsent attachment')
    }
    await click('verify-config'); await expectStep('hello')
    await stage('hello-failure-and-success')
    await click('send-hello')
    await waitFor(() => [...doc.querySelectorAll('[data-onboarding-action="send-hello"]')].some(node => visible(node) && !node.disabled), 'hello failure retry action')
    assert(step() === 'hello', 'Failed hello advanced the tutorial')
    assertDraft()
    await screenshot('hello-failure')
    await click('send-hello'); await expectStep('engines-choice')
    assertDraft()
    const chats = JSON.parse(Zotero.Prefs.get('extensions.jadenseInZotero.localChatState') || '{}')
    assert(chats.sessions?.some(session => session.messages.some(message => message.role === 'assistant' && message.status === 'complete' && message.text.includes('SYNTHETIC_ONBOARDING_HELLO'))), 'Successful hello was not stored as a complete reply')
    report.checks.push('hello-failure-retains-step', 'hello-explicit-retry-complete-local-byok', 'hello-preserves-unsent-draft-and-attachment')
    await stage('optional-engines-and-offline-help')
    await click('need-engines'); await expectStep('engines')
    await click('open-ocr')
    await waitFor(() => doc.querySelector('[data-settings-target="ocr"]')?.getAttribute('aria-current') === 'page', 'OCR settings entry')
    await click('open-layout')
    await waitFor(() => doc.querySelector('[data-settings-target="layout"]')?.getAttribute('aria-current') === 'page', 'PDF layout settings entry')
    await click('offline-help')
    const text = () => active()?.textContent || ''
    await waitFor(() => /GitHub/u.test(text()) && /百度|Baidu/u.test(text()) && /夸克|Quark/u.test(text()), 'all offline download channels')
    await layout('engines-offline-help')
    const baidu = active().querySelector('[data-engine-download-channel="baidu"]')
    assert(baidu?.querySelector('a')?.getAttribute('href') === 'https://pan.baidu.com/s/1YXrqXBao6uEA2BZKz1WlTw?pwd=4sci' && /4sci/u.test(baidu.textContent), 'Baidu should show the replacement share and access code')
    manager.resizeTo(720, 850); Zotero.Prefs.set('extensions.jadenseInZotero.fontScale', 150, true)
    for (const theme of ['light', 'dark']) {
      Zotero.Prefs.set('extensions.jadenseInZotero.theme', theme, true)
      await layout(`engines-offline-${config.language}-${theme}-720-150`)
    }
    manager.resizeTo(1100, 850); Zotero.Prefs.set('extensions.jadenseInZotero.fontScale', 100, true)
    await click('check-engines')
    await waitFor(() => action('check-engines') && !action('check-engines').disabled, 'read-only engine check')
    assert(step() === 'engines', 'Missing engines were incorrectly marked as installed')
    report.checks.push('optional-engines-ocr-pdf-settings', 'offline-github-baidu-quark', 'missing-engines-remain-incomplete')
    await click('skip'); await expectStep('skip'); await click('confirm-skip'); await expectStep('community'); await click('close-community')
    doc.getElementById('jadense-help-toggle').click(); doc.getElementById('jadense-help-onboarding').click()
    await expectStep('choose'); await click('route-byok'); await expectStep('configure'); await click('verify-config'); await expectStep('hello')
    await click('send-hello'); await expectStep('engines-choice'); await click('no-engines'); await expectStep('community')
    assert(dialog().textContent.includes('455214858'), 'Completion did not show QQ group')
    await screenshot('completed-community'); await click('close-community')
    manager.close(); await openManager(); await Zotero.Promise.delay(200)
    assert(!dialog().open && !visible(doc.getElementById('jadense-onboarding-progress')), 'Completed tutorial reopened automatically')
    report.checks.push('optional-engines-declined-completes', 'completed-community-qq-close', 'completed-window-reopen-no-invitation')
    report.state = 'passed'; report.stage = 'complete'; await persist()
  } catch (error) {
    report.state = 'failed'; report.error = `${error}\n${error?.stack || ''}`
    report.onboardingDOM = manager?.document?.getElementById('jadense-quick-start-dialog')?.outerHTML
    report.progressDOM = manager?.document?.getElementById('jadense-onboarding-progress')?.outerHTML
    await persist()
  }
}

/** 验证程序只终止命令行含本次随机 profile 的进程。 */
async function stopIsolated(child, profileDir) {
  if (process.platform === 'win32') {
    const script = "$taskProfile = $env:JADENSE_ONBOARDING_SMOKE_PROFILE\nGet-CimInstance Win32_Process -Filter \"Name='zotero.exe'\" | Where-Object { $_.CommandLine -like ('*' + $taskProfile + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    const stopper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, JADENSE_ONBOARDING_SMOKE_PROFILE: profileDir }, windowsHide: true, stdio: 'ignore' })
    await new Promise((resolve, reject) => { stopper.once('error', reject); stopper.once('exit', code => code === 0 ? resolve() : reject(new Error('Unable to stop isolated Zotero'))) })
  } else if (child?.exitCode === null) child.kill('SIGTERM')
  await delay(500)
}

/** 清理前核对随机测试目录，禁止递归操作其他目录。 */
async function removeIsolated(root) {
  const target = await realpath(root), temp = await realpath(tmpdir())
  if (path.dirname(target) !== temp || !path.basename(target).startsWith('jadense-zotero-onboarding-smoke-')) throw new Error('Refused cleanup outside the isolated test root')
  await rm(target, { recursive: true, force: true })
}

async function main() {
  const args = process.argv.slice(2)
  const executable = option(args, '--zotero') ?? (args[0]?.startsWith('-') ? undefined : args[0]) ?? process.env.ZOTERO_EXE
  if (!executable) throw new Error('Usage: node scripts/smoke-onboarding.mjs <Zotero executable> [--xpi file] [--output directory] [--keep-temp]')
  const timeout = Number(option(args, '--timeout-ms') ?? 180000)
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('The smoke timeout must be positive')
  const { facts, version } = await loadReleaseContext()
  const xpi = path.resolve(option(args, '--xpi') ?? buildReleasePaths(facts, version).artifactPath)
  const outputDir = path.resolve(option(args, '--output') ?? '../../outputs/zotero-onboarding-20261021/native')
  const root = await mkdtemp(path.join(tmpdir(), 'jadense-zotero-onboarding-smoke-'))
  const profileDir = path.join(root, 'profile'), dataDir = path.join(root, 'data'), extensionsDir = path.join(profileDir, 'extensions')
  const reportPath = path.join(outputDir, 'onboarding-report.json')
  const stub = await startStub()
  let child, stdout, stderr, passed = false
  try {
    await mkdir(extensionsDir, { recursive: true }); await mkdir(dataDir, { recursive: true }); await mkdir(outputDir, { recursive: true })
    const pluginID = facts.manifest.applications.zotero.id
    await copyFile(xpi, path.join(extensionsDir, pluginID + '.xpi'))
    const config = { pluginID, profileDir, dataDir, outputDir, reportPath, origin: stub.origin, key: SYNTHETIC_KEY, language: option(args, '--language') ?? 'zh-CN' }
    const zip = new JSZip()
    zip.file('manifest.json', JSON.stringify({ manifest_version: 2, name: 'Isolated onboarding smoke', version: '1.0.0', applications: { zotero: { id: COMPANION_ID, update_url: 'https://example.invalid/onboarding-updates.json', strict_min_version: '9.0', strict_max_version: '10.0.*' } } }))
    zip.file('bootstrap.js', [`const config = ${JSON.stringify(config)};`, runHarness.toString(), 'function startup() { void runHarness(config).catch(error => Zotero.logError(error)); }', 'function shutdown() {}', 'function install() {}', 'function uninstall() {}'].join('\n'))
    await writeFile(path.join(extensionsDir, COMPANION_ID + '.xpi'), await zip.generateAsync({ type: 'nodebuffer' }))
    await writeFile(path.join(profileDir, 'user.js'), ['user_pref("extensions.autoDisableScopes", 0);', 'user_pref("extensions.enabledScopes", 15);', 'user_pref("extensions.update.enabled", false);', 'user_pref("intl.locale.requested", "zh-CN");', `user_pref("extensions.jadenseInZotero.displayLanguage", ${JSON.stringify(config.language)});`].join('\n'))
    await writeFile(reportPath, JSON.stringify({ state: 'starting', stage: 'launching-isolated-zotero' }))
    stdout = await open(path.join(outputDir, 'zotero.stdout.log'), 'w'); stderr = await open(path.join(outputDir, 'zotero.stderr.log'), 'w')
    child = spawn(executable, ['-no-remote', '-profile', profileDir, '-datadir', dataDir, '-ZoteroDebugText'], { windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd] })
    let spawnError, previousStage, report
    child.once('error', error => { spawnError = error })
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (spawnError) throw spawnError
      report = await readFile(reportPath, 'utf8').then(JSON.parse).catch(() => undefined)
      if (report?.stage !== previousStage) { previousStage = report?.stage; console.log('Onboarding smoke:', previousStage) }
      if (report?.state === 'failed') throw new Error(report.error)
      if (report?.state === 'passed') break
      await delay(250)
    }
    if (report?.state !== 'passed') throw new Error(`Onboarding smoke timed out at ${report?.stage}`)
    if (stub.failures.length) throw new Error(stub.failures.join('\n'))
    if (stub.requests.length !== 3) throw new Error(`Expected three explicit hello requests, received ${stub.requests.length}`)
    passed = true
    console.log(`Onboarding native smoke passed: ${report.checks.length} checks; ${report.screenshots.length} screenshots. Report: ${reportPath}`)
  } finally {
    if (child) await stopIsolated(child, profileDir)
    await Promise.all([stdout?.close(), stderr?.close()])
    await new Promise(resolve => stub.server.close(resolve))
    await writeFile(path.join(outputDir, 'stub-requests.json'), JSON.stringify({ requests: stub.requests, failures: stub.failures }, null, 2))
    await writeFile(path.join(outputDir, 'verification.json'), JSON.stringify({ passed, xpi, root, reportPath, isolatedProfile: true, realCredentials: false, realProviderRequests: false, engineDownloads: false }, null, 2))
    if (passed && !args.includes('--keep-temp')) {
      await removeIsolated(root)
    } else console.log('Isolated smoke profile retained:', root)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1 })
