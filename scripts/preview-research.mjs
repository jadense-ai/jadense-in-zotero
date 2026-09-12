/**
 * 浏览器验收 fixture，不是真 Zotero / 真实 AI 验收。
 * 先 npm run build，再 node scripts/preview-research.mjs [port]（默认随机空闲端口）。
 * 直接提供 build/content 的真实 Manager；仅注入 synthetic host 和独立验收条。
 * 仅绑定 127.0.0.1，不访问真实资料库、profile、环境文件或外网服务。
 */
/* global window, document, location */
import http from "node:http"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const contentDirectory = new URL("../build/content/", import.meta.url)
await readFile(new URL("manager.js", contentDirectory))
const port = Number(process.argv[2] || 0)

/** 在真实打包脚本执行前建立最小 Zotero host；所有内容与计数只属于此验收页。 */
function installPreviewHost() {
  const storageKey = "jadense-research-preview-synthetic-v1"
  const pages = [
    "Scientific readers need to connect claims with evidence from long documents.\nWe introduce a sparse evidence graph that connects claims to sentence-level support.\nOur method retrieves candidate sentences and verifies them against document context.\nThe evaluation includes 120 synthetic documents and a held-out test split.",
    "The evidence graph improves retrieval precision from 72 percent to 86 percent.\nThe gains are strongest when conclusions cite explicit numerical comparisons.\nThe study is limited to synthetic documents and does not establish clinical validity.\nFuture work will evaluate multilingual documents and noisy scanned pages.",
  ]
  let saved
  try { saved = JSON.parse(sessionStorage.getItem(storageKey) || "{}") } catch { saved = {} }
  const preferences = { ...(saved.preferences || {}) }
  const requestedUiLanguage = new URLSearchParams(location.search).get("ui-language")
  if (["zh-CN", "en-US", "system"].includes(requestedUiLanguage)) preferences["extensions.jadenseInZotero.displayLanguage"] = requestedUiLanguage
  preferences["extensions.jadenseInZotero.baseUrl"] = location.origin
  preferences["extensions.jadenseInZotero.token"] = "synthetic-fixture-token-not-a-credential"
  preferences["extensions.jadenseInZotero.managerThemeDark"] ??= false
  const annotations = Array.isArray(saved.annotations) ? saved.annotations : []
  let requests = Number(saved.requests) || 0
  let nextMode = "normal"
  let failNextAnnotation = false
  let selectedIDs = [1]
  let nextSourceSlow = false
  let nextPickerCancel = false
  let sourceReadUntil = 0
  let waitingSourceReads = 0
  let nativeAction = "无"
  let status = "所有数据和 AI 均为模拟；请使用下方真实 Manager 验收。"
  const persist = () => sessionStorage.setItem(storageKey, JSON.stringify({ preferences, annotations, requests }))
  const update = () => {
    const counters = document.getElementById("fixture-counters")
    if (counters) counters.textContent = ` · AI 请求 ${requests} · 原生批注 ${annotations.length} · 当前选择 ${selectedIDs.length > 1 ? `${selectedIDs.length} 个长标题来源` : selectedIDs[0] === 1 ? "含 PDF 文献" : selectedIDs[0] === 3 ? "无 PDF 文献" : "不可读 PDF"}`
    const state = document.getElementById("fixture-state")
    if (state) state.textContent = `${status} 下一次 AI：${nextMode}。来源读取：${waitingSourceReads ? "等待中（模拟 8 秒）" : nextSourceSlow ? "下次延迟 8 秒" : "正常"}。本地跳转：${nativeAction}。`
    document.querySelector('[data-fixture="slow-source"]')?.setAttribute("aria-pressed", String(nextSourceSlow))
    const annotationList = document.getElementById("fixture-annotations")
    if (annotationList) annotationList.textContent = annotations.length
      ? annotations.map((entry, index) => `${index + 1}. 第 ${entry.pageLabel} 页 · ${entry.tags.map((tag) => tag.name).join(" / ")}\n${entry.text}\n${entry.comment}`).join("\n\n")
      : "尚未生成模拟原生批注。"
  }
  // 同一次读取里的 getAsync / PDFWorker 共用等待窗口，避免逐个附件重复等待。
  const waitForSourceRead = async () => {
    if (nextSourceSlow) {
      nextSourceSlow = false
      sourceReadUntil = Date.now() + 8_000
    }
    const delay = sourceReadUntil - Date.now()
    if (delay <= 0) return
    waitingSourceReads += 1
    update()
    try {
      await new Promise((resolve) => setTimeout(resolve, delay))
    } finally {
      waitingSourceReads -= 1
      if (!waitingSourceReads) sourceReadUntil = 0
      update()
    }
  }
  const makePaper = (id, title, attachmentIDs) => {
    const fields = { title, date: "2026", publicationTitle: "Synthetic Research Review", DOI: `10.0000/fixture.${id}`, abstractNote: "【验收模拟文献】用句子级证据连接核心论点，检验检索质量与证据边界。" }
    return {
      id, libraryID: 1, key: `PAPER00${id}`, itemType: "journalArticle",
      getField: (field) => fields[field] || "", getCreators: () => [{ firstName: "Ada", lastName: "Example" }],
      getTags: () => [], isRegularItem: () => true, isAttachment: () => false, isNote: () => false,
      getAttachments: () => attachmentIDs,
    }
  }
  const paper = makePaper(1, "证据驱动的科学阅读：句子级文献分析（模拟）", [2])
  const noPdf = makePaper(3, "只有元数据的文献（模拟无 PDF）", [])
  const secondPaper = makePaper(5, "Monetary Policy Transmission through the Exchange Rate Factor Structure（模拟）", [6])
  const manySources = Array.from({ length: 24 }, (_, index) => ({
    ...makePaper(100 + index, `来源 ${String(index + 1).padStart(2, "0")}｜跨学科证据关联与长文献阅读的可追溯性研究——句子级论点、证据边界及不同窗口宽度下的长标题展示验证（Synthetic Evidence Review，纯模拟验收文献）`, []),
    key: `BULK${String(index + 1).padStart(4, "0")}`,
  }))
  const makePdf = (id, title, parent = paper) => ({
    id, libraryID: 1, key: `PDF0000${id}`, itemType: "attachment", parentID: parent.id, parentItem: parent,
    attachmentContentType: "application/pdf", attachmentModificationTime: 1770000000000,
    getField: (field) => field === "title" ? title : "", isRegularItem: () => false,
    isAttachment: () => true, isPDFAttachment: () => true, isNote: () => false, isEditable: () => true,
    getAnnotations: () => annotations.map((entry) => ({
      annotationText: entry.text, annotationPosition: JSON.stringify(entry.position),
      getTags: () => entry.tags.map((tag) => ({ tag: tag.name })),
    })),
  })
  const pdf = makePdf(2, "PDF")
  const secondPdf = makePdf(6, "PDF", secondPaper)
  const unreadable = makePdf(4, "未下载或加密的附件.pdf（模拟不可读）")
  const items = new Map([paper, noPdf, secondPaper, pdf, secondPdf, unreadable, ...manySources].map((item) => [item.id, item]))
  const pageData = (text) => {
    const chars = []
    let x = 48
    let y = 748
    for (const c of text) {
      if (c === "\n" || (c === " " && x > 520)) {
        if (chars.length) chars[chars.length - 1][c === "\n" ? "paragraphBreakAfter" : "lineBreakAfter"] = true
        x = 48
        y -= c === "\n" ? 28 : 16
        continue
      }
      chars.push({ c, rect: [x, y, x + 5, y + 10] })
      x += c === " " ? 3.5 : 5.4
    }
    return { chars, viewBox: [0, 0, 612, 792] }
  }
  const reader = {
    itemID: 2, _initPromise: Promise.resolve(),
    _internalReader: { _primaryView: {
      initializedPromise: Promise.resolve(),
      _pdfPages: {},
      async _ensureBasicPageData(pageIndex) {
        this._pdfPages[pageIndex] ??= pageData(pages[pageIndex])
      },
      _iframeWindow: { PDFViewerApplication: { pdfDocument: {
        numPages: 2, getPageLabels: async () => ["1", "2"],
      } } },
    } },
  }
  const preferenceObservers = new Map()
  const Zotero = {
    locale: "zh-CN",
    Prefs: {
      get: (key) => preferences[key],
      set: (key, value) => {
        preferences[key] = key.endsWith(".baseUrl") ? location.origin
          : key.endsWith(".token") ? "synthetic-fixture-token-not-a-credential" : value
        persist()
        for (const [callback, observedKey] of preferenceObservers) if (observedKey === key) callback()
      },
      clear: (key) => { delete preferences[key]; persist() },
      registerObserver: (key, callback) => { preferenceObservers.set(callback, key); return callback },
      unregisterObserver: (callback) => preferenceObservers.delete(callback),
    },
    Items: {
      get: (id) => items.get(Number(id)),
      getAsync: async (id) => { await waitForSourceRead(); return items.get(Number(id)) },
      getByLibraryAndKey: (libraryID, key) => [...items.values()].find((item) => item.libraryID === libraryID && item.key === key)
        || annotations.find((entry) => entry.key === key),
    },
    Libraries: { userLibraryID: 1, getAll: () => [{ libraryID: 1, name: "我的文库", editable: true }], get: id => ({ libraryID: id, editable: id === 1 }) },
    Collections: { getByLibrary: () => [{ id: 1, name: "Evidence review", libraryID: 1 }], get: id => id === 1 ? { libraryID: 1 } : undefined },
    launchURL: url => { nativeAction = `打开链接 ${url}`; update() },
    getMainWindow: () => window,
    getActiveZoteroPane: () => ({
      getSelectedItems: () => selectedIDs.map((id) => items.get(id)).filter(Boolean),
      getSelectedCollection: () => ({ id: 1, libraryID: 1, key: "TESTCOLL", name: "浏览器验收模拟文献", getChildItems: () => [1, 3] }),
      selectItem: async (id) => { nativeAction = `选择条目 ${id}`; update(); return true },
    }),
    PDFWorker: { getFullText: async (id, maxPages) => {
      await waitForSourceRead()
      if (id !== 2 && id !== 6) throw new Error("模拟附件不可读，未接触任何真实文件")
      const count = Math.min(maxPages || 2, 2)
      return { text: pages.slice(0, count).join("\f"), extractedPages: count, totalPages: 2 }
    } },
    Reader: {
      _readers: [reader],
      open: async (id, target) => {
        if (id !== 2) throw new Error("模拟附件不可读")
        nativeAction = `打开 PDF ${id}${target?.pageIndex !== undefined ? `，第 ${target.pageIndex + 1} 页` : ""}`
        update()
        return reader
      },
    },
    DataObjectUtilities: { generateKey: () => window.crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase() },
    Annotations: { saveFromJSON: async (attachment, json) => {
      if (attachment.id !== 2) throw new Error("验收 fixture 仅允许模拟 PDF 的批注")
      if (failNextAnnotation) { failNextAnnotation = false; throw new Error("模拟单条原生批注保存失败") }
      annotations.push(structuredClone(json))
      persist()
      update()
      return json
    } },
    debug: () => undefined,
  }
  // 浏览器只模拟原生选择结果；真实资料树和取消流程由隔离 Zotero smoke 验证。
  window.openDialog = (url, _name, _features, io) => {
    if (url !== "chrome://zotero/content/selectItemsDialog.xhtml") return null
    io.dataOut = nextPickerCancel ? null : [...selectedIDs]
    nativeAction = nextPickerCancel ? "模拟选择器取消" : `模拟选择器确认 ${selectedIDs.length} 项`
    nextPickerCancel = false
    update()
    return null
  }
  window.Zotero = Zotero
  window.JadenseInZotero = { zotero: Zotero, section: new URLSearchParams(location.search).get("section") || "chat", pluginID: "jadense-research-preview-fixture" }
  // 临时 AI 请求使用同一个浏览器内存文件系统，不接触真实 profile。
  const files = new Map()
  // 翻译历史视觉验收仅使用合成档案，可重复检查长标题、筛选和展开阅读。
  if (new URLSearchParams(location.search).has("translation-fixture")) {
    const titles = ["Frequency comb spectroscopy", "Massively parallel sensing of trace molecules and their isotopologues with broadband subharmonic mid-infrared frequency combs", "Adaptive real-time dual-comb spectroscopy"]
    preferences["extensions.jadenseInZotero.translationHistory"] = JSON.stringify({ version: 1, records: titles.flatMap((title, i) => [0, 1].map(n => ({
      id: `translation-demo-${i}-${n}`, createdAt: new Date(Date.now() - (i * 14 + n) * 86400000).toISOString(),
      source: { itemID: 2, libraryID: 1, itemKey: pdf.key, title, citation: "Ada Example, 2026", pageIndex: n, pageLabel: String(148 + n), text: n ? "The spectral resolution allows individual absorption features to be distinguished." : "Frequency combs provide precise measurements across a broad spectral range. This is synthetic preview text." },
      result: { sourceLanguage: "英文", targetLanguage: "简体中文", text: "频率梳能够在宽广的光谱范围内进行精密测量。\n\n这是用于界面验收的**模拟译文**。" },
    }))) })
    const id = "20000000-0000-4000-8000-000000000001"
    files.set(`/fixture/jadense-document-tasks/${id}/task.json`, JSON.stringify({ version: 1, id, kind: "translation", createdAt: new Date().toISOString(), source: { itemID: 2, libraryID: 1, itemKey: pdf.key, title: titles[1] }, status: "paused", completed: 9, total: 327, totalPages: 2, languages: { sourceLanguage: "en", targetLanguage: "zh-CN" }, models: [], warnings: [] }))
  }
  window.PathUtils = { profileDir: "/fixture", join: (...parts) => parts.join("/"), filename: path => path.split("/").at(-1) }
  window.IOUtils = { makeDirectory: async () => {}, readUTF8: async path => { if (!files.has(path)) throw new Error("missing fixture"); return files.get(path) }, writeUTF8: async (path, text) => { files.set(path, text) }, getChildren: async path => [...new Set([...files.keys()].filter(key => key.startsWith(path + "/")).map(key => path + "/" + key.slice(path.length + 1).split("/")[0]))], remove: async path => files.delete(path) }
  // 可复现的详情验收数据；只在显式 fixture 参数下建立浏览器内存文件系统。
  if (new URLSearchParams(location.search).has("analysis-fixture")) {
    const taskID = "10000000-0000-4000-8000-000000000001"
    const source = { itemID: pdf.id, itemKey: pdf.key, libraryID: 1, title: paper.getField("title"), authors: ["Ada Example", "Lin Chen"], year: "2026", publicationTitle: "Synthetic Research Review", doi: "10.0000/fixture.1" }
    const notes = "文献解析（AI 辅助，请核对原文）\n\n总体概述\n这是一组用于验收的合成结果。证据图将论点与句子级支持关系关联起来。\n\n研究方法\n先检索候选原句，再结合上下文验证证据与论点的对应关系。\n\n核心论点\n保持证据可追溯能够帮助读者核对结论边界。\n\n关键句与批注（2 条）\n\n【关键证据】第 1 页\n原句：The evidence graph improves retrieval precision from 72 percent to 86 percent.\nAI 批注：这一数值比较支持检索质量的改善。**这里的数字仅为合成测试数据**，不代表真实模型评测。\n\n【局限性】第 2 页\n原句：The study is limited to synthetic documents.\nAI 批注：评估材料的范围限制了结论的外推。后续仍需在真实文献和多语种材料上验证。"
    preferences["extensions.jadenseInZotero.paperAnalysisHistory"] = JSON.stringify({ version: 1, records: [
      { id: "analysis-demo-new", createdAt: "2026-09-10T06:30:00Z", source, summary: "这篇模拟研究提出一种**句子级证据图**，将文献中的核心论点与原文依据关联。\n\n方法包含候选句检索和上下文核验两个阶段，评估覆盖 120 篇合成文档。示例中的检索精度由 72% 提升至 86%，但这一结果仅用于验证界面的数值与层级展示。\n\n### 阅读判断\n\n- 证据链清楚，便于回到原文核对。\n- 样本全部来自合成材料，外推范围有限。\n- 后续需要验证多语种与扫描文档场景。", notes, referenceTaskID: taskID },
      { id: "analysis-demo-old", createdAt: "2026-09-09T06:30:00Z", source, summary: "旧解析不会单独占据历史列表。" },
      { id: "analysis-demo-second", createdAt: "2026-09-08T06:30:00Z", source: { ...source, itemID: 6, itemKey: secondPdf.key, title: secondPaper.getField("title") }, summary: "另一篇独立文献的结果。用于验证快速切换时不会混入上一篇的参考文献。", warnings: ["部分结果已恢复，尚未写入原生批注。"] },
    ] })
    const references = Array.from({ length: 18 }, (_, order) => {
      const fields = { title: ["Sentence-level evidence retrieval in scientific documents", "A framework for structured literature review", "Reasoning with attributable sources"][order % 3], authors: ["Smith, J.", "Chen, L."], year: String(2020 + order % 6), doi: `10.0000/fixture.reference.${order}`, url: `https://example.org/references/${order}` }
      const verification = order % 4 === 1 ? "unverified" : "verified"
      if (order === 2) delete fields.doi
      return { id: `ref-${order}`, order, label: String(order + 1), raw: `[${order + 1}] ${fields.authors.join("; ")} (${fields.year}). ${fields.title}. Journal of Research Methods, 12(3), 45–62. ${fields.doi ? `https://doi.org/${fields.doi}` : fields.url}`, fields, verification, ...(verification === "verified" ? { verified: fields } : { reason: "未找到唯一匹配文献，可按原文搜索" }), uncertain: false, lines: [{ pageIndex: 1, rects: [[48, 100, 500, 120]] }] }
    })
    const task = { version: 1, id: taskID, kind: "references", source, createdAt: "2026-09-10T06:30:00Z", status: "complete", totalPages: 2, completed: references.length, total: references.length, models: [], warnings: [] }
    for (const [path, text] of [[`/fixture/jadense-document-tasks/${taskID}/task.json`, JSON.stringify(task)], [`/fixture/jadense-document-tasks/${taskID}/references.json`, JSON.stringify(references)]]) files.set(path, text)

    Zotero.Search = class { addCondition(_field, _condition, value) { this.doi = value } async search() { return [...items.values()].filter(item => item.getField("DOI") === this.doi).map(item => item.id) } }
    Zotero.Item = class { constructor() { this.fields = {}; this.id = 600 + items.size; this.key = `IM${this.id}` } setField(key, value) { this.fields[key] = value } getField(key) { return this.fields[key] || "" } setCreators() {} setCollections() {} async saveTx() { items.set(this.id, this) } }
  }
  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href)
    if (url.origin !== location.origin) throw new Error("浏览器验收 fixture 禁止外网请求")
    if (url.pathname === "/api/chat") {
      const mode = nextMode
      nextMode = "normal"
      const headers = new Headers(options.headers)
      headers.set("x-jadense-fixture-mode", mode)
      requests += 1
      status = `已发送第 ${requests} 次本地假 AI 请求（${mode}）。`
      persist()
      update()
      return nativeFetch(input, { ...options, headers })
    }
    return nativeFetch(input, options)
  }
  document.addEventListener("DOMContentLoaded", () => {
    const controls = document.getElementById("fixture-controls")
    controls.addEventListener("click", (event) => {
      const action = event.target.closest("button")?.dataset.fixture
      if (!action) return
      if (action === "paper" || action === "no-pdf" || action === "unreadable") {
        selectedIDs = [action === "paper" ? 1 : action === "no-pdf" ? 3 : 4]
        status = "已切换模拟 Zotero 选择；请点 Manager 的关联条目 / 关联文件。"
      } else if (action === "many-sources") {
        selectedIDs = manySources.map((item) => item.id)
        status = "已选择 24 篇长标题模拟文献；请点真实 Manager 的关联条目，验收来源容量与小窗布局。"
      } else if (action === "mixed-sources") {
        selectedIDs = [1, 5, 4]
        status = "下一次选择器将确认两篇文献、同名 PDF 与不可读附件；请点关联文件。"
      } else if (action === "cancel-picker") {
        nextPickerCancel = true
        status = "下一次点击关联条目或文件时模拟取消选择，已有来源应保持不变。"
      } else if (action === "slow-source") {
        nextSourceSlow = !nextSourceSlow
        status = nextSourceSlow
          ? "下一次原生来源读取延迟 8 秒；请选择含 PDF 文献，再点 Manager 的关联文件，并在等待时点击停止。"
          : "已取消下一次慢读取；已经开始的模拟原生读取仍会完成，由 Manager 处理停止后的结果。"
      } else if (action === "attach" || action === "analyze") {
        status = action === "analyze" ? "模拟独立文献解析，应保留总结与笔记。" : "模拟阅读器提问，应创建独立本地对话。"
        window.receiveJadenseContext?.({ section: action === "analyze" ? "analysis" : "chat", actions: [{ kind: action, itemID: 2 }] })
      } else if (action === "quote" || action === "translate") {
        status = `已通过真实 Manager receiveJadenseContext 发送${action === "quote" ? "引用" : "翻译"}动作。`
        window.receiveJadenseContext?.({ section: "chat", actions: [{
          kind: action, itemID: 2, pageIndex: 0, pageLabel: "1", text: pages[0].split("\n")[1],
        }] })
      } else if (action === "annotation-fail") {
        failNextAnnotation = true
        status = "下一条模拟原生批注将失败；其他批注和可读备份应保留。"
      } else if (["normal", "fail", "subscription", "slow", "malformed", "stream-cut"].includes(action)) {
        nextMode = action
        status = "已设置下一次假 AI 行为；请在 Manager 发送问题、解析或翻译。"
      } else if (action === "hide") {
        controls.hidden = true
      } else if (action === "reset") {
        sessionStorage.removeItem(storageKey)
        location.reload()
        return
      }
      update()
    })
    update()
  }, { once: true })
}

