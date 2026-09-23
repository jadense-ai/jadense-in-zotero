/** 翻译高级设置与只读监控；两个设置宿主共用，不因浏览发送请求。 */
import { DEFAULT_TRANSLATION_SPEED, saveTranslationSpeed, translationScheduler, translationServiceKey, translationSpeed, type TranslationSnapshot } from '@/chat/translation-queue'
import { featureModelState } from './ai-settings'
import { readConnection, type ZoteroLike } from './runtime'
import { readTranslationInterface } from './translation-interface'
import { uiText } from './ui-preferences'

export function translationSpeedText(value: TranslationSnapshot) {
  return uiText(`在途 ${value.active}/${value.concurrency} · HTTP ${value.httpMinute}/${value.rpm} 次/分钟 · 排队 ${value.queued}`, `Active ${value.active}/${value.concurrency} · HTTP ${value.httpMinute}/${value.rpm}/min · Queued ${value.queued}`)
    + (value.waitMs > 0 && value.queued ? uiText(` · 等待 ${Math.ceil(value.waitMs / 1000)} 秒`, ` · Wait ${Math.ceil(value.waitMs / 1000)} s`) : '')
}
export function wireTranslationSpeedSettings(host: ZoteroLike, root: HTMLElement) {
  const doc = root.ownerDocument, make = <K extends keyof HTMLElementTagNameMap>(tag: K) => doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
  const details = make('details'), summary = make('summary'), container = make('div')
  details.dataset.translationSpeed = ''; summary.textContent = uiText('请求与速度（高级）', 'Requests and speed (advanced)'); details.append(summary, container); root.append(details)
  let key = ''
  const refresh = () => {
    if (!details.open) return
    const services = [...new Set((['selection', 'document'] as const).map(scope => {
      const selected = readTranslationInterface(host, scope)
      if (selected.kind === 'machine') return translationServiceKey(selected.service)
      const model = featureModelState(host, scope === 'document' ? 'fullTranslation' : 'translation')
      return translationServiceKey(model.route === 'byok' ? model.config?.baseUrl ?? '' : readConnection(host).baseUrl)
    }).filter(Boolean))]
    if (key !== JSON.stringify(services)) {
      key = JSON.stringify(services); container.replaceChildren()
      for (const address of services) {
        const row = make('div'), description = make('div'), controls = make('div'), title = make('h3'), note = make('p'), status = make('p')
        row.className = 'jdx-feature-model-row'; row.dataset.speedAddress = address; controls.className = 'jdx-settings-controls'; title.textContent = address
        note.className = 'jdx-manager-settings-note jdx-pref-card-note'; note.textContent = uiText('全部翻译共享。RPM 包含检查与恢复。速度立即用于未发送请求，单批容量用于新任务。', 'Shared by all translation tools. RPM includes checks and recovery. Limits apply to unsent requests; batch size applies to new tasks.')
        const machine = address === translationServiceKey('google') || address === translationServiceKey('bing')
        if (machine) note.textContent = uiText('全部翻译入口共享请求额度。网页翻译保持串行，RPM 包含页面读取。', 'All translation tools share this limit. Web translation remains serial; RPM includes page requests.')
        const fields = [['concurrency', uiText('并发数（1–8）', 'Concurrency (1–8)')], ['rpm', uiText('HTTP 请求/分钟', 'HTTP requests/minute')], ['batchTokens', uiText('PDF 每批原文 token', 'PDF source tokens/batch')]] as const
        const inputs = fields.map(([field, label]) => {
          const wrapper = make('label'), caption = make('span'), input = make('input'); caption.textContent = label
          wrapper.className = 'jdx-manager-field jdx-pref-field'; wrapper.hidden = machine && field !== 'rpm'
          input.type = 'number'; input.min = '1'; input.step = '1'; if (field === 'concurrency') input.max = '8'
          input.value = String(translationSpeed(host, address)[field]); input.dataset.savedSpeed = input.value; input.dataset.speedField = field; wrapper.append(caption, input); controls.append(wrapper)
          return input
        })
        const actions = make('div'), save = make('button'), reset = make('button'), feedback = make('p')
        actions.className = 'jdx-manager-actions'; save.type = reset.type = 'button'; save.textContent = uiText('保存', 'Save'); reset.textContent = uiText('恢复默认', 'Restore defaults'); feedback.setAttribute('role', 'status')
        const apply = (defaults: boolean) => {
          const [concurrency, rpm, batchTokens] = inputs.map(input => Number(input.value))
          if (!defaults && (![concurrency, rpm, batchTokens].every(value => Number.isSafeInteger(value) && value > 0) || concurrency > 8)) { feedback.textContent = uiText('请输入正整数，并发数为 1–8。原设置保留。', 'Enter positive integers; concurrency must be 1–8. Previous settings retained.'); return }
          try { saveTranslationSpeed(host, address, defaults ? { ...DEFAULT_TRANSLATION_SPEED } : { concurrency, rpm, batchTokens }); inputs.forEach((input, index) => { input.value = String(translationSpeed(host, address)[fields[index][0]]); input.dataset.savedSpeed = input.value }); feedback.textContent = uiText('已保存', 'Saved') }
          catch { feedback.textContent = uiText('未能保存，原设置保留。', 'Could not save. Previous settings retained.') }
        }
        save.addEventListener('click', () => apply(false)); reset.addEventListener('click', () => apply(true))
        status.dataset.speedService = address; status.setAttribute('role', 'status'); description.append(title, note, status); actions.append(save, reset); controls.append(actions, feedback); row.append(description, controls); container.append(row)
      }
    }
    container.querySelectorAll<HTMLElement>('[data-speed-service]').forEach(node => { node.textContent = translationSpeedText(translationScheduler(host).snapshot(node.dataset.speedService!)) })
    container.querySelectorAll<HTMLInputElement>('[data-speed-field]').forEach(input => {
      if (doc.activeElement === input || input.value !== input.dataset.savedSpeed) return
      const address = input.closest<HTMLElement>('[data-speed-address]')!.dataset.speedAddress!
      input.value = String(translationSpeed(host, address)[input.dataset.speedField as keyof typeof DEFAULT_TRANSLATION_SPEED]); input.dataset.savedSpeed = input.value
    })
  }
  details.addEventListener('toggle', refresh)
  const timer = setInterval(refresh, 1000)
  return () => { clearInterval(timer); details.remove() }
}
