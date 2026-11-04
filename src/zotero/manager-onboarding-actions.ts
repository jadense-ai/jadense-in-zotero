/** 入门引导的真实操作边界：复用 Chat 与本机引擎服务，只有明确点击才调用。 */
import { createLocalChatSession, readLocalChatState } from '@/chat/local-chat-store'
import { chatRuntime } from './chat-runtime'
import { localOCRReadiness } from './local-ocr'
import { PDF_ENGINE, pdfPlatform, pdfRuntimeRoot } from './pdf-translation-runtime'
import { pdfTranslationJobs } from './pdf-translation-jobs'
import { uiText } from './ui-preferences'
import type { ZoteroLike } from './runtime'

/** 独立空会话避免携带用户当前文献、附件或草稿；完整的非空回复才算完成。 */
export async function sendOnboardingHello(host: ZoteroLike, onCreated: () => void = () => {}) {
  const runtime = chatRuntime(host)
  if (runtime.busy) return { success: false, error: uiText('请等待当前对话完成，再发送你好。', 'Wait for the current conversation to finish, then send hello.') }
  const session = createLocalChatSession(runtime.preferences, { title: uiText('入门教学：你好', 'Getting started: Hello') })
  onCreated()
  const accepted = await runtime.send({ sessionID: session.id, prompt: '你好', feature: 'chat',
    prepare: async () => ({ requestText: '你好', requireComplete: true }),
  })
  const reply = readLocalChatState(runtime.preferences).sessions.find(item => item.id === session.id)?.messages.at(-1)
  const success = accepted && runtime.statusKind === 'success' && reply?.role === 'assistant' && reply.status === 'complete' && Boolean(reply.text.trim())
  return { success: Boolean(success), ...(success ? {} : { error: runtime.status || uiText('尚未收到完整回复，请检查配置后重试。', 'No complete reply was received. Check the configuration and try again.') }) }
}

/** 只读 OCR 成功凭据，并离线检测已有 PDF 引擎；不存在时返回未就绪，不启动安装。 */
export async function checkOnboardingEngines(host: ZoteroLike, signal: AbortSignal) {
  const values = await Promise.allSettled([
    localOCRReadiness(host),
    (async () => {
      const { IOUtils, PathUtils } = pdfPlatform()
      if (!await IOUtils.exists(PathUtils.join(pdfRuntimeRoot(host), PDF_ENGINE))) return false
      signal.throwIfAborted()
      await pdfTranslationJobs(host).checkEngine(signal, () => {})
      return true
    })(),
  ])
  return { ocr: values[0].status === 'fulfilled' && values[0].value === true, pdf: values[1].status === 'fulfilled' && values[1].value === true }
}