const controls = `<details id="fixture-controls">
  <summary>浏览器验收 fixture · 假 AI<span id="fixture-counters"> · 正在初始化</span></summary>
  <p>此页加载真实打包的 Manager，Zotero 和 AI 都是模拟。仅本机网络；不是真 Zotero 原生验收。此悬浮栏不改变 Manager 高度，收起后可验收实际布局。</p>
  <div class="fixture-buttons">
    <button type="button" data-fixture="paper">选择含 PDF 文献</button><button type="button" data-fixture="no-pdf">选择无 PDF 文献</button><button type="button" data-fixture="unreadable">选择不可读 PDF</button>
    <button type="button" data-fixture="many-sources">选择 24 个来源</button><button type="button" data-fixture="slow-source" aria-pressed="false">下一次来源慢读取</button>
    <button type="button" data-fixture="mixed-sources">选择多篇文献与同名 PDF</button><button type="button" data-fixture="cancel-picker">下一次取消资料选择</button>
    <button type="button" data-fixture="attach">模拟阅读器提问</button><button type="button" data-fixture="analyze">模拟阅读器解析</button>
    <button type="button" data-fixture="quote">模拟阅读器引用</button><button type="button" data-fixture="translate">模拟阅读器翻译</button>
    <button type="button" data-fixture="malformed">下一次解析 JSON 缺尾括号</button><button type="button" data-fixture="stream-cut">下一次流中断</button><button type="button" data-fixture="annotation-fail">下一条批注保存失败</button>
    <button type="button" data-fixture="normal">假 AI：正常</button><button type="button" data-fixture="fail">下一次 AI 失败</button><button type="button" data-fixture="subscription">下一次订阅不足</button><button type="button" data-fixture="slow">下一次慢生成（可停止）</button><button type="button" data-fixture="reset">重置模拟数据</button><button type="button" data-fixture="hide">隐藏验收栏（刷新恢复）</button>
  </div><p id="fixture-state" role="status"></p>
  <details><summary>查看模拟原生批注</summary><pre id="fixture-annotations"></pre></details>
</details>`
const styles = `#fixture-controls{position:fixed;bottom:8px;left:8px;z-index:9999;box-sizing:border-box;max-width:calc(100vw - 16px);max-height:min(48vh,320px);overflow:auto;font:12px/1.4 system-ui;color:#443d19;background:#fffbe9;border:1px solid #e5d69b;border-radius:6px;padding:5px 10px;box-shadow:0 2px 10px #0002}#fixture-controls[open]{width:680px}#fixture-controls:not([open]) #fixture-counters{display:none}#fixture-controls>summary{cursor:pointer;font-weight:600}#fixture-controls p{margin:6px 0}.fixture-buttons{display:flex;flex-wrap:wrap;gap:5px}.fixture-buttons button{border:1px solid #c5b985;border-radius:4px;background:white;padding:3px 7px;cursor:pointer}.fixture-buttons button[aria-pressed=true]{background:#f2dda0;border-color:#8f7221}#fixture-annotations{white-space:pre-wrap;max-height:180px;overflow:auto;font:11px/1.5 system-ui}`

