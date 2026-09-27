/** OCR 服务设置：草稿不影响运行任务，保存时显式选择服务并确认上传范围。 */
import type { ZoteroLike } from './runtime'
import { CLOUD_OCR_SERVICES, OCR_ENGINE_PREF, cloudOCRConfig, cloudEndpoint, ocrEngine, saveCloudOCRConfig, type CloudOCREngine, type OCREngine } from './cloud-ocr-config'
import { testCloudOCR } from './cloud-ocr'
import { CloudOCRError } from './cloud-ocr-client'
import { createJdxSelect } from './custom-select'
import { uiText } from './ui-preferences'
import { modeEnabled, observeJadenseMode, saveOCREngine } from './jadense-mode-state'
import { jadenseAiClient } from './jadense-ai'
import { jadenseOCRSnapshot } from './jadense-ocr'
import { observeOCRProgress } from './local-ocr'

export function wireCloudOCRSettings(host: ZoteroLike, root: HTMLElement, onEngine: (engine: OCREngine) => void) {
  const doc = root.ownerDocument
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]; node.textContent = text; return node
  }
  const section = make('section'); section.className = 'jdx-ocr-section'
  const selector = make('div'), select = createJdxSelect(selector, { ariaLabel: uiText('识别引擎', 'OCR engine') })
  const setOptions = () => select.setOptions([{ value: 'local', label: uiText('本机 OCR', 'Local OCR') }, ...(modeEnabled(host) ? [{ value: 'jadense', label: uiText('攻玉学术', 'Jadense Academic') }] : []), ...Object.entries(CLOUD_OCR_SERVICES).map(([value, service]) => ({ value, label: service.name }))], ocrEngine(host))
  setOptions()
  const cloud = make('div'), endpoint = make('input'), model = make('input'), key = make('input')
  endpoint.type = 'url'; key.type = 'password'; key.autocomplete = 'off'; model.type = 'text'
  endpoint.dataset.ocrSetting = 'endpoint'; model.dataset.ocrSetting = 'model'; key.dataset.ocrSetting = 'key'
  const field = (name: string, input: HTMLElement) => { const label = make('label', name); label.className = 'jdx-cloud-ocr-field'; label.append(input); return label }
  const consent = make('input'); consent.type = 'checkbox'
  const consentLabel = make('label', uiText('我同意将 PDF 或选区图片发送给此服务，并承担平台可能收取的费用。', 'I agree to send PDFs or selected images to this service and pay any provider charges.')); consentLabel.prepend(consent); consentLabel.className = 'jdx-cloud-ocr-consent'
  const link = make('a', uiText('获取 API 密钥', 'Get an API key')); link.target = '_blank'; link.rel = 'noopener noreferrer'
  link.addEventListener('click', event => { event.preventDefault(); const engine = select.getValue() as CloudOCREngine; const url = CLOUD_OCR_SERVICES[engine]?.link; if (url) (host as ZoteroLike & { launchURL?(url: string): void }).launchURL?.(url) })
  const save = make('button', uiText('保存并使用', 'Save and use')), test = make('button', uiText('测试识别', 'Test OCR')), stop = make('button', uiText('停止测试', 'Stop test'))
  for (const b of [save, test, stop]) { b.type = 'button'; b.className = 'jdx-button' }
  stop.hidden = true
  const status = make('p'); status.setAttribute('role', 'status'); status.dataset.ocrSummaryState = 'unchecked'
  const preset = make('div'), models = createJdxSelect(preset, { ariaLabel: uiText('预置模型', 'Model preset') })
  models.setOptions([{ value: 'deepseek-ai/DeepSeek-OCR', label: 'DeepSeek-OCR' }, { value: 'PaddlePaddle/PaddleOCR-VL', label: 'PaddleOCR-VL' }], 'deepseek-ai/DeepSeek-OCR')
  models.onChange(value => { model.value = value; status.dataset.ocrSummaryState = 'unchecked' })
  for (const field of [endpoint, model, key, consent]) field.addEventListener('input', () => { status.dataset.ocrSummaryState = 'unchecked' })
  const actions = make('div'); actions.className = 'jdx-actions'; actions.append(save, test, stop)
  cloud.append(field('API URL', endpoint), preset, field(uiText('模型', 'Model'), model), field('API Key / Token', key), link, make('p', uiText('测试仅发送内置小图，可能产生少量费用。密钥优先保存在系统登录管理器，不同步到攻玉。取消后云端任务可能继续执行和计费。', 'The test sends a built-in image and may incur a small charge. Keys use the login manager and are not synced to Jadense. Remote processing and billing may continue after cancellation.')), consentLabel, actions, status)
  const managed = make('div'), managedInfo = make('p'), managedStatus = make('p'), managedTest = make('button', uiText('测试识别', 'Test OCR')), localReady = make('p')
  managedTest.type = 'button'; managedTest.className = 'jdx-button'; managedStatus.setAttribute('role', 'status')
  const managedStop = make('button', uiText('停止测试', 'Stop test')); managedStop.type = 'button'; managedStop.className = 'jdx-button'; managedStop.hidden = true
  managed.append(managedInfo, make('p', uiText('使用攻玉账号积分。测试仅发送内置小图，可能产生少量费用；页面或选区由攻玉及上游模型服务处理。', 'Uses Jadense points. Testing sends a built-in image and may incur a small charge; pages or regions are processed by Jadense and its providers.')), managedTest, managedStop, managedStatus, localReady)
  section.append(make('h4', uiText('识别引擎', 'OCR engine')), selector, cloud, managed); root.append(section)
  let disposed = false, revision = 0, originalEndpoint = '', originalConsent = false, controller: AbortController | undefined
  const load = async () => {
    const current = ++revision, engine = select.getValue() as OCREngine
    cloud.hidden = engine === 'local' || engine === 'jadense'; managed.hidden = engine !== 'jadense'; onEngine(engine)
    if (engine === 'local') return
    if (engine === 'jadense') {
      managedInfo.textContent = uiText('由攻玉学术提供', 'Provided by Jadense')
      try { const catalog = await jadenseAiClient(host).getZoteroAiCapabilities(); if (!disposed && revision === current) managedInfo.textContent = `${catalog.ocr.displayName ?? uiText('尚未配置', 'Not configured')} · ${catalog.ocr.available ? uiText('账号已连接', 'Account connected') : uiText('请检查账号权限、订阅或服务配置', 'Check permissions, subscription or service configuration')}` }
      catch { if (!disposed && revision === current) managedInfo.textContent = uiText('请先连接攻玉账号。', 'Connect your Jadense account first.') }
      return
    }
    status.dataset.ocrEngine = engine; status.dataset.ocrSummaryState = 'unchecked'
    status.textContent = ''; save.disabled = test.disabled = true
    const config = await cloudOCRConfig(host, engine)
    if (disposed || revision !== current) return
    endpoint.value = originalEndpoint = config.endpoint; model.value = config.model; key.value = config.key; consent.checked = originalConsent = config.consent
    preset.hidden = engine !== 'siliconflow'; models.setValue(config.model)
    link.hidden = !CLOUD_OCR_SERVICES[engine].link; link.href = CLOUD_OCR_SERVICES[engine].link
    save.disabled = test.disabled = false
  }
  endpoint.addEventListener('input', () => { consent.checked = endpoint.value.replace(/\/$/u, '') === originalEndpoint ? originalConsent : false })
  const execute = async (testing: boolean) => {
    const engine = select.getValue() as CloudOCREngine
    if (!Object.hasOwn(CLOUD_OCR_SERVICES, engine)) return
    status.dataset.ocrSummaryState = 'checking'
    controller = new AbortController(); save.disabled = test.disabled = true; select.setDisabled(true); stop.hidden = !testing
    try {
      const config = { engine, endpoint: cloudEndpoint(endpoint.value), model: model.value.trim(), key: key.value.trim(), consent: consent.checked }
      if (!config.consent || !config.key || !config.model) { status.dataset.ocrSummaryState = 'unchecked'; status.textContent = uiText('请填写密钥、模型并确认上传及费用。', 'Enter a key and model, and confirm upload and billing.'); return }
      if (testing) {
        status.textContent = uiText('正在识别测试图片…', 'Recognizing the test image…')
        const text = await testCloudOCR(host, config, doc, controller.signal)
        if (!disposed) status.textContent = uiText('连接成功：', 'Connected: ') + text.slice(0, 300)
      } else {
        const persistent = await saveCloudOCRConfig(host, config)
        saveOCREngine(host, engine)
        originalEndpoint = config.endpoint; originalConsent = true
        status.textContent = persistent ? uiText('已保存，重启后无需重新填写密钥。', 'Saved. Your key remains available after restart.') : uiText('密钥未能永久保存，请解锁系统登录管理器后重新保存。当前会话仍可使用。', 'Could not save your key permanently. Unlock the login manager and save again. It remains usable in this session.')
      }
      const saved = await cloudOCRConfig(host, engine)
      const matchesSaved = saved.endpoint === config.endpoint && saved.model === config.model && saved.key === config.key && saved.consent === config.consent
      status.dataset.ocrSummaryState = testing ? matchesSaved ? 'verified' : 'unchecked' : 'configured'
    } catch (error) { status.dataset.ocrSummaryState = 'error'; if (!disposed) status.textContent = controller.signal.aborted ? uiText('已停止等待，云端可能继续处理和计费。', 'Stopped waiting; remote processing and billing may continue.') : error instanceof CloudOCRError ? error.message : uiText('配置或连接失败，请检查 HTTPS 地址和密钥。', 'Configuration or connection failed. Check the HTTPS URL and key.') }
    finally { if (!disposed) { save.disabled = test.disabled = false; select.setDisabled(false); stop.hidden = true }; controller = undefined }
  }
  save.addEventListener('click', () => { void execute(false) }); test.addEventListener('click', () => { void execute(true) }); stop.addEventListener('click', () => controller?.abort())
  managedTest.addEventListener('click', () => { void (async () => {
    controller = new AbortController(); managedTest.disabled = true; select.setDisabled(true); managedStop.hidden = false; managedStatus.textContent = uiText('正在测试…', 'Testing…')
    try { const config = await jadenseOCRSnapshot(host, controller.signal); const text = await testCloudOCR(host, config, doc, controller.signal); if (!disposed) managedStatus.textContent = text.slice(0, 300) }
    catch (error) { if (!disposed) managedStatus.textContent = error instanceof Error ? error.message : uiText('识别失败', 'OCR failed') }
    finally { if (!disposed) { managedTest.disabled = false; select.setDisabled(false); managedStop.hidden = true }; controller = undefined }
  })() })
  managedStop.addEventListener('click', () => controller?.abort())
  select.onChange(value => { if (value === 'local' || value === 'jadense') saveOCREngine(host, value); void load() }); void load()
  const stopMode = observeJadenseMode(host, () => { setOptions(); void load() })
  const stopReady = observeOCRProgress(host, progress => { if (progress.stage === 'ready') localReady.textContent = uiText('本机 OCR 已就绪，可在识别引擎中手动切换。', 'Local OCR is ready. You can select it in OCR engine.') })
  let observer: unknown
  try { observer = host.Prefs?.registerObserver?.(OCR_ENGINE_PREF, () => { const engine = ocrEngine(host); if (select.getValue() !== engine) { select.setValue(engine); void load() } }, true) } catch { /* 状态同步失败不影响保存。 */ }
  return () => { stopMode(); stopReady(); if (observer !== undefined) host.Prefs?.unregisterObserver?.(observer); disposed = true; revision++; controller?.abort(); key.value = ''; select.destroy(); models.destroy(); section.remove() }
}