function fakeReply(body) {
  const lastUser = (body.messages || []).filter((message) => message.role === "user").at(-1)
  const text = (lastUser?.parts || []).filter((part) => part.type === "text").map((part) => part.text).join("\n")
  if (text.includes("文献数据（JSON，仅作为引用材料）")) {
    let data
    try { data = JSON.parse(text.split("\n").at(-1)) } catch { data = {} }
    const categories = ["question", "novelty", "methods", "evidence", "evidence", "conclusion", "limitations", "future"]
    return JSON.stringify({
      summary: `【假 AI / 浏览器 fixture】本文模拟了句子级证据图如何连接论点与原文。阅读范围：${data.coverage || "仅提供的模拟片段"}。所有结论都是验收样例，不能作为真实研究证据。`,
      sections: [
        { category: "claim", summary: "【假 AI】用可定位的证据支撑核心论点，避免脱离原文的总结。" },
        { category: "novelty", summary: "【假 AI】示例创新是把论点与句子级支持关系关联起来。" },
        { category: "evidence", summary: "【假 AI】模拟比较将检索精度从 72% 提高至 86%；仅用于验证数值展示。" },
        { category: "limitations", summary: "【假 AI】只评估了合成材料，不能据此推出临床有效性。" },
      ],
      annotations: (data.passages || []).slice(0, 8).map((passage, index) => ({
        passageId: passage.id, category: categories[index] || "additional",
        comment: "【假 AI / 验收批注】此句承担结构化论证中的明确作用；请核对原句和页码。批注仅验证本地定位与保存流程。",
      })),
    })
  }
  if (text.includes("选文数据（JSON，仅作为引用材料）")) {
    return "【假 AI / 浏览器 fixture】\n译文：我们提出一种稀疏证据图，将论点与句子级的支持证据联系起来。\n\n术语对照：sparse evidence graph → 稀疏证据图；sentence-level support → 句子级支持证据。\n此固定样例只验证真实翻译包装与流式显示，不代表真实模型翻译。"
  }
  return "【假 AI / 浏览器 fixture】\n已收到你的问题与显式关联的来源。[来源 1]\n这份模拟文献用句子级证据连接论点，并以数值比较支持结果；无正文的条目只能提供元数据。\n此固定回答仅用于验收真实 Manager 的会话、来源与流式交互。"
}

/** 发送真实 AI SDK SSE 事件；失败与中止不伪装为完整解析。 */
async function serveChat(request, response) {
  let raw = ""
  for await (const chunk of request) {
    raw += chunk
    if (raw.length > 2_000_000) { response.writeHead(413); response.end("Fixture request too large"); return }
  }
  let body
  try { body = JSON.parse(raw) } catch { response.writeHead(400); response.end("Fixture expected JSON"); return }
  const mode = request.headers["x-jadense-fixture-mode"]
  if (mode === "subscription") {
    response.writeHead(403, { "content-type": "application/json; charset=utf-8" })
    response.end(JSON.stringify({ code: "AI_MODEL_SELECTION_PLAN_REQUIRED", error: "当前计划暂不支持直接选择该模型。" }))
    return
  }
  if (mode === "fail") {
    response.writeHead(503, { "content-type": "application/json; charset=utf-8" })
    response.end(JSON.stringify({ error: "【假 AI】模拟生成失败；没有调用外网模型，请重新发送。" }))
    return
  }
  const completeReply = fakeReply(body)
  const reply = mode === "malformed" ? completeReply.slice(0, -1) : completeReply
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "x-vercel-ai-ui-message-stream": "v1", "cache-control": "no-store" })
  const event = (data) => response.write(`data: ${JSON.stringify(data)}\n\n`)
  event({ type: "start", messageId: "fixture-answer" })
  event({ type: "text-start", id: "fixture-text" })
  let offset = 0
  const timer = setInterval(() => {
    if (offset < reply.length) {
      const size = mode === "slow" ? 6 : 90
      event({ type: "text-delta", id: "fixture-text", delta: reply.slice(offset, offset + size) })
      offset += size
      return
    }
    clearInterval(timer)
    if (mode === "stream-cut") { response.end(); return }
    event({ type: "text-end", id: "fixture-text" })
    event({ type: "finish", finishReason: "stop" })
    response.end("data: [DONE]\n\n")
  }, mode === "slow" ? 900 : 25)
  response.on("close", () => clearInterval(timer))
}

const assets = new Map([
  ["/ui.css", ["ui.css", "text/css; charset=utf-8"]],
  ["/analysis.css", ["analysis.css", "text/css; charset=utf-8"]],
  ["/manager.js", ["manager.js", "text/javascript; charset=utf-8"]],
  ["/manager.css", ["manager.css", "text/css; charset=utf-8"]],
  ["/chat.css", ["chat.css", "text/css; charset=utf-8"]],
  ["/icons/logo-padded.png", ["icons/logo-padded.png", "image/png"]],
])
const fixtureAccount = { signedToday: false, balancePoints: 36, currentStreakDays: 4, rewardPoints: 2 }
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname
  response.setHeader("cache-control", "no-store")
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'")
  try {
    if (pathname === "/api/chat/temporary" && request.method === "HEAD") { response.writeHead(200, { "x-jadense-temporary-protocol": "1" }); response.end(); return }
    if (pathname === "/api/chat") response.setHeader("x-jadense-temporary-protocol", "1")
    if (pathname === "/api/chat" && request.method === "POST") { await serveChat(request, response); return }
    if (pathname === "/api/extension/chat/models" && request.method === "GET") {
      response.setHeader("content-type", "application/json; charset=utf-8")
      response.end(JSON.stringify({
        options: [
          { kind: "route", routeTier: "standard", displayName: "标准", description: "根据任务自动选择模型", sortOrder: 10, minimumPlanCode: null, locked: false },
          { kind: "route", routeTier: "premium", displayName: "高阶", description: "优先使用高阶模型", sortOrder: 20, minimumPlanCode: "pro", locked: false },
          { kind: "model", modelId: "deepseek-v4-flash-vision-exp", displayName: "DeepSeek V4 Flash Vision Exp", description: "插件默认模型", locked: false, capabilities: ["text", "imageInput"], consumptionMultiplier: 1 },
          { kind: "model", modelId: "synthetic-platform-model", displayName: "Synthetic Research", description: "适合长文研究", sortOrder: 30, minimumPlanCode: null, locked: false, capabilities: ["text", "imageInput"], labels: [], icons: { mode: "shared", src: "/icons/logo-padded.png" }, consumptionMultiplier: 1.25 },
          { kind: "model", modelId: "locked-model", displayName: "受限模型", description: "用于验收锁定态", sortOrder: 40, minimumPlanCode: "max", locked: true, lockReason: "升级后可直接选择。", capabilities: ["text"], labels: [], icons: { mode: "shared", src: "/icons/logo-padded.png" }, consumptionMultiplier: 2 },
        ],
        defaultSelection: { kind: "route", routeTier: "standard" },
      }))
      return
    }
    if (pathname === "/api/extension/favorite/folders") {
      response.setHeader("content-type", "application/json; charset=utf-8")
      response.end(JSON.stringify({ defaultFolderId: "fixture-folder", folders: [{ id: "fixture-folder", name: "验收模拟收藏夹", isDefault: true, itemCount: 2 }] }))
      return
    }
    if (pathname === "/api/extension/profile/me" && request.method === "GET") {
      response.setHeader("content-type", "application/json; charset=utf-8")
      response.end(JSON.stringify({
        userId: "fixture-user", displayName: "浏览器验收用户", avatarUrl: null, avatarSrc: null,
        subscription: { code: "pro", label: "专业版（模拟）" },
      }))
      return
    }
    if (pathname === "/api/extension/points/status" && request.method === "GET") {
      response.setHeader("content-type", "application/json; charset=utf-8")
      response.end(JSON.stringify({
        billing: {
          sourceKind: "personal", teamId: null, balancePoints: fixtureAccount.balancePoints,
          primaryBalancePoints: fixtureAccount.balancePoints, fallbackBalancePoints: null,
        },
        checkIn: {
          signedToday: fixtureAccount.signedToday, currentStreakDays: fixtureAccount.currentStreakDays,
          todayReward: { grantedPoints: fixtureAccount.rewardPoints },
        },
      }))
      return
    }
    if (pathname === "/api/extension/points/check-in" && request.method === "POST") {
      const alreadyCheckedIn = fixtureAccount.signedToday
      const grantedPoints = alreadyCheckedIn ? 0 : fixtureAccount.rewardPoints
      if (!alreadyCheckedIn) {
        fixtureAccount.signedToday = true
        fixtureAccount.balancePoints += grantedPoints
        fixtureAccount.currentStreakDays += 1
      }
      response.setHeader("content-type", "application/json; charset=utf-8")
      response.end(JSON.stringify({ alreadyCheckedIn, balanceAfter: fixtureAccount.balancePoints, grantedPoints }))
      return
    }
    if (pathname === "/__fixture__/host.js") {
      response.setHeader("content-type", "text/javascript; charset=utf-8")
      response.end(`(${installPreviewHost.toString()})()`)
      return
    }
    if (pathname === "/" || pathname === "/manager.xhtml") {
      const page = await readFile(new URL("manager.xhtml", contentDirectory), "utf8")
      response.setHeader("content-type", "text/html; charset=utf-8")
      response.end(page.replace(/<\?xml[^>]*\?>\s*/, "<!doctype html>\n")
        .replace("</head>", `<style>${styles}</style><script src="/__fixture__/host.js"></script></head>`)
        .replace("<body>", `<body>${controls}`))
      return
    }
    if (assets.has(pathname)) {
      const [file, type] = assets.get(pathname)
      response.setHeader("content-type", type)
      response.end(await readFile(new URL(file, contentDirectory)))
      return
    }
    response.writeHead(pathname === "/favicon.ico" ? 204 : 404)
    response.end()
  } catch {
    if (!response.headersSent) response.writeHead(500)
    response.end("Browser fixture failed; run npm run build first. No external request was made.")
  }
})
server.listen(port, "127.0.0.1", () => {
  console.log(`Browser fixture only: http://127.0.0.1:${server.address().port}/manager.xhtml?section=chat`)
  console.log(`Serving actual build assets from ${fileURLToPath(contentDirectory)}`)
  console.log("Synthetic Zotero + fake AI only. Ctrl+C stops this loopback-only server.")
})
