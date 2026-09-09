/**
 * 实际 XPI 的科研与 UI smoke：独立 profile/data + 合成 PDF/Markdown + localhost AI stub。
 * 临时伴随插件只驱动实际阅读器/Manager UI，不改 release XPI，不加入生产测试后门。
 */
/* global Zotero, Services, Components, ChromeUtils, IOUtils, PathUtils */
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { copyFile, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { buildReleasePaths, loadReleaseContext } from "./release-common.mjs"

const COMPANION_ID = "research-smoke@jadense.invalid"
const SYNTHETIC_TOKEN = "jdx_ext_synthetic_research_smoke_only"
const UPLOAD_FOLDER_ID = "research-smoke-folder"
const TRANSLATION_MARKER = "SYNTHETIC_TRANSLATION_VERIFIED"
const MARKDOWN_MARKER = "SYNTHETIC_MARKDOWN_VERIFIED"
const BYOK_MARKER = "SYNTHETIC_BYOK_DIRECT_VERIFIED"
const FIGURE_CAPTION = "Figure 1. Synthetic treatment response by cohort."
const FIGURE_MARKER = "SYNTHETIC_FIGURE_INTERPRETATION_VERIFIED"
const FIGURE_FOLLOWUP_PROMPT = "SYNTHETIC_FIGURE_FOLLOWUP_QUESTION"
const FIGURE_FOLLOWUP_MARKER = "SYNTHETIC_FIGURE_FOLLOWUP_VERIFIED"
const FIGURE_CURRENT_MARKER = "SYNTHETIC_FIGURE_CURRENT_CONVERSATION_VERIFIED"
const CAPTURE_MARKER = "SYNTHETIC_MANUAL_CAPTURE_VERIFIED"
const CAPTURE_CURRENT_MARKER = "SYNTHETIC_MANUAL_CAPTURE_CURRENT_VERIFIED"
const PDF_SENTENCES = [
  ["Our method reduces measured error by twenty percent.", "A controlled experiment supports the main claim."],
  ["The study is limited to a small laboratory sample.", "Future work should test independent populations."],
]
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

/** 普通对话使用可辨认的 Markdown 与合成危险输入；图片地址只指向本机 stub。 */
function createMarkdownFixture(role, origin) {
  return [
    role === "user" ? "## 我的阅读问题" : "## 研究结论摘要",
    "",
    "**关键证据**与*实验背景*，并保留 `source_id` 这样的行内代码。",
    "",
    "> 原文引句需要结合上下文核对。",
    "",
    "- 检查研究方法",
    "- 对照实验结果",
    "",
    "**术语对照（仅用于消歧、非定义）：**",
    "",
    "1. factor structure of exchange rates — 汇率的因子结构",
    "2. easing of monetary policy — 货币政策宽松",
    "3. safe / risky currencies — 安全货币 / 风险货币",
    "4. systematic currency risk — 系统性汇率风险（区别于可分散的特质风险）",
    "5. foreign loan origination — 境外贷款发放",
    "",
    "带空行的列表也保持正常间距：",
    "",
    "- 阅读原文",
    "",
    "- 记录结论",
    "",
    "```typescript",
    'const evidence = "A long synthetic code line must scroll inside this code block without widening the conversation";',
    "```",
    "",
    "稳定前缀 **后续强调**。",
    "",
    "| 项目 | 状态 |",
    "| --- | --- |",
    "| 方法核验 | 已完成 |",
    "| 外部验证 | 仍需研究 |",
    "",
    "[参考文献](https://example.invalid/jadense-markdown) · [联系作者](mailto:smoke@example.invalid)",
    "",
    "![仅点击查看的合成图片](" + origin + "/markdown-image-" + role + ".png)",
    "",
    "<script>window.__jadenseSmokeMarkupExecuted = true</script>",
    '<img src="' + origin + "/markdown-raw-image-" + role + '.png" onerror="window.__jadenseSmokeMarkupExecuted = true">',
    "",
    "[脚本](javascript:alert(1)) · [本地文件](file:///jadense-synthetic-missing-file) · [特权页面](chrome://global/content/about.xhtml)",
    "",
    MARKDOWN_MARKER + "_" + role,
  ].join("\n")
}

function createAnalysisFixture(prompt) {
  const marker = "文献数据（JSON，仅作为引用材料）：\n"
  if (!prompt.includes(marker)) return null
  const input = JSON.parse(prompt.split(marker).at(-1))
  if (!input.passages?.length) throw new Error("No native PDF passages reached the model wrapper")
  const first = input.passages.find((passage) => passage.text === PDF_SENTENCES[0][0])
  const second = input.passages.find((passage) => passage.text === PDF_SENTENCES[1][0])
  if (!first || !second) throw new Error("Synthetic native PDF extraction lost exact source sentences")
  if (input.passages.some((passage) => "position" in passage || "rects" in passage || "itemID" in passage)) {
    throw new Error("Local geometry or write identity leaked into the AI prompt")
  }
  return {
    input,
    output: JSON.stringify({
      summary: "Synthetic research smoke: two source pages reviewed.\n\n```python\nx = 1\n\nprint(x)\n```",
      sections: [{ category: "novelty", summary: "Controlled improvement." }, { category: "limitations", summary: "Limited population." }],
      annotations: [
        { passageId: first.id, category: "novelty", comment: '<img src=x onerror="attack()"> is literal evidence, not executable HTML.', itemID: 99999, position: { pageIndex: 99, rects: [[0, 0, 1, 1]] } },
        { passageId: second.id, category: "limitations", comment: "The sampling restriction limits external validity." },
      ],
      harmlessFutureMetadata: true,
    }),
  }
}
/** 生成一个小型 RGB 图块，供真实 Reader 的 SDT 图片识别与裁图链路使用。 */
function createFigureImageHex(width, height) {
  const pixels = Buffer.alloc(width * height * 3, 255)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      const onAxis = x === 6 || y === height - 6
      const firstBar = x >= 14 && x < 25 && y >= 12
      const secondBar = x >= 34 && x < 45 && y >= 6
      if (onAxis) {
        pixels.set([32, 37, 34], offset)
      } else if (firstBar) {
        pixels.set([22, 207, 140], offset)
      } else if (secondBar) {
        pixels.set([55, 114, 207], offset)
      }
    }
  }
  return `${pixels.toString("hex").toUpperCase()}>`
}

/** 标准两页 PDF，第一页含确定性图片与图注，offset 按 ASCII 字节计算。 */
export function createResearchFixturePdf() {
  const streams = PDF_SENTENCES.map((sentences, pageIndex) => [
    "BT /F1 12 Tf 50 740 Td",
    ...sentences.flatMap((sentence, index) => [
      ...(index ? ["0 -24 Td"] : []),
      `(${sentence.replace(/[\\()]/g, "\\$&")}) Tj`,
    ]),
    "ET",
    ...(pageIndex === 0 ? [
      "q 300 0 0 180 100 440 cm /Im1 Do Q",
      `BT /F1 11 Tf 100 420 Td (${FIGURE_CAPTION.replace(/[\\()]/g, "\\$&")}) Tj ET`,
    ] : []),
  ].join("\n"))
  const figureHex = createFigureImageHex(64, 36)
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> /XObject << /Im1 8 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(streams[0])} >>\nstream\n${streams[0]}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    `<< /Length ${Buffer.byteLength(streams[1])} >>\nstream\n${streams[1]}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Type /XObject /Subtype /Image /Width 64 /Height 36 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${Buffer.byteLength(figureHex)} >>\nstream\n${figureHex}\nendstream`,
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, "ascii")
}

async function startStub() {
  const requests = []
  const failures = []
  const account = { signedToday: false, balancePoints: 36, currentStreakDays: 4, rewardPoints: 2 }
  const server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith("/markdown-")) throw new Error("Markdown triggered an automatic image/resource request")
      if (request.url === "/api/extension/chat/models" && request.method === "GET") {
        if (request.headers.authorization !== `Bearer ${SYNTHETIC_TOKEN}`) throw new Error("Synthetic model-catalog token was not used")
        requests.push({ kind: "model-catalog" })
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({
          options: [
            { kind: "route", routeTier: "standard", displayName: "标准", description: "根据任务自动选择模型", sortOrder: 10, minimumPlanCode: null, locked: false },
            { kind: "route", routeTier: "premium", displayName: "高阶", description: "优先使用高阶模型", sortOrder: 20, minimumPlanCode: "pro", locked: false },
            { kind: "model", modelId: "deepseek-v4-flash-vision-exp", displayName: "DeepSeek V4 Flash Vision Exp", description: "插件默认模型", locked: false, capabilities: ["text", "imageInput"], consumptionMultiplier: 1 },
            { kind: "model", modelId: "synthetic-platform-model", displayName: "Synthetic Research", description: "适合长文研究", sortOrder: 30, minimumPlanCode: null, locked: false, capabilities: ["text", "imageInput"], labels: [], icons: { mode: "shared", src: "/icons/logo-padded.png" }, consumptionMultiplier: 1.25 },
            { kind: "model", modelId: "locked-model", displayName: "受限模型", description: "示例不可用模型", sortOrder: 40, minimumPlanCode: "max", locked: true, lockReason: "升级后可直接选择。", capabilities: ["text"], labels: [], icons: { mode: "shared", src: "/icons/logo-padded.png" }, consumptionMultiplier: 2 },
          ],
          defaultSelection: { kind: "route", routeTier: "standard" },
        }))
        return
      }
      if (request.url === "/api/extension/favorite/folders" && request.method === "GET") {
        if (request.headers.authorization !== `Bearer ${SYNTHETIC_TOKEN}`) throw new Error("Synthetic folder token was not used")
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({
          folders: [{ id: UPLOAD_FOLDER_ID, name: "Synthetic upload folder", isDefault: true, itemCount: 0 }],
          defaultFolderId: UPLOAD_FOLDER_ID,
        }))
        return
      }
      if (["/api/extension/favorite/import-zotero-items", "/api/extension/favorite/import-page-pdf"].includes(request.url)
        && request.method === "POST") {
        if (request.headers.authorization !== `Bearer ${SYNTHETIC_TOKEN}`) throw new Error("Synthetic upload token was not used")
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const body = Buffer.concat(chunks)
        if (request.url.endsWith("import-zotero-items")) {
          const payload = JSON.parse(body.toString("utf8"))
          const expectedCount = requests.some((entry) => entry.kind === "upload-metadata") ? 1 : 2
          if (JSON.stringify(payload.folderIds) !== JSON.stringify([UPLOAD_FOLDER_ID])
            || payload.items?.length !== expectedCount
            || !payload.items.every((item) => typeof item.clientItemId === "string" && item.clientItemId
              && ["Synthetic research smoke paper", "Synthetic unrelated selected paper"].includes(item.metadata?.title))
            || !payload.items.some((item) => item.metadata.doi === "10.1000/jadense-smoke")) {
            throw new Error("Upload lost selected synthetic metadata or its target folder")
          }
          requests.push({ kind: "upload-metadata", itemCount: payload.items.length })
          response.writeHead(200, { "content-type": "application/json" })
          response.end(JSON.stringify({
            importedCount: payload.items.length, skippedCount: 0, failedCount: 0,
            results: payload.items.map((item) => ({ clientItemId: item.clientItemId, status: "imported" })),
          }))
          return
        }
        // Node 原生 multipart 解析器核对 Gecko FormData 的边界、字段与实际 PDF 字节。
        const form = await new Response(body, { headers: { "content-type": request.headers["content-type"] ?? "" } }).formData()
        const file = form.get("file")
        const metadata = JSON.parse(form.get("metadata"))
        const paper = JSON.parse(form.get("paper"))
        if (form.get("folderIds") !== JSON.stringify([UPLOAD_FOLDER_ID])
          || metadata.title !== "Synthetic research smoke paper" || metadata.doi !== "10.1000/jadense-smoke"
          || paper.schemaVersion !== 2 || paper.identity?.doi !== metadata.doi || paper.metadata?.title !== metadata.title
          || file?.type !== "application/pdf" || !file.name.toLowerCase().endsWith(".pdf")
          || !Buffer.from(await file.arrayBuffer()).equals(createResearchFixturePdf())) {
          throw new Error("Multipart upload changed the synthetic PDF, metadata, paper identity, or folder")
        }
        requests.push({ kind: "upload-pdf", multipart: true, byteLength: file.size })
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({
          itemKind: "literature", articleId: "synthetic-uploaded-article",
          insertedFolderIds: [UPLOAD_FOLDER_ID], skippedFolderIds: [],
        }))
        return
      }
      if (request.url === "/api/extension/profile/me" && request.method === "GET") {
        if (request.headers.authorization !== `Bearer ${SYNTHETIC_TOKEN}`) throw new Error("Synthetic account token was not used")
        requests.push({ kind: "account-profile" })
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({
          userId: "research-smoke-user", displayName: "研究烟测用户", avatarUrl: null, avatarSrc: null,
          subscription: { code: "pro", label: "专业版（烟测）" },
        }))
        return
      }
      if (request.url === "/api/extension/points/status" && request.method === "GET") {
        if (request.headers.authorization !== `Bearer ${SYNTHETIC_TOKEN}`) throw new Error("Synthetic points token was not used")
        requests.push({ kind: "points-status", signedToday: account.signedToday, balancePoints: account.balancePoints })
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({
          billing: {
            sourceKind: "personal", teamId: null, balancePoints: account.balancePoints,
            primaryBalancePoints: account.balancePoints, fallbackBalancePoints: null,
          },
          checkIn: {
            signedToday: account.signedToday, currentStreakDays: account.currentStreakDays,
            todayReward: { grantedPoints: account.rewardPoints },
          },
        }))
        return
      }
      if (request.url === "/api/extension/points/check-in" && request.method === "POST") {
        if (request.headers.authorization !== `Bearer ${SYNTHETIC_TOKEN}`) throw new Error("Synthetic check-in token was not used")
        const alreadyCheckedIn = account.signedToday
        const grantedPoints = alreadyCheckedIn ? 0 : account.rewardPoints
        if (!alreadyCheckedIn) {
          account.signedToday = true
          account.balancePoints += grantedPoints
          account.currentStreakDays += 1
        }
        requests.push({ kind: "points-check-in", alreadyCheckedIn, grantedPoints })
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ alreadyCheckedIn, balanceAfter: account.balancePoints, grantedPoints }))
        return
      }
      if (request.url === "/v1/chat/completions" && request.method === "POST") {
        if (request.headers.authorization !== `Bearer ${SYNTHETIC_TOKEN}`) throw new Error("Synthetic BYOK key was not used")
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        const prompt = payload.messages?.at(-1)?.content ?? ""
        if (prompt === "Reply with OK.") {
          if (payload.messages.length !== 1 || payload.max_completion_tokens !== 3000 || payload.model !== "synthetic-unsaved-test-model") {
            throw new Error("BYOK test did not use the unsaved form, fixed prompt, or 3000-token cap")
          }
          requests.push({ kind: "byok-test", endpoint: request.url, maxOutputTokens: payload.max_completion_tokens })
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
          response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
          return
        }
        const analysis = createAnalysisFixture(prompt)
        if (analysis) {
          if (payload.messages.length !== 1 || payload.stream !== true || payload.model !== "synthetic-byok-model") {
            throw new Error("Independent analysis did not use the selected BYOK model as one isolated request")
          }
          requests.push({ kind: "analysis-byok", endpoint: request.url, passages: analysis.input.passages.length })
          await delay(600)
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
          response.end([
            `data: ${JSON.stringify({ choices: [{ delta: { content: analysis.output }, finish_reason: "stop" }] })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""))
          return
        }
        if (!prompt.includes(BYOK_MARKER) || payload.stream !== true || payload.model !== "synthetic-byok-model") {
          throw new Error("BYOK Manager form did not reach the direct Chat Completions endpoint")
        }
        requests.push({ kind: "byok-direct", endpoint: request.url, maxOutputTokens: payload.max_completion_tokens })
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        response.end([
          `data: ${JSON.stringify({ choices: [{ delta: { content: BYOK_MARKER }, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      if (request.url !== "/api/chat" || request.method !== "POST") throw new Error("Unexpected endpoint requested")
      if (request.headers.authorization !== `Bearer ${SYNTHETIC_TOKEN}`) throw new Error("Synthetic token was not used")
      const chunks = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 2_000_000) throw new Error("Synthetic request exceeded its expected size")
        chunks.push(chunk)
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      if (payload.temporary !== true || payload.agentId !== "browser-extension") throw new Error("Request left temporary Chat scope")
      const latestMessage = payload.messages?.at(-1)
      const prompt = latestMessage?.parts?.find((part) => part.type === "text")?.text ?? ""
      const latestFiles = latestMessage?.parts?.filter((part) => part.type === "file") ?? []
      const allFiles = (payload.messages ?? []).flatMap((message) => message.parts?.filter((part) => part.type === "file") ?? [])
      if (prompt.includes(BYOK_MARKER)) throw new Error("BYOK request incorrectly reached /api/chat")
      let output
      let markdownStream = false
      let figureStream = false
      const followUpFigure = prompt.includes(FIGURE_FOLLOWUP_PROMPT)
      if (latestFiles[0]?.name === "synthetic-upload.png") {
        if (latestFiles.length !== 1 || allFiles.length !== 1 || !/^data:image\/png;base64,/.test(latestFiles[0].url)) {
          throw new Error("Uploaded image was not projected exactly once onto the latest user message")
        }
        if (!prompt.includes("不可信引用材料")) throw new Error("Uploaded image lost the untrusted-reference boundary")
        const previous = requests.find(entry => entry.kind === "image-upload")
        if (previous && previous.dataUrlLength !== latestFiles[0].url.length) throw new Error("Reloaded upload changed image bytes")
        requests.push({ kind: previous ? "image-upload-followup" : "image-upload", dataUrlLength: latestFiles[0].url.length })
        output = "SYNTHETIC_IMAGE_UPLOAD_VERIFIED"
      } else if (latestFiles.length) {
        if (payload.modelId !== "deepseek-v4-flash-vision-exp" || "routeTier" in payload) {
          throw new Error("Default Jadense Chat did not explicitly select deepseek-v4-flash-vision-exp")
        }
        if (latestFiles.length !== 1 || allFiles.length !== 1) throw new Error("Figure Chat did not attach exactly one ephemeral image to the latest user message")
        const image = latestFiles[0]
        if (!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(image.url ?? "")) {
          throw new Error("Figure Chat did not send a PNG/JPEG data URL")
        }
        if (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg") throw new Error("Figure Chat sent an unsupported image MIME type")
        const manualCapture = prompt.includes("图注：未识别到高置信图注")
        if (!prompt.includes("不可信引用材料") || !prompt.includes("Synthetic research smoke paper")
          || (!manualCapture && !prompt.includes(FIGURE_CAPTION))) {
          throw new Error("Figure Chat lost its available caption, paper title, or untrusted-evidence boundary")
        }
        if (manualCapture && (!prompt.includes("页码：2") || !prompt.includes('"pageLabel": "2"')
          || !prompt.includes('"caption": null'))) {
          throw new Error("Manual capture invented a caption or lost the selected physical/display page")
        }
        const firstKind = manualCapture ? "manual-capture" : "figure-interpretation"
        const currentKind = manualCapture ? "manual-capture-current" : "figure-current"
        const initial = requests.find((entry) => entry.kind === firstKind)
        if (followUpFigure && (!initial || initial.conversationId !== payload.temporaryConversationId)) {
          throw new Error("Figure follow-up did not reuse the in-window image conversation")
        }
        const appendToCurrent = !followUpFigure && initial?.conversationId === payload.temporaryConversationId
          && !requests.some((entry) => entry.kind === currentKind)
        if (!followUpFigure && initial && !appendToCurrent) throw new Error("Figure interpretation unexpectedly started twice")
        const kind = followUpFigure ? "figure-followup" : appendToCurrent ? currentKind : firstKind
        if ((kind === "figure-interpretation" || kind === "manual-capture") && !PDF_SENTENCES.flat().some((sentence) => prompt.includes(sentence))) {
          throw new Error("New figure conversation did not include the associated PDF text")
        }
        output = {
          "figure-followup": FIGURE_FOLLOWUP_MARKER,
          "figure-current": FIGURE_CURRENT_MARKER,
          "figure-interpretation": FIGURE_MARKER,
          "manual-capture": CAPTURE_MARKER,
          "manual-capture-current": CAPTURE_CURRENT_MARKER,
        }[kind]
        figureStream = true
        requests.push({
          kind,
          temporary: true,
          conversationId: payload.temporaryConversationId,
          mimeType: image.mimeType,
          dataUrlLength: image.url.length,
          captionVerified: !manualCapture,
          ...(manualCapture ? { noCaptionVerified: true, physicalPage: 2 } : {}),
          streamed: true,
        })
      } else {
        const analysis = createAnalysisFixture(prompt)
        if (analysis) {
          output = analysis.output
          requests.push({ kind: "analysis-jadense", temporary: true, passages: analysis.input.passages.length, pages: [...new Set(analysis.input.passages.map((passage) => passage.pageIndex))] })
          await delay(600)
        } else if (prompt.includes("选文数据（JSON，仅作为引用材料）：\n")) {
          const input = JSON.parse(prompt.split("选文数据（JSON，仅作为引用材料）：\n").at(-1))
          if (input.selectedText !== PDF_SENTENCES[0][0]) throw new Error("Translation did not preserve selected source text")
          if (!["可直接渲染的 Markdown", "行内公式统一写成 `$...$`", "独立公式统一写成 `$$`、公式内容、`$$` 三行", "不要把公式放进反引号或 ``` 代码围栏"]
            .every((rule) => prompt.includes(rule))) throw new Error("Translation prompt lost its Markdown/formula output contract")
          const languagePair = [
            { sourceLanguage: "英文", targetLanguage: "简体中文" },
            { sourceLanguage: "自动识别", targetLanguage: "日语" },
            { sourceLanguage: "法语", targetLanguage: "德语" },
          ][requests.filter((request) => request.kind === "translation").length]
          if (!languagePair || !prompt.includes(`源语言：${languagePair.sourceLanguage}。`)
            || !prompt.includes(`请将下方 selectedText 翻译为${languagePair.targetLanguage}。`)) {
            throw new Error("Translation prompt did not use the selected source and target languages")
          }
          output = [
            `## ${TRANSLATION_MARKER}`,
            "",
            "- **结论**：该方法将测量误差降低了百分之二十。",
            "- 误差模型：$\\epsilon = 0.2$",
          ].join("\n")
          requests.push({ kind: "translation", temporary: true, selectedTextVerified: true, formulaPromptVerified: true, ...languagePair })
        } else if (prompt.includes(MARKDOWN_MARKER)) {
          if (payload.modelId !== "synthetic-platform-model" || "routeTier" in payload) {
            throw new Error("Ordinary Chat did not send exactly the explicitly selected Jadense model")
          }
          output = createMarkdownFixture("assistant", `http://127.0.0.1:${server.address().port}`)
          markdownStream = true
          requests.push({ kind: "markdown", temporary: true, streamed: true, modelId: payload.modelId })
        } else {
          throw new Error("Unexpected Chat operation in research smoke")
        }
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      if (figureStream) {
        const split = Math.ceil(output.length / 2)
        response.write(`data: ${JSON.stringify({ type: "text-delta", id: "synthetic", delta: output.slice(0, split) })}\n\n`)
        await delay(600)
        output = output.slice(split)
      } else if (markdownStream) {
        const split = output.indexOf("**。")
        response.write(`data: ${JSON.stringify({ type: "text-delta", id: "synthetic", delta: output.slice(0, split) })}\n\n`)
        // 留出可观测的 streaming 状态，验证正文在 finish 之前已经转换为 Markdown。
        await delay(1200)
        output = output.slice(split)
      }
      response.end([
        `data: ${JSON.stringify({ type: "text-delta", id: "synthetic", delta: output })}\n\n`,
        `data: ${JSON.stringify({ type: "finish", finishReason: "stop" })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(message)
      response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: message }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return { server, origin: `http://127.0.0.1:${server.address().port}`, requests, failures }
}

/** 此函数序列化进临时伴随插件，仅在已核验的隔离 profile 内执行。 */
async function runHarness(config) {
  const report = { state: "running", stage: "startup", checks: [] }
  // Node 正在轮询报告；直接写入避免 Windows 的临时文件 rename 与读句柄竞争。
  // 读取端会忽略尚未写完整的 JSON，并在下一次轮询重试。
  const persist = async () => IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2))
  const stage = async (value) => { report.stage = value; await persist() }
  const normalizePath = (value) => String(value).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase()
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  const waitFor = async (predicate, label, timeout = 45_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await predicate()
      if (value) return value
      const failed = messages().find((message) => message.role === "assistant" && message.status === "failed")
      if (failed) throw new Error(`Release Chat failed: ${failed.text}`)
      await Zotero.Promise.delay(100)
    }
    throw new Error(`Timed out waiting for ${label}`)
  }
  // 与 release runtime 的 Prefs 投影使用同一分支，不能改为 global=true 的另一套键。
  const localState = () => JSON.parse(Zotero.Prefs.get("extensions.jadenseInZotero.localChatState") || "{}")
  const translationState = () => JSON.parse(Zotero.Prefs.get("extensions.jadenseInZotero.translationHistory") || "{}")
  const analysisState = () => JSON.parse(Zotero.Prefs.get("extensions.jadenseInZotero.paperAnalysisHistory") || "{}")
  const currentSession = () => {
    const state = localState()
    return state.sessions?.find((session) => session.id === state.activeSessionId)
  }
  const messages = () => (localState().sessions || []).flatMap((session) => session.messages || [])
  const completed = () => messages().filter((message) => message.role === "assistant" && message.status === "complete")
  const findManagers = () => {
    const managers = []
    const windows = Services.wm.getEnumerator(null)
    while (windows.hasMoreElements()) {
      const candidate = windows.getNext()
      if (String(candidate.location?.href).startsWith("chrome://jadense-in-zotero/content/manager.xhtml")) managers.push(candidate)
    }
    return managers
  }
  const findManager = () => findManagers()[0] ?? null
  const findWindowContaining = (id) => {
    const windows = Services.wm.getEnumerator(null)
    while (windows.hasMoreElements()) {
      const candidate = windows.getNext()
      if (candidate.document?.getElementById(id)) return candidate
    }
    return null
  }
  let manager
  let reader
  let view
  try {
    await Zotero.initializationPromise
    await Zotero.uiReadyPromise
    assert(normalizePath(Zotero.DataDirectory.dir) === normalizePath(config.dataDir), "Refused to access a non-isolated Zotero data directory")
    assert(normalizePath(Zotero.Profile.dir) === normalizePath(config.profileDir), "Refused to access a non-isolated Zotero profile")
    await stage("waiting-for-release-toolbar")
    await waitFor(() => Zotero.Reader._registeredListeners.some((entry) => entry.pluginID === config.pluginID && entry.type === "renderToolbar"), "release reader listeners")
    // uiReadyPromise 早于文库 item cache 载入，先等待，避免合成条目与首次扫描相互竞争。
    await stage("waiting-for-library")
    await Zotero.Libraries.get(Zotero.Libraries.userLibraryID).waitForDataLoad("item")
    Zotero.Prefs.set("extensions.jadenseInZotero.baseUrl", config.origin)
    Zotero.Prefs.set("extensions.jadenseInZotero.token", config.token)
    if (config.upgradeXpi) {
      // 先让同一 Gecko 进程加载旧版样式，再走真实安装升级；冷启动无法覆盖样式缓存混用。
      await stage("warming-previous-manager-cache")
      const previousListener = Zotero.Reader._registeredListeners.find((entry) => entry.pluginID === config.pluginID && entry.type === "renderToolbar")
      const previousManager = Zotero.getMainWindow().openDialog(
        "chrome://jadense-in-zotero/content/manager.xhtml?section=chat", "jadense-upgrade-cache",
        "chrome,dialog=no,titlebar,resizable,width=900,height=700",
        { zotero: Zotero, section: "chat", pluginID: config.pluginID },
      )
      try {
        await waitFor(() => previousManager.document.readyState === "complete"
          && previousManager.document.querySelector(".jdx-chat-message-list"), "previous Manager stylesheet")
        const probe = previousManager.document.createElementNS("http://www.w3.org/1999/xhtml", "div")
        probe.className = "jdx-chat-message-body"
        previousManager.document.body.append(probe)
        report.upgrade = { previousWhiteSpace: previousManager.getComputedStyle(probe).whiteSpace }
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs")
        report.upgrade.from = (await AddonManager.getAddonByID(config.pluginID)).version
        await stage("installing-upgrade-without-restart")
        const file = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile)
        file.initWithPath(config.upgradeXpi)
        const install = await AddonManager.getInstallForFile(file)
        const upgraded = await install.install()
        assert(upgraded.id === config.pluginID, "Upgrade installed a different addon")
        report.upgrade.to = upgraded.version
        await waitFor(() => Zotero.Reader._registeredListeners.some((entry) => entry.pluginID === config.pluginID
          && entry.type === "renderToolbar" && entry !== previousListener), "upgraded reader runtime")
      } finally {
        previousManager.close()
      }
      report.checks.push("in-process-xpi-upgrade")
    }
    // 升级夹具曾打开旧版 Chat 以预热样式；清空隔离 profile 的本地功能数据，验证 0.3.1 首次解析不会创建 Chat。
    for (const key of [
      "extensions.jadenseInZotero.localChatState",
      "extensions.jadenseInZotero.translationHistory",
      "extensions.jadenseInZotero.paperAnalysisHistory",
    ]) Zotero.Prefs.clear(key)
    const parent = new Zotero.Item("journalArticle")
    parent.libraryID = Zotero.Libraries.userLibraryID
    parent.setField("title", "Synthetic research smoke paper")
    parent.setField("date", "2026")
    parent.setField("publicationTitle", "Synthetic Research Journal")
    parent.setField("DOI", "10.1000/jadense-smoke")
    parent.setCreators([{ firstName: "Synthetic", lastName: "Fixture", creatorType: "author" }])
    await parent.saveTx()
    const attachment = await Zotero.Attachments.importFromFile({ file: config.pdfPath, parentItemID: parent.id, contentType: "application/pdf" })
    attachment.setField("title", "PDF")
    await attachment.saveTx()
    const otherPaper = new Zotero.Item("journalArticle")
    otherPaper.libraryID = parent.libraryID
    otherPaper.setField("title", "Synthetic unrelated selected paper")
    await otherPaper.saveTx()
    await stage("opening-synthetic-pdf")
    reader = await Zotero.Reader.open(attachment.id)
    await stage("initializing-reader")
    await reader._initPromise
    view = reader._internalReader._primaryView
    await stage("initializing-pdf-view")
    await view.initializedPromise
    await view._ensureBasicPageData(0)
    const nativePage = view._pdfPages[0]
    report.nativePage = { keys: Object.keys(nativePage), chars: nativePage.chars?.slice(0, 4), segmenter: typeof Intl.Segmenter }
    const readerDoc = reader._iframeWindow.document
    // Gecko 只绘制本次隔离 reader/Manager 的 browsingContext，从不截桌面；系统标题栏由 flags/状态验收。
    const screenshot = async (name, win = reader._iframeWindow) => {
      if (!config.screenshots) return
      try {
        const viewport = { width: win.innerWidth, height: win.innerHeight }
        const { capture } = ChromeUtils.importESModule("chrome://remote/content/shared/Capture.sys.mjs")
        // native PDFView 从 wrappedJSObject 返回 contentWindow；恢复 Xray 才能读取 chrome-only browsingContext。
        const captureWindow = Components.utils.unwaiveXrays(win)
        const browsingContext = captureWindow.browsingContext || captureWindow.docShell?.browsingContext
        if (!browsingContext) throw new Error("The isolated target window has no accessible browsingContext")
        const canvas = await capture.canvas(captureWindow, browsingContext, 0, 0, viewport.width, viewport.height)
        const binary = win.atob(capture.toBase64(canvas, "image/png"))
        const filePath = PathUtils.join(config.screenshotDir, `${name}.png`)
        await IOUtils.write(filePath, Uint8Array.from(binary, (character) => character.charCodeAt(0)))
        ;(report.screenshots ??= []).push(filePath)
        const viewportKey = win === manager ? "managerViewports" : win === reader._iframeWindow ? "readerViewports" : "nativeViewports"
        ;(report[viewportKey] ??= []).push({ name, ...viewport, imageWidth: canvas.width, imageHeight: canvas.height })
      } catch (error) {
        // 功能验收仍可运行；截图不支持时必须明确记录，不能声称已完成视觉核验。
        ;(report.screenshotWarnings ??= []).push(`${name}: ${String(error)}`)
      }
    }
    const toolbarButton = (kind) => readerDoc.querySelector(`[data-jadense-reader-tools="renderToolbar"] [data-jadense-action="${kind}"]`)
    const pressKey = (win, key, modifiers = {}, target = win.document.body) => {
      const event = new win.KeyboardEvent("keydown", Components.utils.cloneInto({
        key, bubbles: true, cancelable: true, ...modifiers,
      }, win))
      target.dispatchEvent(event)
      return event.defaultPrevented
    }
    await waitFor(() => toolbarButton("analyze"), "actual release toolbar")
    if (config.appearanceLanguage) {
      await stage("appearance-and-language")
      const english = config.appearanceLanguage === "en-US"
      assert(toolbarButton("attach").textContent.trim() === (english ? "Ask" : "提问"), "Reader ignored the plugin language")
      const openManager = () => readerDoc.querySelector(".jadense-reader-brand").click()
      openManager()
      manager = await waitFor(() => findManager()?.receiveJadenseContext && findManager(), "appearance Manager")
      const element = (id) => manager.document.getElementById(id)
      element("jadense-manager-nav-settings").click()
      element("jadense-settings-tab-general").click()
      assert(element("jadense-settings-tab-general").textContent === (english ? "General" : "常规"), "Manager language is incorrect")
      assert(Zotero.__jadenseInZoteroUiLocale === config.appearanceLanguage, "Bootstrap locale was not shared with Manager")
      const choose = (root, index) => {
        root.querySelector(".jdx-select-trigger").click()
        root.querySelectorAll('[role="option"]')[index].click()
      }
      const localized = await Zotero.getMainWindow().document.l10n.formatMessages([
        { id: "jadense-in-zotero-menu-configure", args: { language: config.appearanceLanguage } },
      ])
      assert(localized[0].attributes.find(item => item.name === "label").value === (english ? "Configure Jadense connection" : "配置攻玉连接"), "Native Fluent did not honor explicit plugin language")
      await Promise.resolve(Zotero.Utilities.Internal.openPreferences("jadense-in-zotero-preferences"))
      const preferences = await waitFor(() => findWindowContaining("jadense-in-zotero-preferences-pane"), "appearance native Preferences")
      const preferenceRoot = preferences.document.getElementById("jadense-in-zotero-preferences-pane")
      await waitFor(() => preferenceRoot.querySelector(".jdx-select-trigger"), "native General controls")
      assert(preferenceRoot.querySelector('[data-settings-section="general"] h3').textContent === (english ? "General" : "常规"), "Native Preferences language is incorrect")
      const hostThemeBefore = preferences.document.documentElement.getAttribute("data-theme")
      const readerThemeBefore = readerDoc.documentElement.getAttribute("data-theme")
      const draft = element("jadense-chat-input")
      draft.value = "Unsent appearance test draft"
      draft.dispatchEvent(new manager.Event("input", { bubbles: true }))
      const themeEverywhere = value => manager.document.documentElement.dataset.theme === value
        && preferenceRoot.dataset.theme === value
        && Array.from(readerDoc.querySelectorAll("[data-jadense-reader-theme]")).every(root => root.dataset.theme === value)
      for (const [value, index] of [["light", 1], ["dark", 2]]) {
        choose(element("jadense-display-theme"), index)
        await waitFor(() => themeEverywhere(value), "shared " + value + " theme")
        assert(draft.value === "Unsent appearance test draft", "Theme change discarded a draft")
        await screenshot("general-" + config.appearanceLanguage + "-" + value, manager)
        await screenshot("native-general-" + config.appearanceLanguage + "-" + value, preferences)
        await screenshot("reader-" + config.appearanceLanguage + "-" + value)
      }
      choose(element("jadense-display-theme"), 0)
      Zotero.Prefs.set("browser.theme.toolbar-theme", 0, true)
      await waitFor(() => themeEverywhere("dark"), "follow host dark")
      Zotero.Prefs.set("browser.theme.toolbar-theme", 1, true)
      await waitFor(() => themeEverywhere("light"), "follow host light")
      assert(preferences.document.documentElement.getAttribute("data-theme") === hostThemeBefore
        && readerDoc.documentElement.getAttribute("data-theme") === readerThemeBefore, "Plugin changed the host document theme attribute")
      choose(element("jadense-display-language"), english ? 1 : 2)
      assert(Zotero.__jadenseInZoteroUiLocale === config.appearanceLanguage
        && element("jadense-settings-tab-general").textContent === (english ? "General" : "常规"), "Saved language took effect before restart")
      preferences.close()
      manager.close()
      await waitFor(() => !findManager(), "closed appearance Manager")
      openManager()
      manager = await waitFor(() => findManager()?.receiveJadenseContext && findManager(), "reopened appearance Manager")
      assert(element("jadense-settings-tab-general").textContent === (english ? "General" : "常规"), "Reopening Manager applied pending language")
      element("jadense-manager-nav-migrate").click()
      element("jadense-connection-tab-account").click()
      await waitFor(() => element("jadense-manager-account-name").textContent === "研究烟测用户", "appearance account profile")
      assert(!element("jadense-manager-account-check-in"), "Direct check-in control is still present")
      await waitFor(() => element("jadense-manager-account-balance").textContent.includes("36"), "appearance points snapshot")
      const originalFetch = manager.fetch
      try {
        manager.fetch = (url, options) => String(url).endsWith("/api/extension/points/status")
          ? Promise.resolve(new manager.Response('{"error":"synthetic optional points failure"}', { status: 503 }))
          : originalFetch.call(manager, url, options)
        element("jadense-manager-account-refresh").click()
        await waitFor(() => element("jadense-manager-account-status").dataset.kind === "error"
          && element("jadense-manager-account-profile-status").dataset.kind === "success"
          && !element("jadense-manager-account-refresh").disabled, "independent account refresh failure")
        assert(element("jadense-manager-account-name").textContent === "研究烟测用户"
          && element("jadense-manager-account-balance").textContent.includes("36"), "Optional points failure discarded successful account data")
      } finally { manager.fetch = originalFetch }
      element("jadense-manager-account-refresh").click()
      await waitFor(() => element("jadense-manager-account-status").dataset.kind === "success", "points refresh recovery")
      const urls = []
      const originalLaunchURL = Zotero.launchURL
      try {
        Zotero.launchURL = url => urls.push(url)
        for (const id of ["jadense-manager-open-jadense", "jadense-manager-open-check-in", "jadense-manager-open-billing"]) element(id).click()
      } finally { Zotero.launchURL = originalLaunchURL }
      assert(JSON.stringify(urls) === JSON.stringify([config.origin + "/", config.origin + "/app/check-in", config.origin + "/app?settings=billing"]), "Appearance account actions have incorrect URLs")
      const chromeWidth = manager.outerWidth - manager.innerWidth
      const chromeHeight = manager.outerHeight - manager.innerHeight
      manager.resizeTo(760 + chromeWidth, 620 + chromeHeight)
      await waitFor(() => manager.innerWidth === 760, "compact appearance viewport")
      await screenshot("account-" + config.appearanceLanguage + "-compact", manager)
      Zotero.Prefs.set("extensions.jadenseInZotero.token", "")
      const unconfiguredUrls = []
      try {
        Zotero.launchURL = url => unconfiguredUrls.push(url)
        for (const id of ["jadense-manager-open-jadense", "jadense-manager-open-check-in", "jadense-manager-open-billing"]) element(id).click()
      } finally { Zotero.launchURL = originalLaunchURL }
      assert(JSON.stringify(unconfiguredUrls) === JSON.stringify(urls), "Web actions require a plugin token")
      element("jadense-manager-nav-guide").click()
      await screenshot("guide-" + config.appearanceLanguage + "-compact", manager)
      element("jadense-manager-nav-settings").click()
      element("jadense-settings-tab-general").click()
      await screenshot("general-" + config.appearanceLanguage + "-compact", manager)
      assert(manager.document.documentElement.scrollWidth <= manager.innerWidth, "Appearance page overflows horizontally")
      report.checks.push("explicit-plugin-locale-native-manager-reader", "shared-general-preferences", "theme-live-all-owned-surfaces", "host-theme-follow", "host-style-isolation", "theme-preserves-draft", "language-requires-restart-including-reopened-manager", "account-web-actions", "account-refresh-failure-isolation", "web-actions-without-token", "compact-localized-layout")
      report.state = "passed"
      await persist()
      return
    }
    assert(toolbarButton("attach").textContent.trim() === "提问"
      && toolbarButton("attach").title.includes("发起新对话")
      && toolbarButton("attach").getAttribute("aria-label").includes("当前文献"), "Reader question entry does not describe its document and new-conversation behavior")
    report.checks.push("installed-native-toolbar")
    const brand = readerDoc.querySelector('[data-jadense-reader-tools="renderToolbar"] .jadense-reader-brand svg')
    assert(brand?.namespaceURI === "http://www.w3.org/2000/svg" && brand.querySelectorAll("path").length === 3, "Reader toolbar is missing the existing inline brand icon")
    assert(brand.parentElement.textContent.trim() === "" && brand.getBBox().width > 0 && brand.getBoundingClientRect().width === 20, "Reader brand is still text or is not visibly sized")
    assert(brand.closest("[data-jadense-reader-tools]").getAttribute("aria-label") === "Jadense 阅读工具", "Reader icon lost the toolbar accessible name")
    report.checks.push("reader-inline-brand-logo")
    const articleLanguages = await waitFor(() => readerDoc.querySelector("[data-jadense-article-languages]"), "article translation language controls")
    const articleSourceLanguage = articleLanguages.querySelector('select[aria-label="文章源语言"]')
    const articleTargetLanguage = articleLanguages.querySelector('select[aria-label="文章目标语言"]')
    await waitFor(() => articleSourceLanguage?.value === "en" && articleTargetLanguage?.value === "zh-CN", "default English-to-Chinese article languages")
    assert(articleSourceLanguage.querySelector('option[value="auto"]')
      && !articleTargetLanguage.querySelector('option[value="auto"]')
      && articleTargetLanguage.options.length >= 8, "Reader source detection or multiple target languages are unavailable")
    const changeLanguage = (select, value) => {
      select.value = value
      select.dispatchEvent(new reader._iframeWindow.Event("change", Components.utils.cloneInto({ bubbles: true }, reader._iframeWindow)))
    }
    const toggleArticleLanguages = (expanded) => {
      const toggle = readerDoc.querySelector('button[aria-label="文章翻译语言设置"]')
      if (toggle?.getBoundingClientRect().width > 0 && toggle.getAttribute("aria-expanded") !== String(expanded)) toggle.click()
    }
    report.checks.push("reader-article-language-controls", "translation-default-english-to-chinese", "translation-multiple-targets-and-source-detection")
    await stage("empty-selection-hint")
    view._setSelectionRanges()
    toolbarButton("translate").click()
    const notice = await waitFor(() => readerDoc.querySelector("[data-jadense-reader-notice]:not([hidden])"), "local missing-selection hint")
    assert(notice.textContent.includes("先选中") && notice.getAttribute("role") === "status", "Missing selection hint is not visible and accessible")
    assert(!findManager() && messages().length === 0, "Missing selection unexpectedly opened Manager or created a Chat message")
    pressKey(reader._iframeWindow, "Escape")
    assert(notice.hidden, "Escape did not dismiss the local hint")
    report.checks.push("empty-selection-stays-in-reader", "reader-hint-keyboard-dismissal")

    await stage("reader-logo-opens-manager")
    const logoButton = brand.parentElement
    assert(logoButton.localName === "button" && logoButton.getAttribute("aria-label") === "打开攻玉工作台"
      && !logoButton.hasAttribute("aria-hidden") && logoButton.tabIndex === 0, "Reader logo is not an accessible Manager button")
    logoButton.click()
    manager = await waitFor(() => {
      const win = findManager()
      return win?.receiveJadenseContext ? win : null
    }, "logo-opened Manager")
    assert(!manager.document.getElementById("jadense-manager-section-chat").hidden, "Reader logo did not open Chat")
    assert(localState().sessions?.length === 1 && currentSession().messages.length === 0
      && currentSession().sources.length === 0, "Reader logo dispatched a paper action")
    const beforeLogoChatState = JSON.stringify(localState())
    const logoDraft = manager.document.getElementById("jadense-chat-input")
    logoDraft.value = "Synthetic unsent logo draft"
    logoButton.click()
    assert(findManagers().length === 1 && findManager() === manager && logoDraft.value === "Synthetic unsent logo draft"
      && JSON.stringify(localState()) === beforeLogoChatState, "Reader logo reset Chat or opened a duplicate Manager")
    report.checks.push("reader-logo-opens-manager", "reader-logo-reuses-manager-without-chat-action")
    manager.close()
    await waitFor(() => !findManager(), "logo Manager closed")
    // 清除本断言新建的空会话，保留后续首次解析不创建 Chat 的隔离前提。
    Zotero.Prefs.clear("extensions.jadenseInZotero.localChatState")

    await stage("fresh-profile-analysis-no-chat")
    const freshChatState = JSON.stringify(localState())
    toolbarButton("analyze").click()
    manager = await waitFor(findManager, "analysis-first Manager")
    const managerIdle = () => manager.document.getElementById("jadense-chat-stop")?.hidden
      && manager.document.getElementById("jadense-chat-attach-items")?.disabled === false
    await waitFor(() => {
      const status = manager.document.getElementById("jadense-analysis-status")
      if (status?.dataset.kind === "error") throw new Error(`Independent analysis failed: ${status.textContent}`)
      return analysisState().records?.length === 1 && managerIdle()
    }, "fresh-profile independent analysis")
    assert(JSON.stringify(localState()) === freshChatState && !(localState().sessions?.length),
      "Opening analysis on a fresh profile created or changed local Chat")
    report.checks.push("fresh-profile-analysis-no-chat-session")

    await stage("reader-manual-capture-default-shortcut")
    const figureWindow = view._iframeWindow
    const figureDocument = figureWindow.document
    const figureOverlay = await waitFor(() => figureDocument.querySelector("[data-jadense-figure-overlay]"), "production figure overlay")
    const captureArmed = () => figureDocument.querySelector("[data-jadense-capture]")
    const defaultCaptureModifiers = { ctrlKey: !Zotero.isMac, metaKey: Boolean(Zotero.isMac), altKey: true }
    pressKey(figureWindow, "s", defaultCaptureModifiers)
    await waitFor(captureArmed, "default PDF capture shortcut")
    pressKey(figureWindow, "Escape")
    assert(!captureArmed() && figureOverlay.hidden, "Escape left the PDF capture interaction active")

    await stage("manager-shortcut-settings")
    manager.document.getElementById("jadense-manager-nav-settings").click()
    const shortcutsTab = await waitFor(() => manager.document.getElementById("jadense-settings-tab-shortcuts"), "shortcut settings tab")
    const aiSettingsTab = manager.document.getElementById("jadense-settings-tab-ai")
    const shortcutPanel = manager.document.getElementById("jadense-settings-panel-shortcuts")
    const aiSettingsPanel = manager.document.getElementById("jadense-settings-panel-ai")
    assert(shortcutsTab.textContent.trim() === "快捷键设置" && shortcutsTab.getAttribute("role") === "tab"
      && shortcutsTab.getAttribute("aria-controls") === shortcutPanel.id
      && aiSettingsTab.getAttribute("role") === "tab", "Settings lost its accessible AI / shortcut tabs")
    shortcutsTab.click()
    await waitFor(() => !shortcutPanel.hidden && aiSettingsPanel.hidden && shortcutsTab.getAttribute("aria-selected") === "true", "selected shortcut settings panel")
    for (const action of ["capture", "translate"]) {
      assert(manager.document.getElementById(`jadense-shortcut-${action}-input`)?.readOnly,
        "Shortcut recorder is missing its keyboard-recording input: " + action)
    }
    const saveShortcut = async (action, key) => {
      const input = manager.document.getElementById(`jadense-shortcut-${action}-input`)
      input.focus()
      pressKey(manager, key, { ctrlKey: true, shiftKey: true }, input)
      manager.document.getElementById(`jadense-shortcut-${action}-save`).click()
      await waitFor(() => Zotero.Prefs.get(`extensions.jadenseInZotero.readerShortcut.${action}`) === `Ctrl+Shift+${key.toUpperCase()}`, "saved " + action + " shortcut")
    }
    manager.document.getElementById("jadense-shortcut-capture-disable").click()
    manager.document.getElementById("jadense-shortcut-capture-save").click()
    await waitFor(() => Zotero.Prefs.get("extensions.jadenseInZotero.readerShortcut.capture") === "", "disabled PDF capture shortcut")
    pressKey(figureWindow, "s", defaultCaptureModifiers)
    assert(!captureArmed(), "Disabled capture shortcut still activated PDF capture")
    manager.document.getElementById("jadense-shortcut-capture-reset").click()
    assert(Zotero.Prefs.get("extensions.jadenseInZotero.readerShortcut.capture") === "",
      "Resetting the shortcut draft unexpectedly saved it")
    await saveShortcut("capture", "y")
    await saveShortcut("translate", "u")
    pressKey(figureWindow, "s", defaultCaptureModifiers)
    assert(!captureArmed(), "Replaced capture shortcut remained active")
    report.checks.push("capture-default-shortcut", "capture-escape-cancel", "manager-shortcut-tabs", "shortcut-record-save-disable", "shortcut-preferences-live-update")

    await stage("reader-manual-capture-no-sdt-image")
    // 第二页只有两行文字、没有 SDT 图片块；真正框选和原生裁图证明该入口不依赖自动图片识别。
    await reader.navigate({ pageIndex: 1 })
    await waitFor(() => figureWindow.PDFViewerApplication.pdfViewer.currentPageNumber === 2, "text-only PDF page")
    const capturePage = await waitFor(() => figureWindow.PDFViewerApplication.pdfViewer.getPageView(1), "manual capture page view")
    capturePage.div.scrollIntoView({ block: "start" })
    await view._ensureBasicPageData(1)
    await Zotero.Promise.delay(250)
    const capturePoint = (x, y) => {
      const bounds = capturePage.div.getBoundingClientRect()
      const [left, top] = capturePage.viewport.convertToViewportPoint(x, y)
      return { clientX: bounds.left + left, clientY: bounds.top + top }
    }
    const nativeSelectionState = () => ({
      ranges: view._selectionRanges?.length ?? 0,
      text: (view._selectionRanges ?? []).map((range) => range.text ?? "").join(" "),
      pointerDownPosition: view.pointerDownPosition ?? null,
      pointerDownTriggered: Boolean(view._pointerDownTriggered),
      action: view.action?.type ?? null,
    })
    // 真实鼠标先发 PointerEvent，再发兼容 MouseEvent；原生 PDFView 的文本拖选由 mousedown 启动。
    const captureMouseEvent = async (type, position, buttons) => {
      const target = figureDocument.elementFromPoint(position.clientX, position.clientY)
      assert(target, "No native mouse target at the visible PDF coordinate")
      const EventType = type.startsWith("pointer") ? figureWindow.PointerEvent : figureWindow.MouseEvent
      target.dispatchEvent(new EventType(type, Components.utils.cloneInto({
        bubbles: true, cancelable: true, ...position, button: 0, buttons, detail: 1,
        pointerId: 71, pointerType: "mouse", isPrimary: true,
      }, figureWindow)))
      if (type.endsWith("move")) await Zotero.Promise.delay(80)
      return { event: type, buttons, target: target.localName, captureSurface: target.hasAttribute("data-jadense-capture-surface"), ...nativeSelectionState() }
    }
    const nativeMouseDrag = async (start, end) => {
      const events = []
      for (const [type, position, buttons] of [
        ["pointerdown", start, 1], ["mousedown", start, 1],
        ["pointermove", end, 1], ["mousemove", end, 1],
        ["pointerup", end, 0], ["mouseup", end, 0],
        ["pointermove", { clientX: end.clientX + 24, clientY: end.clientY + 8 }, 0],
        ["mousemove", { clientX: end.clientX + 24, clientY: end.clientY + 8 }, 0],
      ]) events.push(await captureMouseEvent(type, position, buttons))
      return events
    }
    const selectCapture = async () => {
      pressKey(figureWindow, "y", { ctrlKey: true, shiftKey: true })
      await waitFor(captureArmed, "configured PDF capture shortcut")
      const start = capturePoint(50, 752)
      const end = capturePoint(430, 680)
      assert([start, end].every(({ clientX, clientY }) => clientX > 0 && clientX < figureWindow.innerWidth
        && clientY > 0 && clientY < figureWindow.innerHeight), "Manual capture fixture is outside the visible PDF viewport")
      const events = await nativeMouseDrag(start, end)
      ;(report.captureMouseGestures ??= []).push(events)
      const selectionLeak = events.some((event) => event.ranges || event.pointerDownPosition)
      const pendingDrag = events.at(-1).pointerDownTriggered
      if (selectionLeak || pendingDrag) await screenshot("reader-manual-capture-native-mouse-regression", figureWindow)
      assert(!selectionLeak, "Manual capture also started native PDF text selection")
      assert(!pendingDrag && !events.at(-1).action, "Manual capture left native mouse dragging active after release")
      await waitFor(() => !figureOverlay.hidden && figureOverlay.dataset.source === "manual"
        && figureOverlay.dataset.state === "locked", "locked manual PDF capture")
      const actions = figureOverlay.querySelector("[data-jadense-figure-actions]")
      assert(actions.querySelectorAll('[data-jadense-action="interpretFigure"]').length === 2
        && actions.querySelector('[data-jadense-action="exitFigure"]')?.textContent.trim() === "退出"
        && figureWindow.getComputedStyle(actions).display !== "none", "Completed PDF capture did not show two interpretation actions and Exit")
    }
    const verifyTextDragAfterCapture = async (exit) => {
      const chars = view._pdfPages[1].chars
      // 第二行没有解析生成的高亮，确保检验的是普通文本拖选，而不是点击原生批注。
      const line = chars.filter((char) => char.rect[1] < chars[0].rect[1] - 12)
      const first = line[0].rect
      const last = line.at(-1).rect
      const events = await nativeMouseDrag(
        capturePoint(first[0] + 1, (first[1] + first[3]) / 2),
        capturePoint(last[2] - 1, (last[1] + last[3]) / 2),
      )
      ;(report.textDragAfterCapture ??= []).push({ exit, events })
      assert(events.some((event) => event.text.includes("Future work")), "Normal native PDF text selection did not resume after " + exit)
      assert(!events.at(-1).pointerDownPosition && !events.at(-1).pointerDownTriggered && !events.at(-1).action,
        "Normal native PDF text drag remained active after release following " + exit)
      assert(events.at(-1).text === events.find((event) => event.event === "mouseup").text,
        "Native PDF selection kept moving after mouse release following " + exit)
      view._setSelectionRanges()
      await waitFor(() => !readerDoc.querySelector('[data-jadense-reader-tools="renderTextSelectionPopup"]'), "cleared native text selection after " + exit)
    }
    const chatBeforeCanceledCapture = JSON.stringify(localState())
    await selectCapture()
    await screenshot("reader-manual-capture-selected", figureWindow)
    figureOverlay.querySelector('[data-jadense-action="exitFigure"]').click()
    const chatAfterCanceledCapture = JSON.stringify(localState())
    const captureStateSummary = (json) => {
      const state = JSON.parse(json)
      return { activeSessionId: state.activeSessionId, sessions: state.sessions?.map((session) => ({ id: session.id, messageCount: session.messages?.length })) }
    }
    report.captureExit = {
      overlayHidden: figureOverlay.hidden, captureArmed: Boolean(captureArmed()),
      overlayState: figureOverlay.dataset.state, overlaySource: figureOverlay.dataset.source,
      chatChanged: chatAfterCanceledCapture !== chatBeforeCanceledCapture,
      before: captureStateSummary(chatBeforeCanceledCapture), after: captureStateSummary(chatAfterCanceledCapture),
    }
    assert(figureOverlay.hidden, "Exit left the completed capture frame visible")
    assert(!captureArmed(), "Exit left PDF capture armed")
    assert(chatAfterCanceledCapture === chatBeforeCanceledCapture, "Canceled capture changed local Chat before interpretation")
    await verifyTextDragAfterCapture("Exit")
    await selectCapture()
    pressKey(figureWindow, "Escape")
    assert(figureOverlay.hidden && !captureArmed(), "Escape did not dismiss the completed capture frame")
    await verifyTextDragAfterCapture("Escape")
    await selectCapture()
    figureOverlay.querySelector('[data-jadense-conversation-target="new"]').click()
    await waitFor(() => currentSession()?.messages?.some((message) => message.role === "assistant"
      && message.status === "complete" && message.text === config.captureMarker) && managerIdle(), "manual PDF capture image interpretation")
    const captureSession = currentSession()
    assert(captureSession.title === "图片解读：Synthetic research smoke paper"
      && captureSession.messages.some((message) => message.role === "user" && message.text.includes("页码：2")
        && message.text.includes("图注：未识别到高置信图注"))
      && captureSession.sources.some((source) => source.kind === "file" && source.itemID === attachment.id),
    "Manual PDF capture lost its literature, selected page, or optional-caption fallback")
    figureOverlay.querySelector('[data-jadense-conversation-target="current"]').click()
    await waitFor(() => currentSession()?.messages?.some((message) => message.role === "assistant"
      && message.status === "complete" && message.text === config.captureCurrentMarker) && managerIdle(), "manual PDF capture append to current conversation")
    assert(currentSession().id === captureSession.id && currentSession().title === captureSession.title
      && JSON.stringify(currentSession().sources) === JSON.stringify(captureSession.sources)
      && !JSON.stringify(localState()).includes("data:image/") && attachment.getAnnotations().length === 2,
    "Manual capture changed existing sources, persisted image bytes, or wrote a PDF annotation")
    figureOverlay.querySelector('[data-jadense-action="exitFigure"]').click()
    report.checks.push("native-manual-pdf-crop-without-sdt-image", "capture-selection-frame-three-actions", "capture-mouse-does-not-select-pdf-text", "capture-release-does-not-retain-native-drag", "capture-exit-and-escape-restore-native-selection", "capture-exit-and-escape-no-chat", "capture-no-caption-page-context", "capture-two-conversation-targets", "capture-no-annotation-or-image-persistence")

    await stage("reader-figure-sdt")
    const findSDTImage = (structure) => {
      const pending = Array.isArray(structure?.content) ? [...structure.content] : []
      while (pending.length) {
        const node = pending.shift()
        if (!node || typeof node !== "object") continue
        const rect = node.type === "image" && Array.isArray(node.anchor?.pageRects)
          ? node.anchor.pageRects.find((value) => Array.isArray(value) && value.length === 5 && value.every(Number.isFinite))
          : null
        if (rect) return { node, rect }
        if (Array.isArray(node.content)) pending.push(...node.content)
      }
      return null
    }
    let sdtFigure
    try {
      sdtFigure = await waitFor(async () => {
        const loaded = await reader._internalReader._loadSDT?.()
        const image = findSDTImage(loaded?.structure)
        return image ? { structure: loaded.structure, ...image } : null
      }, "native SDT image block", 60_000)
    } catch (error) {
      throw new Error(`Zotero 10 did not produce an SDT image block for the synthetic PDF; the production figure path cannot be smoke-tested: ${String(error)}`)
    }
    const [figurePageIndex, x1, y1, x2, y2] = sdtFigure.rect
    report.sdtFigure = { pageRect: [...sdtFigure.rect], captionPresent: JSON.stringify(sdtFigure.structure).includes(config.figureCaption) }
    const figureActions = figureOverlay.querySelector("[data-jadense-figure-actions]")
    const figureButtons = Array.from(figureOverlay.querySelectorAll('[data-jadense-action="interpretFigure"]'))
    const newFigureConversationButton = figureButtons.find((button) => button.dataset.jadenseConversationTarget === "new")
    const currentFigureConversationButton = figureButtons.find((button) => button.dataset.jadenseConversationTarget === "current")
    assert(figureButtons.length === 2
      && newFigureConversationButton?.textContent.trim() === "图片解读（开启新对话）"
      && newFigureConversationButton.getAttribute("aria-label") === "图片解读（开启新对话）"
      && currentFigureConversationButton?.textContent.trim() === "图片解读（追加在当前对话）"
      && currentFigureConversationButton.getAttribute("aria-label") === "图片解读（追加在当前对话）",
    "Figure overlay is missing its two accessible conversation actions")
    assert(!figureOverlay.closest("[data-jadense-reader-tools]") && !readerDoc.contains(figureOverlay),
      "Figure UI was inserted into the top or selection toolbar")
    const toolbarSignature = Array.from(readerDoc.querySelectorAll('[data-jadense-reader-tools="renderToolbar"] [data-jadense-action]'))
      .map((button) => `${button.dataset.jadenseAction}:${button.textContent.trim()}`).join("|")
    const sessionCountBeforeFigure = localState().sessions?.length ?? 0
    await reader.navigate({ pageIndex: figurePageIndex })
    const pageView = await waitFor(() => {
      const candidate = figureWindow.PDFViewerApplication?.pdfViewer?.getPageView?.(figurePageIndex)
        ?? figureWindow.PDFViewerApplication?.pdfViewer?._pages?.[figurePageIndex]
      return candidate?.div && candidate?.viewport ? candidate : null
    }, "figure PDF page view")
    pageView.div.scrollIntoView({ block: "center" })
    await Zotero.Promise.delay(250)
    const localPoint = pageView.viewport.convertToViewportPoint((x1 + x2) / 2, (y1 + y2) / 2)
    const pageBox = pageView.div.getBoundingClientRect()
    const clientX = pageBox.left + Number(localPoint[0])
    const clientY = pageBox.top + Number(localPoint[1])
    assert(Number.isFinite(clientX) && Number.isFinite(clientY), "SDT figure center could not be projected into the PDF viewport")
    const pointerTarget = pageView.div.querySelector(".canvasWrapper") ?? pageView.div
    const pointerEvent = (type, buttons) => new figureWindow.PointerEvent(type, Components.utils.cloneInto({
      bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons,
      pointerId: 1, pointerType: "mouse", isPrimary: true,
    }, figureWindow))
    pointerTarget.dispatchEvent(pointerEvent("pointermove", 0))
    await waitFor(() => !figureOverlay.hidden && figureOverlay.dataset.state === "hover", "figure hover border")
    assert(figureWindow.getComputedStyle(figureActions).display === "none", "Figure actions appeared before the image was selected")
    await screenshot("reader-figure-hover", figureWindow)
    pointerTarget.dispatchEvent(pointerEvent("pointerdown", 1))
    pointerTarget.dispatchEvent(pointerEvent("pointerup", 0))
    pointerTarget.dispatchEvent(new figureWindow.MouseEvent("click", Components.utils.cloneInto({
      bubbles: true, cancelable: true, clientX, clientY, button: 0,
    }, figureWindow)))
    await waitFor(() => !figureOverlay.hidden && figureOverlay.dataset.state === "locked"
      && figureWindow.getComputedStyle(figureActions).display !== "none", "locked figure actions")
    const figureActionBounds = figureActions.getBoundingClientRect()
    assert(figureActionBounds.left >= 7 && figureActionBounds.right <= figureWindow.innerWidth - 7
      && figureActionBounds.top >= 7 && figureActionBounds.bottom <= figureWindow.innerHeight - 7,
    "Figure conversation actions are clipped outside the PDF viewport")
    figureDocument.body.dispatchEvent(new figureWindow.KeyboardEvent("keydown", Components.utils.cloneInto({
      key: "Tab", bubbles: true, cancelable: true,
    }, figureWindow)))
    await waitFor(() => figureDocument.activeElement === newFigureConversationButton, "new figure action keyboard focus")
    newFigureConversationButton.dispatchEvent(new figureWindow.KeyboardEvent("keydown", Components.utils.cloneInto({
      key: "Tab", bubbles: true, cancelable: true,
    }, figureWindow)))
    await waitFor(() => figureDocument.activeElement === currentFigureConversationButton, "current figure action keyboard focus")
    await screenshot("reader-figure-selected", figureWindow)
    newFigureConversationButton.click()
    const figureStreaming = await waitFor(() => {
      const figureNotice = figureDocument.querySelector("[data-jadense-figure-notice]")
      if (figureNotice && !figureNotice.hidden) throw new Error(`Figure submission failed in Reader: ${figureNotice.textContent}`)
      const session = currentSession()
      const node = manager.document.querySelector('.jdx-chat-message[data-role="assistant"][data-status="streaming"]')
      return session?.title === `图片解读：${config.figureCaption}`
        && node?.textContent.includes(config.figureMarker.slice(0, Math.ceil(config.figureMarker.length / 2))) ? node : null
    }, "streaming figure interpretation")
    assert(figureStreaming.dataset.status === "streaming", "Figure response was only rendered after stream completion")
    await screenshot("manager-figure-streaming", manager)
    await waitFor(() => currentSession()?.messages?.some((message) => message.role === "assistant"
      && message.status === "complete" && message.text === config.figureMarker) && managerIdle(), "completed figure interpretation")
    const figureSessionId = currentSession().id
    const firstFigureUser = currentSession().messages.find((message) => message.role === "user")
    assert((localState().sessions?.length ?? 0) === sessionCountBeforeFigure + 1
      && firstFigureUser?.text.includes("请解读这张图片。")
      && firstFigureUser.text.includes("文献：Synthetic research smoke paper")
      && firstFigureUser.text.includes(`图注：${config.figureCaption}`)
      && firstFigureUser.text.includes("附件：已附图"),
    "Figure action did not create the expected dedicated visible conversation")
    assert(currentSession().sources.some((source) => source.kind === "item" && source.itemID === parent.id)
      && currentSession().sources.some((source) => source.kind === "file" && source.itemID === attachment.id
        && config.sentences.flat().some((sentence) => source.text.includes(sentence))),
    "New figure conversation did not automatically associate the literature and extracted PDF text")
    assert(!JSON.stringify(localState()).includes("data:image/"), "Figure data URL leaked into persisted local Chat state")
    const figureMessageImage = await waitFor(() => {
      const image = manager.document.querySelector(`[data-message-id="${firstFigureUser.id}"] .jdx-chat-message-image img`)
      return image?.naturalWidth > 0 ? image : null
    }, "figure image rendered in its user message")
    const fixtureImageDataUrl = figureMessageImage.src
    assert(firstFigureUser.image?.origin === "figure", "Figure message did not persist its local attachment reference")
    const figureFollowupInput = manager.document.getElementById("jadense-chat-input")
    figureFollowupInput.value = config.figureFollowupPrompt
    figureFollowupInput.dispatchEvent(new manager.Event("input", Components.utils.cloneInto({ bubbles: true }, manager)))
    await waitFor(() => !manager.document.getElementById("jadense-chat-send").disabled, "Figure follow-up Send button")
    manager.document.getElementById("jadense-chat-send").click()
    await waitFor(() => currentSession()?.id === figureSessionId && currentSession().messages?.some((message) => message.role === "assistant"
      && message.status === "complete" && message.text === config.figureFollowupMarker) && managerIdle(), "figure follow-up with in-window image")
    assert(!JSON.stringify(localState()).includes("data:image/")
      && toolbarSignature === Array.from(readerDoc.querySelectorAll('[data-jadense-reader-tools="renderToolbar"] [data-jadense-action]'))
        .map((button) => `${button.dataset.jadenseAction}:${button.textContent.trim()}`).join("|")
      && !readerDoc.querySelector('[data-jadense-reader-tools="renderTextSelectionPopup"]'),
    "Figure conversation persisted image bytes or changed the top/selection toolbars")
    const figureSessionTitle = currentSession().title
    const figureSources = JSON.stringify(currentSession().sources)
    currentFigureConversationButton.click()
    await waitFor(() => currentSession()?.id === figureSessionId && currentSession().messages?.some((message) => message.role === "assistant"
      && message.status === "complete" && message.text === config.figureCurrentMarker) && managerIdle(), "figure append to current conversation")
    assert((localState().sessions?.length ?? 0) === sessionCountBeforeFigure + 1
      && currentSession().title === figureSessionTitle
      && JSON.stringify(currentSession().sources) === figureSources,
    "Appending a figure changed the current conversation identity, title, or sources")
    await waitFor(() => Array.from(manager.document.querySelectorAll('.jdx-chat-message-image img')).filter(image => image.naturalWidth > 0).length === 2,
      "both figure messages retain their own image")
    report.checks.push("native-sdt-figure-hover-and-lock", "figure-independent-reader-tools", "figure-two-conversation-targets", "figure-actions-keyboard", "figure-actions-viewport-clamped", "figure-caption-multimodal-chat", "figure-new-conversation-auto-sources", "figure-streaming-response", "figure-in-window-followup-image", "figure-data-url-not-persisted", "jadense-chat-default-deepseek-v4-flash-vision-exp")

    await stage("reader-question-new-conversation")
    toolbarButton("attach").click()
    manager = await waitFor(findManager, "actual release Manager")
    await waitFor(() => managerIdle() && currentSession()?.sources?.some((source) => source.kind === "file" && source.itemID === attachment.id), "question document association")
    const questionSessionId = currentSession().id
    assert(currentSession().messages.length === 0 && currentSession().title.includes(parent.getField("title")), "Reader question entry sent a message or lost the paper title")
    assert(!manager.document.getElementById("jadense-chat-analyze-paper")
      && !manager.document.querySelector('[data-action="analyze"], .jdx-chat-source-analyze'), "Analysis remains an ambiguous action inside Chat")
    report.managerInitialWindow = {
      innerWidth: manager.innerWidth, innerHeight: manager.innerHeight,
      outerWidth: manager.outerWidth, outerHeight: manager.outerHeight,
      screenWidth: manager.screen.availWidth, screenHeight: manager.screen.availHeight,
    }
    assert(manager.innerWidth >= Math.min(1280, manager.screen.availWidth - 32)
      && manager.outerWidth <= manager.screen.availWidth && manager.outerHeight <= manager.screen.availHeight,
      "Default Manager size does not accommodate three regions and native chrome within its screen")
    report.checks.push("reader-question-label", "reader-question-new-local-session", "analysis-reader-only", "wider-screen-bounded-manager")

    await stage("native-conversation-resource-picker")
    manager.document.getElementById("jadense-chat-new-session").click()
    await waitFor(() => currentSession()?.id !== questionSessionId && managerIdle(), "empty resource-picker conversation")
    const pickerSessionId = currentSession().id
    await Zotero.getMainWindow().ZoteroPane.selectItem(otherPaper.id)
    const detailsToggle = manager.document.getElementById("jadense-chat-details-toggle")
    if (detailsToggle.getAttribute("aria-expanded") !== "true") detailsToggle.click()
    // 原生 modal 会运行嵌套事件循环；先安排确认操作，再触发真实 Manager 按钮。
    const chooseSources = async (buttonId, selectedIDs) => {
      manager.focus()
      await waitFor(() => Services.focus.activeWindow === manager, "Manager focused before resource selection", 8_000)
      const previousPicker = Services.wm.getMostRecentWindow("zotero:item-selector")
      let picker
      const interaction = (async () => {
        picker = await waitFor(() => {
          const candidate = Services.wm.getMostRecentWindow("zotero:item-selector")
          return candidate && candidate !== previousPicker && !candidate.closed ? candidate : null
        }, "new native source picker", 15_000)
        await waitFor(() => picker.loaded && picker.itemsView && picker.collectionsView, "native source picker item tree", 15_000)
        const dialog = picker.document.querySelector("dialog")
        if (selectedIDs) {
          let treeSelected = false
          try {
            const targetItems = await Zotero.Items.getAsync(selectedIDs)
            await picker.collectionsView.selectLibrary(targetItems[0].libraryID)
            await picker.itemsView.waitForLoad()
            const rows = []
            for (const itemID of selectedIDs) {
              await picker.itemsView.expandToItem(itemID)
              const row = picker.itemsView.getRowIndexByID(itemID)
              if (row === false) throw new Error(`Native picker cannot reveal synthetic item ${itemID}`)
              rows.push(row)
            }
            picker.itemsView.selection.select(rows[0])
            for (const row of rows.slice(1)) picker.itemsView.selection.toggleSelect(row)
            treeSelected = Boolean(await waitFor(() => {
              const selected = picker.itemsView.getSelectedItems(true)
                .map((item) => typeof item === "object" ? item.id : item)
                .sort((left, right) => left - right)
              report.pickerSelectionProbe = { buttonId, requested: selectedIDs, selected }
              return JSON.stringify(selected) === JSON.stringify([...selectedIDs].sort((left, right) => left - right))
            }, "native picker requested synthetic resources", 2_000))
          } catch {
            treeSelected = false
          }
          if (treeSelected) dialog.acceptDialog()
          else {
            picker.io.dataOut = [...selectedIDs]
            ;(report.nativePickerFixtureFallbacks ??= []).push({ buttonId, selectedIDs })
            picker.close()
          }
        } else dialog.cancelDialog()
      })().catch((error) => { picker?.close(); return error })
      manager.document.getElementById(buttonId).click()
      const error = await interaction
      if (error) throw error
      await waitFor(() => picker.closed || Services.wm.getMostRecentWindow("zotero:item-selector") !== picker,
        "native source picker closed", 8_000)
      await waitFor(managerIdle, "resource picker settled")
      await waitFor(() => Services.focus.activeWindow === manager, "Manager focus restored after resource selection", 8_000)
      ;(report.nativePickers ??= []).push({ buttonId, canceled: selectedIDs === null, returnedToManager: Services.focus.activeWindow === manager })
    }
    await chooseSources("jadense-chat-attach-items", [parent.id])
    assert(currentSession().sources.length === 1 && currentSession().sources[0].itemID === parent.id,
      "Chat item association used the main-window selection instead of the picker")
    await chooseSources("jadense-chat-attach-files", [attachment.id])
    assert(currentSession().sources.some((source) => source.kind === "file" && source.itemID === attachment.id)
      && !currentSession().sources.some((source) => source.itemID === otherPaper.id), "Chat file association ignored the native attachment choice")
    const sourceGroups = manager.document.querySelectorAll(".jdx-chat-source-group")
    assert(sourceGroups.length === 1 && sourceGroups[0].querySelector("summary").textContent.includes(parent.getField("title")),
      "Generic PDF title is not grouped under its owning literature")
    await chooseSources("jadense-chat-attach-items", [otherPaper.id])
    const groupsForRemoval = Array.from(manager.document.querySelectorAll(".jdx-chat-source-group"))
    const remainingGroup = groupsForRemoval.find((group) => group.querySelector("summary").textContent.includes(otherPaper.getField("title")))
    const removedGroup = groupsForRemoval.find((group) => group.querySelector("summary").textContent.includes(parent.getField("title")))
    remainingGroup.querySelector("summary").click()
    assert(!remainingGroup.open && removedGroup.open, "Source removal focus fixture did not retain a collapsed adjacent literature")
    removedGroup.querySelector(".jdx-chat-source-group-remove").click()
    await waitFor(() => currentSession().sources.length === 1, "remove visible literature while another group is collapsed")
    const remainingSummary = manager.document.querySelector(".jdx-chat-source-group > summary")
    assert(manager.document.activeElement === remainingSummary && remainingSummary.textContent.includes(otherPaper.getField("title")),
      "Source removal focused the document body or a hidden resource instead of the remaining group summary")
    remainingSummary.click()
    manager.document.querySelector(".jdx-chat-source-group-remove").click()
    await waitFor(() => currentSession().sources.length === 0, "remove literature group from this conversation")
    assert(!Zotero.Items.get(parent.id).deleted && !Zotero.Items.get(attachment.id).deleted && !Zotero.Items.get(otherPaper.id).deleted,
      "Removing a conversation association deleted its Zotero literature or file")
    await chooseSources("jadense-chat-attach-files", [attachment.id])
    const sourcesBeforeCancel = JSON.stringify(currentSession().sources)
    await chooseSources("jadense-chat-attach-items", null)
    assert(JSON.stringify(currentSession().sources) === sourcesBeforeCancel && currentSession().id === pickerSessionId,
      "Canceling the resource picker changed the current conversation")
    report.checks.push("native-item-picker", "native-file-picker", "picker-independent-of-main-selection", "native-picker-cancel-no-op", "native-picker-returns-to-manager", "generic-pdf-grouped-by-literature", "group-removal-keeps-zotero-content", "source-removal-focus-visible-group-summary")

    await stage("conversation-panel-collapse")
    const draftInput = manager.document.getElementById("jadense-chat-input")
    const retainedDraft = "Synthetic unsent question must stay with this conversation."
    draftInput.value = retainedDraft
    draftInput.dispatchEvent(new manager.Event("input", Components.utils.cloneInto({ bubbles: true }, manager)))
    const questionSessionButton = Array.from(manager.document.querySelectorAll(".jdx-chat-session-button"))
      .find((candidate) => candidate.dataset.sessionId === questionSessionId)
    const pickerSessionButton = Array.from(manager.document.querySelectorAll(".jdx-chat-session-button"))
      .find((candidate) => candidate.dataset.sessionId === pickerSessionId)
    assert(questionSessionButton && pickerSessionButton, "Draft persistence fixture lost a source conversation")
    questionSessionButton.click()
    await waitFor(() => currentSession().id === questionSessionId, "question conversation before draft restore")
    pickerSessionButton.click()
    await waitFor(() => currentSession().id === pickerSessionId && draftInput.value === retainedDraft, "resource conversation draft restore")
    for (const [toggleID, panelID] of [
      ["jadense-chat-sessions-toggle", "jadense-chat-sessions"],
      ["jadense-chat-details-toggle", "jadense-chat-source-panel"],
    ]) {
      const toggle = manager.document.getElementById(toggleID)
      const panel = manager.document.getElementById(panelID)
      if (toggle.getAttribute("aria-expanded") !== "true") toggle.click()
      toggle.click()
      assert(toggle.getAttribute("aria-expanded") === "false" && manager.getComputedStyle(panel).display === "none", "Conversation panel did not collapse: " + panelID)
      toggle.click()
      assert(toggle.getAttribute("aria-expanded") === "true" && manager.getComputedStyle(panel).display !== "none", "Conversation panel did not expand: " + panelID)
    }
    assert(draftInput.value === retainedDraft && JSON.stringify(currentSession().sources) === sourcesBeforeCancel,
      "Collapsing conversation panels changed the draft or resource associations")
    manager.document.getElementById("jadense-chat-details-close").click()
    assert(detailsToggle.getAttribute("aria-expanded") === "false", "Details close button did not collapse the panel")
    detailsToggle.click()
    report.checks.push("conversation-list-collapse-expand", "conversation-details-collapse-expand", "panel-toggles-preserve-draft-and-sources")

    await stage("first-analysis")
    const chatBeforeAnalysis = JSON.stringify(localState())
    assert(analysisState().records?.length === 1, "Fresh analysis history was lost or old Chat was migrated into it")
    await Zotero.Reader.open(attachment.id)
    toolbarButton("analyze").click()
    await waitFor(() => !manager.document.getElementById("jadense-manager-section-analysis").hidden
      && manager.document.getElementById("jadense-analysis-tab-history").getAttribute("aria-selected") === "true", "independent analysis history page")
    await screenshot("manager-analysis-in-progress", manager)
    await waitFor(() => analysisState().records?.length === 2 && managerIdle()
      && manager.document.getElementById("jadense-analysis-stop").hidden, "first independent analysis completion")
    assert(JSON.stringify(localState()) === chatBeforeAnalysis, "Reader analysis created or changed a local Chat conversation")
    const firstAnalysisRecord = analysisState().records[0]
    assert(firstAnalysisRecord.source.itemID === attachment.id
      && firstAnalysisRecord.source.libraryID === attachment.libraryID
      && firstAnalysisRecord.source.itemKey === attachment.key
      && firstAnalysisRecord.source.title === parent.getField("title")
      && firstAnalysisRecord.source.authors.includes("Synthetic Fixture")
      && firstAnalysisRecord.source.publicationTitle === "Synthetic Research Journal"
      && firstAnalysisRecord.source.doi === "10.1000/jadense-smoke"
      && firstAnalysisRecord.summary.includes("Synthetic research smoke"), "Analysis history lost structured literature metadata or summary")
    assert(firstAnalysisRecord.notes?.includes("Controlled improvement.")
      && firstAnalysisRecord.notes?.includes(config.sentences[0][0]), "Analysis history lost readable findings and source-sentence backup")
    let annotations = attachment.getAnnotations()
    assert(annotations.length === 2, `Expected two annotations; got ${annotations.length}`)
    const first = annotations.find((annotation) => annotation.annotationText === config.sentences[0][0])
    const second = annotations.find((annotation) => annotation.annotationText === config.sentences[1][0])
    assert(first && second, "Stored annotation text is not the exact original PDF sentence")
    for (const [annotation, expectedPage, category] of [[first, 0, "novelty"], [second, 1, "limitations"]]) {
      const position = JSON.parse(annotation.annotationPosition)
      assert(annotation.parentID === attachment.id, "Annotation escaped its source attachment")
      assert(annotation.annotationType === "highlight", "Saved annotation is not a native highlight")
      assert(position.pageIndex === expectedPage && position.rects.length > 0, "Annotation geometry or page is incorrect")
      assert(position.rects.every((rect) => rect.length === 4 && rect.every(Number.isFinite) && rect[0] > 1 && rect[2] > rect[0] && rect[3] > rect[1]), "Fabricated model geometry reached native storage")
      assert(annotation.getTags().some((tag) => tag.tag === `Jadense AI/${category}`), "Structured category tag missing")
    }
    assert(!first.annotationComment.includes("<img") && first.annotationComment.includes("&lt;img"), "Untrusted HTML was not escaped in native annotation comment")
    report.checks.push("exact-source-annotations", "local-only-geometry", "structured-tags", "escaped-comment")
    const analysisCode = manager.document.querySelector("#jadense-analysis-history .jdx-analysis-summary").querySelectorAll("pre > code")
    assert(analysisCode.length === 1 && analysisCode[0].textContent.includes("x = 1") && analysisCode[0].textContent.includes("print(x)"), "Analysis split a fenced code block at its blank line")
    const analysisTitle = manager.document.querySelector("#jadense-analysis-history .jdx-analysis-title")
    assert(analysisTitle?.localName === "button" && analysisTitle.type === "button" && analysisTitle.getAttribute("aria-label")?.includes("Zotero 阅读器"),
      "Analysis history title is not an accessible native button")
    analysisTitle.click()
    await waitFor(() => manager.document.getElementById("jadense-analysis-status").dataset.kind === "success", "analysis title PDF Reader navigation")
    report.checks.push("analysis-multiline-code-block", "analysis-title-native-reader")
    const historyTab = manager.document.getElementById("jadense-analysis-tab-history")
    const configTab = manager.document.getElementById("jadense-analysis-tab-config")
    historyTab.focus()
    historyTab.dispatchEvent(new manager.KeyboardEvent("keydown", Components.utils.cloneInto({ key: "ArrowRight", bubbles: true }, manager)))
    assert(configTab.getAttribute("aria-selected") === "true" && manager.document.activeElement === configTab
      && !manager.document.getElementById("jadense-analysis-panel-config").hidden, "Analysis tabs do not support keyboard navigation")
    configTab.dispatchEvent(new manager.KeyboardEvent("keydown", Components.utils.cloneInto({ key: "Home", bubbles: true }, manager)))
    assert(historyTab.getAttribute("aria-selected") === "true" && manager.document.activeElement === historyTab, "Analysis Home key did not return to history")
    const analysisNotes = manager.document.querySelector("#jadense-analysis-history .jdx-analysis-notes")
    assert(analysisNotes?.localName === "details" && analysisNotes.querySelector(".jdx-analysis-copy"), "Analysis notes lack native disclosure or copy control")
    analysisNotes.querySelector("summary").click()
    assert(analysisNotes.open && analysisNotes.querySelector(".jdx-analysis-notes-text").textContent.includes("Controlled improvement."), "Analysis notes cannot be expanded")
    report.checks.push("analysis-independent-from-chat", "analysis-history-readable-backup", "analysis-notes-disclosure", "analysis-tabs-keyboard")
    const annotationKeys = annotations.map((annotation) => annotation.key).sort()
    await stage("repeat-analysis")
    toolbarButton("analyze").click()
    await waitFor(() => analysisState().records?.length === 3 && managerIdle(), "repeat independent analysis completion")
    assert(JSON.stringify(localState()) === chatBeforeAnalysis, "Repeated analysis changed local Chat")
    assert(JSON.stringify(analysisState().records[1]) === JSON.stringify(firstAnalysisRecord), "New analysis changed the prior analysis history record")
    annotations = attachment.getAnnotations()
    assert(JSON.stringify(annotations.map((annotation) => annotation.key).sort()) === JSON.stringify(annotationKeys), "Repeated analysis created or replaced annotations")
    report.checks.push("repeat-analysis-idempotency", "repeat-analysis-adds-history", "prior-analysis-history-preserved", "analysis-no-chat-session")

    // 注入合成选区到原生 selection 状态，走真实 popup 扩展插槽和生产点击处理器。
    const showSelection = async () => {
      // 与 Zotero Reader.navigate 一样，传对象到 reader 前必须先跨 compartment 克隆。
      const position = Components.utils.cloneInto(JSON.parse(first.annotationPosition), reader._iframeWindow)
      await Zotero.Reader.open(attachment.id)
      await waitFor(() => view._iframeWindow.PDFViewerApplication.pdfViewer._pages[0]?.viewport, "first-page viewport")
      await view.navigateToPosition(position)
      await view._ensureBasicPageData(0)
      view._setSelectionRanges(Components.utils.cloneInto([{
        pageIndex: 0, position, sortIndex: first.annotationSortIndex,
        text: first.annotationText, collapsed: false, anchor: true, head: true,
        anchorOffset: 0, headOffset: 10,
      }], reader._iframeWindow))
      return waitFor(() => readerDoc.querySelector('[data-jadense-reader-tools="renderTextSelectionPopup"]'), "native selection popup")
    }
    await stage("quote-selection")
    let popup = await showSelection()
    assert(!popup.querySelector('[data-jadense-action="interpretFigure"]'), "Figure action leaked into the text-selection toolbar")
    await screenshot("reader-selection-popup")
    popup.querySelector('[data-jadense-action="quote"]').click()
    await waitFor(() => currentSession().sources.some((source) => source.kind === "quote" && source.text === first.annotationText && source.pageIndex === 0), "quoted source in local Chat")
    assert(manager.document.querySelectorAll(".jdx-chat-source-group").length === 1,
      "Quote and PDF from the same literature appear as unrelated resource groups")
    report.checks.push("native-popup-quote", "literature-pdf-and-quote-one-group")
    await stage("translate-selection")
    popup = await showSelection()
    const messagesBeforeTranslation = messages().length
    popup.querySelector('[data-jadense-action="translate"]').click()
    const translationPanel = await waitFor(() => {
      const panel = readerDoc.querySelector('[data-jadense-translation-panel]:not([hidden])')
      return panel?.querySelector(".jadense-translation-result")?.textContent.includes(config.translationMarker) ? panel : null
    }, "reader translation panel")
    await waitFor(() => translationState().records?.[0]?.result?.text.includes(config.translationMarker), "independent translation history")
    assert(translationPanel.getAttribute("role") === "region"
      && translationPanel.querySelector(".jadense-translation-content")?.textContent.includes(first.annotationText),
    "Reader translation panel lost its accessible region or selected source")
    assert(translationPanel.querySelector(".jadense-translation-result h2")
      && translationPanel.querySelector(".jadense-translation-result ul")
      && translationPanel.querySelector(".jadense-translation-result strong")
      && translationPanel.querySelector(".jadense-translation-result math annotation")?.textContent === "\\epsilon = 0.2",
    "Reader translation panel did not render Markdown while preserving formula notation")
    const sentenceLanguages = translationPanel.querySelector("[data-jadense-sentence-languages]")
    const sentenceSourceLanguage = sentenceLanguages?.querySelector('select[aria-label="本句源语言"]')
    const sentenceTargetLanguage = sentenceLanguages?.querySelector('select[aria-label="本句目标语言"]')
    assert(sentenceSourceLanguage?.value === "en" && sentenceTargetLanguage?.value === "zh-CN"
      && translationState().records[0].result.sourceLanguage === "英文"
      && translationState().records[0].result.targetLanguage === "简体中文", "Initial translation did not inherit and store the default languages")
    await screenshot("reader-translation-panel")
    await stage("reader-sentence-language-override")
    const historyBeforeOverride = translationState().records.length
    // 点击语言控件会失去原生选区；重译必须继续使用浮窗保存的原句快照。
    view._setSelectionRanges()
    changeLanguage(sentenceSourceLanguage, "auto")
    changeLanguage(sentenceTargetLanguage, "ja")
    assert(!translationPanel.querySelector(".jadense-translation-result")?.textContent.includes(config.translationMarker), "Changing sentence languages kept a stale translation visible")
    assert(translationState().records.length === historyBeforeOverride, "Changing sentence languages dispatched before explicit retranslation")
    const retranslate = Array.from(translationPanel.querySelectorAll("button")).find((button) => button.textContent.trim() === "重新翻译")
    assert(retranslate && !retranslate.disabled, "Sentence language controls lack the explicit retranslation action")
    retranslate.click()
    await waitFor(() => translationState().records.length === historyBeforeOverride + 1
      && translationPanel.querySelector(".jadense-translation-result")?.textContent.includes(config.translationMarker), "sentence language override translation")
    const overrideRecord = translationState().records[0]
    assert(overrideRecord.source.text === first.annotationText && overrideRecord.source.pageIndex === 0
      && overrideRecord.result.sourceLanguage === "自动识别" && overrideRecord.result.targetLanguage === "日语",
    "Sentence retranslation lost its source snapshot or selected language labels")
    assert(articleSourceLanguage.value === "en" && articleTargetLanguage.value === "zh-CN", "Sentence language override changed the article preferences")
    await screenshot("reader-translation-sentence-languages")
    report.checks.push("sentence-language-explicit-retranslation", "sentence-retranslation-preserves-source-snapshot", "sentence-language-isolated-from-article", "translation-history-language-labels")
    await stage("reader-article-language-preferences")
    toggleArticleLanguages(true)
    changeLanguage(articleSourceLanguage, "fr")
    const articlePreferenceKey = `extensions.jadenseInZotero.articleTranslationLanguages.${parent.libraryID}.${encodeURIComponent(parent.key)}`
    const savedArticleLanguages = () => JSON.parse(Zotero.Prefs.get(articlePreferenceKey, true) || "{}")
    await waitFor(() => savedArticleLanguages().sourceLanguage === "fr", "article source language autosave")
    changeLanguage(articleTargetLanguage, "de")
    await waitFor(() => savedArticleLanguages().sourceLanguage === "fr" && savedArticleLanguages().targetLanguage === "de", "article target language autosave")
    toggleArticleLanguages(false)
    await stage("reader-configured-translation-shortcut")
    translationPanel.querySelector(".jadense-translation-close").click()
    const historyBeforeShortcut = translationState().records.length
    await showSelection()
    // Gecko 事件包装的 defaultPrevented 不用于验收；检查实际浮窗和独立翻译历史。
    pressKey(figureWindow, "u", { ctrlKey: true, shiftKey: true })
    await waitFor(() => !translationPanel.hidden && translationState().records.length === historyBeforeShortcut + 1
      && translationPanel.querySelector(".jadense-translation-result")?.textContent.includes(config.translationMarker), "translation shortcut result and independent history")
    assert(sentenceSourceLanguage.value === "fr" && sentenceTargetLanguage.value === "de"
      && translationState().records[0].result.sourceLanguage === "法语"
      && translationState().records[0].result.targetLanguage === "德语", "Next selection reused the sentence override instead of the article languages")
    report.checks.push("configured-pdf-translation-shortcut", "translation-shortcut-same-selection-and-panel")
    assert(messages().length === messagesBeforeTranslation, "Reader translation unexpectedly wrote to local Chat history")
    assert(attachment.getAnnotations().length === 2, "Translation unexpectedly modified annotations")
    if (config.screenshots) {
      const previousTheme = manager.document.documentElement.dataset.theme
      for (const theme of ["light", "dark"]) {
        if (manager.document.documentElement.dataset.theme !== theme) manager.document.getElementById("jadense-manager-theme-toggle").click()
        await waitFor(() => manager.document.documentElement.dataset.theme === theme, "resource panel " + theme + " theme")
        await screenshot("manager-conversation-resources-" + theme, manager)
      }
      if (manager.document.documentElement.dataset.theme !== previousTheme) manager.document.getElementById("jadense-manager-theme-toggle").click()
    }
    manager.document.getElementById("jadense-manager-nav-translations").click()
    await waitFor(() => manager.document.getElementById("jadense-translation-history")?.textContent.includes(config.translationMarker), "Manager translation history page")
    const translationRecord = translationState().records[0]
    assert(translationRecord.source.itemID === attachment.id && translationRecord.source.libraryID === attachment.libraryID
      && translationRecord.source.itemKey === attachment.key && translationRecord.source.pageIndex === 0,
    "Translation history did not retain the exact attachment identity and page")
    assert(manager.document.querySelector("#jadense-translation-history .jdx-markdown h2")
      && manager.document.querySelector("#jadense-translation-history .jdx-markdown ul")
      && manager.document.querySelector("#jadense-translation-history .jdx-markdown strong")
      && manager.document.querySelector("#jadense-translation-history .jdx-markdown math annotation")?.textContent === "\\epsilon = 0.2",
    "Translation history did not render Markdown while preserving formula notation")
    const translationTitle = manager.document.querySelector("#jadense-translation-history .jdx-translation-title")
    assert(translationTitle?.localName === "button" && translationTitle.type === "button" && translationTitle.getAttribute("aria-label")?.includes("Zotero 阅读器"),
      "Translation history title is not an accessible native button")
    await reader.navigate({ pageIndex: JSON.parse(second.annotationPosition).pageIndex })
    await waitFor(() => view._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber === 2, "second PDF page before translation navigation")
    translationTitle.click()
    await waitFor(() => view._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber === 1
      && manager.document.getElementById("jadense-translation-history-status").dataset.kind === "success", "translation title exact-page Reader navigation")
    await screenshot("manager-translation-history", manager)
    manager.document.getElementById("jadense-manager-nav-chat").click()
    report.checks.push("native-popup-translation", "translation-markdown-and-formula", "translation-no-chat-or-annotation-side-effects", "translation-history-page", "translation-title-native-reader-page")

    await stage("native-manager-window-controls")
    const chrome = Components.interfaces.nsIWebBrowserChrome
    const appWindow = manager.docShell.treeOwner.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
      .getInterface(Components.interfaces.nsIAppWindow)
    const flags = appWindow.chromeFlags
    assert((flags & chrome.CHROME_OPENAS_DIALOG) === 0, "Manager is still a dialog without ordinary native window controls")
    assert((flags & chrome.CHROME_TITLEBAR) !== 0 && (flags & chrome.CHROME_WINDOW_RESIZE) !== 0, "Manager is missing native titlebar/resize capabilities")
    assert(["minimize", "maximize", "restore"].every((method) => typeof manager[method] === "function"), "Native Manager window controls are unavailable")
    report.managerChromeFlags = { value: flags >>> 0, dialog: false, titlebar: true, resizable: true }
    const sessionBeforeControls = localState().activeSessionId
    const messageCountBeforeControls = messages().length
    const reopenManager = async (expectedState) => {
      // 必须走 release 的入口触发 focus；smoke 自己 restore 会掩盖最小化恢复缺陷。
      const previousSessionId = currentSession().id
      toolbarButton("attach").click()
      await waitFor(() => manager.windowState === expectedState, "Manager restored by reader entry", 8_000)
      await waitFor(() => managerIdle() && currentSession().id !== previousSessionId
        && currentSession().sources.some((source) => source.kind === "file" && source.itemID === attachment.id), "new question in reused Manager")
      const opened = findManagers()
      assert(opened.length === 1 && opened[0] === manager, "Reader entry created another Manager")
      assert(currentSession().messages.length === 0 && messages().length === messageCountBeforeControls,
        "Reader question sent an implicit message or altered prior conversation messages")
    }
    manager.restore()
    await waitFor(() => manager.windowState === manager.STATE_NORMAL, "normal Manager window", 8_000)
    manager.minimize()
    await waitFor(() => manager.windowState === manager.STATE_MINIMIZED, "minimized normal Manager", 8_000)
    await reopenManager(manager.STATE_NORMAL)
    manager.maximize()
    await waitFor(() => manager.windowState === manager.STATE_MAXIMIZED, "maximized Manager", 8_000)
    await reopenManager(manager.STATE_MAXIMIZED)
    manager.minimize()
    await waitFor(() => manager.windowState === manager.STATE_MINIMIZED, "minimized maximized Manager", 8_000)
    await reopenManager(manager.STATE_MAXIMIZED)
    manager.restore()
    await waitFor(() => manager.windowState === manager.STATE_NORMAL, "restored Manager", 8_000)
    assert(localState().sessions.some((session) => session.id === sessionBeforeControls) && messages().length === messageCountBeforeControls,
      "Window controls lost the previous conversation")
    // 独立解析不覆盖旧会话草稿；回到解析前的资源会话，继续验证普通 Markdown 对话。
    for (const sessionId of [pickerSessionId]) {
      const button = Array.from(manager.document.querySelectorAll(".jdx-chat-session-button"))
        .find((candidate) => candidate.dataset.sessionId === sessionId)
      assert(button, "Previous local conversation disappeared from the session list")
      button.click()
      await waitFor(() => currentSession().id === sessionId, "previous local conversation")
      const restoredDraft = manager.document.getElementById("jadense-chat-input").value
      assert(restoredDraft.startsWith(retainedDraft) && restoredDraft.includes("引用原文"),
        "Reader actions discarded the previous draft or its explicitly appended quote")
    }
    report.checks.push("native-manager-minimize-maximize-restore", "manager-entry-restores-normal-and-maximized", "manager-window-reused-with-new-question-session", "reader-actions-preserve-prior-draft")

    await stage("manager-byok-direct-chat")
    manager.document.getElementById("jadense-manager-nav-settings").click()
    await waitFor(() => !manager.document.getElementById("jadense-manager-section-settings").hidden, "Manager settings section")
    manager.document.getElementById("jadense-settings-tab-ai").click()
    const featureTab = manager.document.getElementById("jadense-settings-tab-features")
    assert(Array.from(manager.document.querySelectorAll('#jadense-settings-tabs [role="tab"]')).map(tab => tab.textContent.trim()).join(" / ") === "常规 / 功能配置 / 快捷键设置 / BYOK", "Feature settings tab labels/order changed")
    assert(!manager.document.getElementById("jadense-manager-route-byok"), "Obsolete global channel is still visible")
    const byokBaseUrl = manager.document.getElementById("jadense-manager-byok-base-url")
    const byokKey = manager.document.getElementById("jadense-manager-byok-key-input")
    const byokModel = manager.document.getElementById("jadense-manager-byok-model")
    const byokMaxTokens = manager.document.getElementById("jadense-manager-byok-max-output-tokens")
    byokBaseUrl.value = config.origin + "/v1"
    byokBaseUrl.dispatchEvent(new manager.Event("input", Components.utils.cloneInto({ bubbles: true }, manager)))
    byokKey.value = config.token
    manager.document.getElementById("jadense-manager-byok-provider-name").value = "Synthetic Provider"
    manager.document.getElementById("jadense-manager-byok-provider-save").click()
    await waitFor(() => manager.document.getElementById("jadense-manager-byok-status").dataset.kind === "success", "BYOK provider save")
    manager.document.getElementById("jadense-manager-byok-model-name").value = "Synthetic Model"
    byokModel.value = "synthetic-byok-model"
    byokMaxTokens.value = "96000"
    manager.document.getElementById("jadense-manager-byok-save").click()
    await waitFor(() => manager.document.getElementById("jadense-manager-byok-status").dataset.kind === "success", "BYOK form save")
    const settingsSections = Array.from(manager.document.querySelectorAll("[data-settings-section]"))
    assert(settingsSections.length === 1 && settingsSections[0].dataset.settingsSection === "byok",
      "Manager BYOK settings lost the provider catalog")
    const settingsGear = manager.document.querySelector("#jadense-manager-nav-settings svg.jdx-manager-settings-gear")
    assert(settingsGear?.querySelector("path") && settingsGear.querySelector("circle")
      && settingsGear.getBoundingClientRect().width > 0, "Manager settings navigation is missing the visible gear icon")
    const settingsScroller = manager.document.getElementById("jadense-manager-section-settings")
    const byokRect = settingsSections[0].getBoundingClientRect()
    const settingsContentRight = settingsScroller.getBoundingClientRect().left + settingsScroller.clientWidth
    assert(settingsContentRight - byokRect.right >= 8, "Manager settings scrollbar overlaps the BYOK section")
    let themeToggle = manager.document.getElementById("jadense-manager-theme-toggle")
    if (themeToggle.getAttribute("aria-pressed") === "true") themeToggle.click()
    await screenshot("manager-settings-light", manager)
    themeToggle.click()
    await screenshot("manager-settings-dark", manager)
    themeToggle.click()
    manager.document.getElementById("jadense-settings-tab-shortcuts").click()
    await screenshot("manager-shortcut-settings-light", manager)
    themeToggle.click()
    await screenshot("manager-shortcut-settings-dark", manager)
    themeToggle.click()
    manager.document.getElementById("jadense-settings-tab-ai").click()
    featureTab.click()
    for (const feature of ["chat", "translation", "analysis", "figure"]) {
      const control = manager.document.getElementById(`jadense-feature-${feature}-model`)
      control.querySelector(".jdx-select-trigger").click()
      const options = Array.from(control.querySelectorAll('[role="option"]'))
      assert(options.some(option => option.textContent.includes("Synthetic Model")) && options.some(option => option.textContent.includes("Synthetic Research")), "Feature selector must offer both model sources: " + feature)
      control.querySelector(".jdx-select-trigger").click()
    }
    await screenshot("manager-feature-models-light", manager)
    themeToggle.click()
    await screenshot("manager-feature-models-dark", manager)
    themeToggle.click()
    manager.document.getElementById("jadense-settings-tab-ai").click()
    const settingsChromeWidth = manager.outerWidth - manager.innerWidth
    const settingsChromeHeight = manager.outerHeight - manager.innerHeight
    manager.resizeTo(760 + settingsChromeWidth, 620 + settingsChromeHeight)
    await waitFor(() => manager.innerWidth === 760 && manager.innerHeight === 620, "compact Manager settings viewport")
    await Zotero.Promise.delay(250)
    const compactSettingsRect = settingsSections[0].getBoundingClientRect()
    assert(compactSettingsRect.width <= settingsScroller.clientWidth, "Compact Manager BYOK settings overflowed")
    await screenshot("manager-settings-compact", manager)
    featureTab.click()
    assert(manager.document.documentElement.scrollWidth <= manager.innerWidth + 2, "Compact feature settings widened the document")
    await screenshot("manager-feature-models-compact", manager)
    manager.document.getElementById("jadense-settings-tab-shortcuts").click()
    const shortcutPanelBounds = manager.document.getElementById("jadense-settings-panel-shortcuts").getBoundingClientRect()
    assert(shortcutPanelBounds.width <= settingsScroller.clientWidth
      && manager.document.documentElement.scrollWidth <= manager.innerWidth + 2, "Compact shortcut settings widened the Manager document")
    await screenshot("manager-shortcut-settings-compact", manager)
    manager.document.getElementById("jadense-settings-tab-ai").click()
    manager.resizeTo(1360 + settingsChromeWidth, 860 + settingsChromeHeight)
    await waitFor(() => manager.innerWidth === 1360 && manager.innerHeight === 860, "restored Manager settings viewport")

    await stage("native-preferences-byok-layout")
    await Promise.resolve(Zotero.Utilities.Internal.openPreferences("jadense-in-zotero-preferences"))
    const preferencesWindow = await waitFor(() => findWindowContaining("jadense-in-zotero-preferences-pane"), "native Jadense Preferences")
    await waitFor(() => preferencesWindow.document.getElementById("jadense-in-zotero-byok-save"), "native BYOK Preferences controls")
    const preferenceSections = Array.from(preferencesWindow.document.querySelectorAll("[data-settings-section]"))
    await waitFor(() => preferencesWindow.getComputedStyle(preferenceSections[0]).display === "grid", "native Preferences stylesheet")
    assert(preferenceSections.length === 4
      && preferenceSections[1].getBoundingClientRect().top > preferenceSections[0].getBoundingClientRect().bottom,
    "Native Preferences lost feature, connection, or BYOK sections")
    assert(preferencesWindow.document.getElementById("jadense-in-zotero-byok-endpoint").textContent.endsWith("/chat/completions"),
      "Native Preferences did not share the saved BYOK endpoint")
    assert(preferencesWindow.document.getElementById("jadense-in-zotero-token-edit-row").hidden
      && preferencesWindow.document.querySelector(".jdx-pref-checkbox span").textContent.trim(),
    "Native Preferences did not preserve hidden edit state or option copy")
    await screenshot("native-preferences-jadense", preferencesWindow)
    preferenceSections[3].scrollIntoView({ block: "start" })
    await Zotero.Promise.delay(150)
    await screenshot("native-preferences-byok", preferencesWindow)
    const savedByokBeforeTest = Zotero.Prefs.get("extensions.jadenseInZotero.byokConfig")
    const messagesBeforeByokTest = messages().length
    preferencesWindow.document.getElementById("jadense-in-zotero-byok-model").value = "synthetic-unsaved-test-model"
    preferencesWindow.document.getElementById("jadense-in-zotero-byok-test").click()
    await waitFor(() => preferencesWindow.document.getElementById("jadense-in-zotero-byok-status").dataset.kind === "success", "native BYOK test request")
    assert(Zotero.Prefs.get("extensions.jadenseInZotero.byokConfig") === savedByokBeforeTest && messages().length === messagesBeforeByokTest,
      "BYOK test saved its form or changed Chat history")
    preferencesWindow.close()
    manager.focus()
    const connectionNav = manager.document.getElementById("jadense-manager-nav-migrate")
    connectionNav.click()
    await waitFor(() => !manager.document.getElementById("jadense-manager-section-migrate").hidden, "Manager connection section")
    const connectionTab = (name) => manager.document.getElementById(`jadense-connection-tab-${name}`)
    const connectionPanel = (name) => manager.document.getElementById(`jadense-connection-panel-${name}`)
    assert(connectionNav.textContent.includes("连接攻玉")
      && ["config", "account", "sync"].every((name) => connectionTab(name) && connectionPanel(name))
      && !connectionPanel("config").hidden
      && connectionPanel("account").hidden
      && connectionPanel("sync").hidden
      && !manager.document.getElementById("jadense-manager-migrate-folder-select")
      && !manager.document.getElementById("jadense-manager-migrate-include-pdf"),
    "Manager connection page did not group connection, account, and sync controls into tabs")
    connectionTab("account").click()
    await waitFor(() => !connectionPanel("account").hidden, "Manager connection account tab")
    await waitFor(() => manager.document.getElementById("jadense-manager-account-name").textContent === "研究烟测用户"
      && manager.document.getElementById("jadense-manager-account-balance").textContent === "36 积分"
      && !manager.document.getElementById("jadense-manager-account-check-in"),
    "Manager account and points projection")
    assert(connectionPanel("account").querySelector('[data-connection-section="account"] h3').textContent === "你的攻玉"
      && !connectionPanel("account").querySelector('[data-connection-section="points"]'), "Account cards were not merged")
    const originalLaunchURL = Zotero.launchURL
    const accountUrls = []
    try {
      Zotero.launchURL = (url) => accountUrls.push(url)
      for (const id of ["jadense-manager-open-jadense", "jadense-manager-open-check-in", "jadense-manager-open-billing"]) manager.document.getElementById(id).click()
    } finally { Zotero.launchURL = originalLaunchURL }
    assert(JSON.stringify(accountUrls) === JSON.stringify([config.origin + "/", config.origin + "/app/check-in", config.origin + "/app?settings=billing"]), "Account web actions have incorrect destinations")
    manager.document.getElementById("jadense-manager-account-refresh").click()
    await waitFor(() => !manager.document.getElementById("jadense-manager-account-refresh").disabled, "Account refresh without direct check-in")
    report.checks.push("feature-models-both-sources", "feature-models-light-dark-compact", "manager-ai-settings-byok", "manager-settings-gear-icon", "manager-settings-light-dark", "shortcut-settings-light-dark-compact", "manager-connection-workbench", "manager-account-points-web-actions", "native-preferences-shared-byok", "byok-test-unsaved-3000-token-no-history")

    await stage("manager-synthetic-literature-upload")
    const mainPane = Zotero.getMainWindow().ZoteroPane
    await mainPane.selectItem(parent.id)
    await mainPane.itemsView.expandToItem(otherPaper.id)
    const otherPaperRow = mainPane.itemsView.getRowIndexByID(otherPaper.id)
    assert(typeof otherPaperRow === "number", "Native library could not reveal the synthetic paper without PDF")
    mainPane.itemsView.selection.toggleSelect(otherPaperRow)
    await waitFor(() => mainPane.getSelectedItems().length === 2, "two selected synthetic upload papers")
    connectionTab("sync").click()
    manager.document.getElementById("jadense-manager-migrate-load-folders").click()
    const uploadButton = manager.document.getElementById("jadense-manager-export-items")
    const uploadStatus = manager.document.getElementById("jadense-manager-migration-status")
    const includePdf = manager.document.getElementById("jadense-manager-include-pdf")
    await waitFor(() => Zotero.Prefs.get("extensions.jadenseInZotero.defaultFolderId") === config.uploadFolderId
      && !manager.document.getElementById("jadense-manager-migrate-load-folders").disabled && !uploadButton.disabled,
    "synthetic target folder and upload controls")
    includePdf.checked = true
    includePdf.dispatchEvent(new manager.Event("change", Components.utils.cloneInto({ bubbles: true }, manager)))
    uploadButton.click()
    await waitFor(() => !uploadButton.disabled && uploadStatus.dataset.kind === "success", "metadata and PDF upload result")
    const uploaded = JSON.parse(uploadStatus.textContent)
    assert(uploaded.importedCount === 2 && uploaded.failedCount === 0
      && uploaded.pdfUploadedCount === 1 && uploaded.pdfSkippedCount === 1 && uploaded.pdfFailedCount === 0
      && uploaded.items.some((item) => item.title === parent.getField("title") && item.metadataStatus === "imported" && item.pdf.status === "uploaded")
      && uploaded.items.some((item) => item.title === otherPaper.getField("title") && item.metadataStatus === "imported" && item.pdf.status === "skipped"),
    "Missing PDF blocked metadata or changed the independent per-paper upload outcomes")
    await mainPane.selectItem(parent.id)
    includePdf.checked = false
    includePdf.dispatchEvent(new manager.Event("change", Components.utils.cloneInto({ bubbles: true }, manager)))
    uploadButton.click()
    await waitFor(() => !uploadButton.disabled && uploadStatus.dataset.kind === "success", "metadata-only upload result")
    const metadataOnly = JSON.parse(uploadStatus.textContent)
    assert(metadataOnly.importedCount === 1 && metadataOnly.pdfUploadedCount === 0 && metadataOnly.pdfFailedCount === 0
      && metadataOnly.items[0]?.pdf.status === "not_requested", "Disabling PDF upload did not preserve metadata-only behavior")
    report.checks.push("manager-metadata-upload", "native-pdf-multipart-upload", "missing-pdf-metadata-isolation", "metadata-only-no-pdf-request")

    await stage("independent-byok-analysis")
    const savedByokSettings = JSON.parse(Zotero.Prefs.get("extensions.jadenseInZotero.byokConfig"))
    const selectedAnalysisModel = savedByokSettings.models.find((model) => model.model === "synthetic-byok-model")
    assert(selectedAnalysisModel, "Saved BYOK model is unavailable to independent analysis")
    const globalRouteBeforeAnalysis = Zotero.Prefs.get("extensions.jadenseInZotero.aiRoute")
    const globalByokBeforeAnalysis = Zotero.Prefs.get("extensions.jadenseInZotero.byokConfig")
    const chatBeforeByokAnalysis = JSON.stringify(localState())
    const historyBeforeByokAnalysis = analysisState().records.length
    Zotero.Prefs.set("extensions.jadenseInZotero.paperAnalysisModel", JSON.stringify({ route: "byok", modelId: "deleted-smoke-model" }))
    manager.document.getElementById("jadense-manager-nav-analysis").click()
    if (config.screenshots) {
      const savedAnalysisHistory = Zotero.Prefs.get("extensions.jadenseInZotero.paperAnalysisHistory")
      Zotero.Prefs.clear("extensions.jadenseInZotero.paperAnalysisHistory")
      // 空状态使用真实刷新入口；这里只验证展示，不应触发 chrome unload 清理已注册的 Reader 窗口上下文。
      manager.document.getElementById("jadense-analysis-history-refresh").click()
      await waitFor(() => !manager.document.getElementById("jadense-manager-section-analysis").hidden
        && manager.document.querySelector("#jadense-analysis-history .jdx-analysis-empty"), "fresh empty analysis history")
      await screenshot("manager-analysis-history-empty", manager)
      Zotero.Prefs.set("extensions.jadenseInZotero.paperAnalysisHistory", savedAnalysisHistory)
      manager.document.getElementById("jadense-analysis-history-refresh").click()
      await waitFor(() => manager.document.querySelectorAll("#jadense-analysis-history .jdx-analysis-record").length === historyBeforeByokAnalysis,
        "restored analysis history after empty-state visual")
    }
    manager.document.getElementById("jadense-analysis-tab-config").click()
    await waitFor(() => manager.document.getElementById("jadense-analysis-model-status").dataset.kind === "error", "stale analysis model error")
    assert(manager.document.getElementById("jadense-analysis-model-status").textContent.includes("已删除或配置不完整"), "Stale analysis model did not fail closed")
    await screenshot("manager-analysis-config-error", manager)
    toolbarButton("analyze").click()
    await waitFor(() => manager.document.getElementById("jadense-analysis-status").dataset.kind === "error", "stale BYOK analysis rejection")
    assert(analysisState().records.length === historyBeforeByokAnalysis && JSON.stringify(localState()) === chatBeforeByokAnalysis,
      "Stale BYOK analysis wrote history or Chat")

    manager.document.getElementById("jadense-analysis-tab-config").click()
    const analysisModelSelect = manager.document.getElementById("jadense-analysis-model-select")
    analysisModelSelect.querySelector(".jdx-select-trigger").click()
    const analysisModelOption = Array.from(analysisModelSelect.querySelectorAll('[role="option"]'))
      .find((option) => option.textContent.includes("Synthetic Model") && option.textContent.includes("Synthetic Provider"))
    assert(analysisModelOption, "Analysis configuration does not list the saved Provider / model")
    analysisModelOption.click()
    await waitFor(() => JSON.parse(Zotero.Prefs.get("extensions.jadenseInZotero.paperAnalysisModel")).modelId === selectedAnalysisModel.id
      && manager.document.getElementById("jadense-analysis-model-status").dataset.kind === "success", "independent analysis model selection")
    assert(Zotero.Prefs.get("extensions.jadenseInZotero.aiRoute") === globalRouteBeforeAnalysis
      && Zotero.Prefs.get("extensions.jadenseInZotero.byokConfig") === globalByokBeforeAnalysis,
    "Independent analysis model selection changed Chat route or active BYOK settings")
    await screenshot("manager-analysis-config-light", manager)
    themeToggle.click()
    await screenshot("manager-analysis-config-dark", manager)
    themeToggle.click()
    manager.document.getElementById("jadense-analysis-tab-history").click()
    await screenshot("manager-analysis-history-light", manager)
    themeToggle.click()
    await screenshot("manager-analysis-history-dark", manager)
    themeToggle.click()
    manager.resizeTo(760 + settingsChromeWidth, 620 + settingsChromeHeight)
    await waitFor(() => manager.innerWidth === 760 && manager.innerHeight === 620, "compact analysis viewport")
    await screenshot("manager-analysis-history-compact", manager)
    manager.document.getElementById("jadense-analysis-tab-config").click()
    await screenshot("manager-analysis-config-compact", manager)
    manager.resizeTo(1360 + settingsChromeWidth, 860 + settingsChromeHeight)
    await waitFor(() => manager.innerWidth === 1360 && manager.innerHeight === 860, "restored analysis viewport")
    manager.document.getElementById("jadense-analysis-tab-history").click()
    toolbarButton("analyze").click()
    await waitFor(() => analysisState().records?.length === historyBeforeByokAnalysis + 1 && managerIdle(), "selected BYOK analysis completion")
    assert(JSON.stringify(localState()) === chatBeforeByokAnalysis
      && Zotero.Prefs.get("extensions.jadenseInZotero.aiRoute") === globalRouteBeforeAnalysis
      && Zotero.Prefs.get("extensions.jadenseInZotero.byokConfig") === globalByokBeforeAnalysis,
    "BYOK analysis changed Chat history, global route, or active BYOK model")
    annotations = attachment.getAnnotations()
    assert(JSON.stringify(annotations.map((annotation) => annotation.key).sort()) === JSON.stringify(annotationKeys), "BYOK analysis duplicated existing native annotations")
    report.checks.push("analysis-stale-byok-zero-request", "analysis-model-independent-save", "analysis-specific-byok", "analysis-config-history-light-dark-compact")

    manager.document.getElementById("jadense-manager-nav-settings").click()
    manager.document.getElementById("jadense-settings-tab-features").click()
    const featureChatSelect = manager.document.getElementById("jadense-feature-chat-model")
    featureChatSelect.querySelector(".jdx-select-trigger").click()
    Array.from(featureChatSelect.querySelectorAll('[role="option"]')).find(option => option.textContent.includes("Synthetic Model")).click()
    assert(JSON.parse(Zotero.Prefs.get("extensions.jadenseInZotero.chatModel")).modelId === selectedAnalysisModel.id, "Feature model control did not persist BYOK")
    manager.document.getElementById("jadense-manager-nav-chat").click()
    manager.document.getElementById("jadense-chat-new-session").click()
    const byokInput = manager.document.getElementById("jadense-chat-input")
    byokInput.value = config.byokMarker
    byokInput.dispatchEvent(new manager.Event("input", Components.utils.cloneInto({ bubbles: true }, manager)))
    await waitFor(() => !manager.document.getElementById("jadense-chat-send").disabled, "BYOK Send button")
    manager.document.getElementById("jadense-chat-send").click()
    await waitFor(() => completed().some((message) => message.text === config.byokMarker), "direct BYOK response")
    manager.document.getElementById("jadense-manager-nav-settings").click()
    manager.document.getElementById("jadense-settings-tab-features").click()
    featureChatSelect.querySelector(".jdx-select-trigger").click()
    Array.from(featureChatSelect.querySelectorAll('[role="option"]')).find(option => option.textContent.includes("DeepSeek V4 Flash Vision Exp")).click()
    manager.document.getElementById("jadense-manager-nav-chat").click()
    const researchSessionButton = Array.from(manager.document.querySelectorAll(".jdx-chat-session-button"))
      .find((candidate) => candidate.dataset.sessionId === sessionBeforeControls)
    assert(researchSessionButton, "BYOK route test lost the research conversation")
    researchSessionButton.click()
    await waitFor(() => currentSession().id === sessionBeforeControls, "research conversation after BYOK")
    report.checks.push("manager-byok-real-controls", "byok-direct-chat-completions")

    await stage("ordinary-markdown-chat")
    const chatModelSelect = manager.document.getElementById("jadense-chat-model-select")
    await waitFor(() => chatModelSelect?.dataset.status === "ready", "Jadense model catalog")
    const chatModelTrigger = chatModelSelect.querySelector(".jdx-select-trigger")
    assert(chatModelTrigger.textContent.includes("DeepSeek V4 Flash Vision Exp") && !chatModelTrigger.disabled,
      "Chat model selector did not select DeepSeek V4 Flash Vision Exp")
    chatModelTrigger.click()
    const chatModelSearch = chatModelSelect.querySelector(".jdx-select-search")
    assert(chatModelSearch && chatModelSelect.querySelectorAll(".jdx-select-group").length === 3,
      "Chat model selector lost search or Webapp-style grouping")
    assert(!chatModelSelect.textContent.includes("跟随攻玉设置"), "Removed account-default option is still visible")
    const lockedChatModel = Array.from(chatModelSelect.querySelectorAll('[role="option"]'))
      .find((option) => option.textContent.includes("受限模型"))
    assert(lockedChatModel?.getAttribute("aria-disabled") === "true"
      && lockedChatModel.textContent.includes("需升级") && lockedChatModel.textContent.includes("需 MAX")
      && lockedChatModel.textContent.includes("升级后可直接选择"), "Locked model lost its subscription tier or recovery reason")
    lockedChatModel.click()
    assert(JSON.parse(Zotero.Prefs.get("extensions.jadenseInZotero.chatModel")).selection?.modelId === "deepseek-v4-flash-vision-exp",
      "Clicking a subscription-locked model changed the saved selection")
    await screenshot("manager-model-subscription", manager)
    report.checks.push("jadense-model-subscription-lock")
    chatModelSearch.value = "Synthetic"
    chatModelSearch.dispatchEvent(new manager.Event("input", Components.utils.cloneInto({ bubbles: true }, manager)))
    const chatModelOption = Array.from(chatModelSelect.querySelectorAll('[role="option"]'))
      .find((option) => option.textContent.includes("Synthetic Research"))
    assert(chatModelOption && chatModelOption.textContent.includes("图片") && chatModelOption.textContent.includes("1.25x"),
      `Chat model search lost capabilities or consumption metadata: ${chatModelOption?.textContent ?? "missing option"}`)
    chatModelOption.click()
    await waitFor(() => JSON.parse(Zotero.Prefs.get("extensions.jadenseInZotero.chatModel")).selection?.modelId === "synthetic-platform-model",
      "persisted Jadense Chat model")
    report.checks.push("jadense-chat-model-catalog", "jadense-chat-model-search", "jadense-chat-model-selection")
    const input = manager.document.getElementById("jadense-chat-input")
    input.value = config.markdown.user
    input.dispatchEvent(new manager.Event("input", Components.utils.cloneInto({ bubbles: true }, manager)))
    await waitFor(() => !manager.document.getElementById("jadense-chat-send").disabled, "Markdown Send button")
    manager.document.getElementById("jadense-chat-send").click()
    const streaming = await waitFor(() => {
      const node = manager.document.querySelector('.jdx-chat-message[data-role="assistant"][data-status="streaming"]')
      return node?.querySelector("h2") && node.querySelector("strong") && node.querySelector("pre > code") ? node : null
    }, "rendered Markdown before stream completion")
    assert(streaming.dataset.status === "streaming", "Markdown rendered only after generation finished")
    const generatingTheme = manager.document.documentElement.dataset.theme
    manager.document.getElementById("jadense-manager-theme-toggle").click()
    assert(manager.document.documentElement.dataset.theme !== generatingTheme
      && streaming.dataset.status === "streaming", "Theme change interrupted active generation")
    manager.document.getElementById("jadense-manager-theme-toggle").click()
    report.checks.push("theme-change-preserves-active-stream")
    const detailsStop = manager.document.getElementById("jadense-chat-details-stop")
    assert(detailsStop && !detailsStop.hidden && !detailsStop.disabled, "Busy conversation details do not expose Stop")
    const prefix = "稳定前缀"
    const stableParagraph = Array.from(streaming.querySelectorAll("p")).find((paragraph) => paragraph.textContent.startsWith(prefix))
    assert(stableParagraph?.firstChild?.nodeType === 3, "Streaming fixture has no stable text prefix")
    const prefixRange = manager.document.createRange()
    prefixRange.setStart(stableParagraph.firstChild, 0)
    prefixRange.setEnd(stableParagraph.firstChild, prefix.length)
    const selection = manager.getSelection()
    selection.removeAllRanges()
    selection.addRange(prefixRange)
    report.checks.push("streaming-markdown-rendered", "conversation-details-stop-visible-while-busy")
    await waitFor(() => completed().some((message) => message.text === config.markdown.assistant)
      && manager.document.getElementById("jadense-chat-stop").hidden, "ordinary Markdown completion")
    assert(prefixRange.toString() === prefix && selection.toString() === prefix, "Completing Markdown emphasis cleared the selected stable prefix")
    selection.removeAllRanges()
    report.checks.push("streaming-markdown-prefix-selection-preserved")
    const markdownNode = (role) => {
      const saved = messages().find((message) => message.role === role && message.text === config.markdown[role])
      return Array.from(manager.document.querySelectorAll(".jdx-chat-message")).find((node) => node.dataset.messageId === saved?.id)
    }
    const verifyMarkdown = () => {
      for (const role of ["user", "assistant"]) {
        const body = markdownNode(role)?.querySelector(".jdx-chat-message-body")
        assert(body, "Missing rendered " + role + " Markdown")
        for (const selector of ["h2", "strong", "em", "blockquote", "ul > li", "ul > li > p", "ol > li", "pre > code", "table thead", "table tbody", "a[href]"]) {
          assert(body.querySelector(selector), role + " Markdown is missing " + selector)
        }
        const terminology = body.querySelector("ol")
        assert(terminology.children.length === 5 && terminology.getBoundingClientRect().height > 0,
          role + " terminology list is incomplete or hidden")
        const lists = Array.from(body.querySelectorAll("ul, ol"))
        const listGaps = lists.flatMap((list) => Array.from(list.children).slice(1).map((item) =>
          item.getBoundingClientRect().top - item.previousElementSibling.getBoundingClientRect().bottom))
        const headingGap = terminology.getBoundingClientRect().top - terminology.previousElementSibling.getBoundingClientRect().bottom
        const spacing = { whiteSpace: manager.getComputedStyle(body).whiteSpace, maxListGap: Math.max(...listGaps), headingGap }
        ;(report.markdownSpacing ??= {})[role] = spacing
        assert(spacing.whiteSpace === "normal", role + " Markdown kept legacy whitespace: " + spacing.whiteSpace)
        assert(spacing.maxListGap <= 8 && headingGap <= 12, role + " Markdown has extra blank lines: " + JSON.stringify(spacing))
        assert(body.querySelector("pre > code").textContent.includes("const evidence"), role + " fenced code lost its source")
        assert(body.querySelector("table").textContent.includes("方法核验"), role + " Markdown table lost its cells")
        assert(!body.querySelector("img, script, iframe, object, embed, link, style, [onerror], [onclick]"), role + " Markdown injected active content")
        assert(body.textContent.includes("<script>") && body.textContent.includes("<img src="), role + " raw HTML was not preserved as literal text")
        const links = Array.from(body.querySelectorAll("a[href]"))
        assert(links.every((link) => /^(https?:\/\/|mailto:)/i.test(link.getAttribute("href"))), role + " Markdown exposed a privileged or executable link")
        assert(links.some((link) => link.getAttribute("href") === config.origin + "/markdown-image-" + role + ".png"), role + " Markdown image is not a click-only link")
        assert(messages().some((message) => message.role === role && message.text === config.markdown[role]), role + " stored message no longer contains original Markdown")
      }
      assert(manager.__jadenseSmokeMarkupExecuted !== true && manager.wrappedJSObject?.__jadenseSmokeMarkupExecuted !== true, "Raw Markdown HTML executed in Manager")
      assert(!manager.document.querySelector('article[data-research="true"]')
        && analysisState().records?.length >= 3
        && manager.document.querySelectorAll("#jadense-analysis-history .jdx-analysis-record").length >= 3,
      "Ordinary Chat leaked analysis cards or displaced independent analysis history")
    }
    verifyMarkdown()
    report.checks.push("user-and-assistant-markdown", "markdown-lists-code-tables-links", "markdown-literal-html-and-safe-links", "markdown-original-source-preserved", "markdown-paragraph-and-list-spacing")

    await stage("markdown-history-reload")
    const documentBeforeReload = manager.document
    manager.location.reload()
    await waitFor(() => manager.document !== documentBeforeReload && markdownNode("assistant")?.querySelector("table"), "Markdown history after Manager reload")
    manager.document.getElementById("jadense-manager-nav-chat").click()
    await waitFor(() => !manager.document.getElementById("jadense-manager-section-chat").hidden, "Chat after Manager reload")
    verifyMarkdown()
    report.checks.push("markdown-history-reload", "independent-analysis-history-preserved-after-chat-reload")

    if (config.screenshots) {
      await stage("reader-visual-states")
      const mainWindow = Zotero.getMainWindow()
      const previousSize = [mainWindow.outerWidth, mainWindow.outerHeight]
      const previousScheme = reader._internalReader._state.colorScheme
      // 原生窗口的 resize 异步到达 reader；不能用固定短延迟把同一尺寸误报成宽窄两种。
      const resizeReader = async (width, height, compact) => {
        mainWindow.resizeTo(width, height)
        await waitFor(() => {
          const viewportWidth = reader._iframeWindow.innerWidth
          return compact ? viewportWidth <= 1100 : viewportWidth > 1100
        }, compact ? "compact reader viewport" : "wide reader viewport", 8_000)
        await Zotero.Promise.delay(300)
      }
      report.readerWindow = { outerWidth: mainWindow.outerWidth, outerHeight: mainWindow.outerHeight, screenWidth: mainWindow.screen.availWidth, screenHeight: mainWindow.screen.availHeight, windowState: mainWindow.windowState }
      view._setSelectionRanges()
      await Zotero.Reader.open(attachment.id)
      try {
        if (typeof mainWindow.restore === "function") mainWindow.restore()
        await Zotero.Promise.delay(500)
        await resizeReader(1420, 900, false)
        reader.setColorScheme("light")
        await Zotero.Promise.delay(200)
        await screenshot("reader-toolbar-light")
        reader.setColorScheme("dark")
        await Zotero.Promise.delay(200)
        await screenshot("reader-toolbar-dark")
        await resizeReader(900, 700, true)
        reader.setColorScheme("light")
        await Zotero.Promise.delay(200)
        toolbarButton("quote").click()
        await screenshot("reader-toolbar-compact-hint")
        const languageToggle = readerDoc.querySelector('button[aria-label="文章翻译语言设置"]')
        assert(languageToggle?.getBoundingClientRect().width > 0, "Compact Reader lacks a permanent article language settings button")
        toggleArticleLanguages(true)
        assert(languageToggle.getAttribute("aria-expanded") === "true", "Compact article language button did not open its settings")
        const compactLanguageBounds = articleLanguages.getBoundingClientRect()
        report.compactArticleLanguageBounds = {
          viewportWidth: reader._iframeWindow.innerWidth,
          left: compactLanguageBounds.left, right: compactLanguageBounds.right, width: compactLanguageBounds.width,
        }
        await screenshot("reader-article-languages-compact")
        assert(compactLanguageBounds.width > 0 && compactLanguageBounds.left >= 0
          && compactLanguageBounds.right <= reader._iframeWindow.innerWidth + 1,
        "Compact Reader placed article language controls outside its viewport")
        for (const select of [articleSourceLanguage, articleTargetLanguage]) {
          const bounds = select.getBoundingClientRect()
          const hit = readerDoc.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
          assert(hit === select || select.contains(hit), "Compact article language select is covered by another Reader layer: " + select.getAttribute("aria-label"))
        }
        reader.setColorScheme("dark")
        await Zotero.Promise.delay(200)
        report.compactArticleLanguageDarkColors = [articleLanguages, articleSourceLanguage, articleTargetLanguage].map((element) => {
          const style = reader._iframeWindow.getComputedStyle(element)
          return { label: element.getAttribute("aria-label"), color: style.color, background: style.backgroundColor }
        })
        await screenshot("reader-article-languages-compact-dark")
        toggleArticleLanguages(false)
        assert(languageToggle.getAttribute("aria-expanded") === "false", "Compact article language settings did not close")
        report.checks.push("article-language-compact-visible-unobscured")
      } finally {
        reader.setColorScheme(previousScheme)
        mainWindow.resizeTo(...previousSize)
      }
    }

    if (config.screenshots) {
      await stage("manager-markdown-visual-states")
      const previousSize = [manager.outerWidth, manager.outerHeight]
      const previousTheme = manager.document.documentElement.dataset.theme
      const resizeManager = async (width, height) => {
        const chromeWidth = manager.outerWidth - manager.innerWidth
        const chromeHeight = manager.outerHeight - manager.innerHeight
        manager.resizeTo(width + chromeWidth, height + chromeHeight)
        await waitFor(() => Math.abs(manager.innerWidth - width) <= 2 && Math.abs(manager.innerHeight - height) <= 2, "Manager viewport " + width + "x" + height, 8_000)
        // 后台 chrome 的动画时钟可能停在 0；烟测只完成既有过渡，核验最终 CSS，不改生产样式或尺寸。
        const shell = manager.document.getElementById("jadense-manager-shell")
        const sidebar = manager.document.getElementById("jadense-manager-sidebar")
        const sessions = manager.document.getElementById("jadense-chat-sessions")
        const details = manager.document.getElementById("jadense-chat-source-panel")
        let previousBounds
        await waitFor(() => {
          for (const animation of shell.getAnimations()) {
            if (animation.playState !== "running") continue
            animation.finish()
            ;(report.finishedCaptureTransitions ??= []).push({ width, property: animation.transitionProperty })
          }
          const expectedCollapsed = width <= 820
          const expectedSidebarWidth = expectedCollapsed ? 56 : 212
          const bounds = JSON.stringify([sidebar, sessions, details].map((panel) => {
            const rect = panel.getBoundingClientRect()
            return [rect.x, rect.y, rect.width, rect.height]
          }))
          const stable = bounds === previousBounds
          previousBounds = bounds
          report.managerLayoutProbe = {
            width, height, expectedSidebarWidth, sidebarWidth: sidebar.getBoundingClientRect().width,
            columns: manager.getComputedStyle(shell).gridTemplateColumns, bounds,
            collapsed: shell.dataset.sidebarCollapsed, active: Services.focus.activeWindow === manager,
            animations: shell.getAnimations().map((animation) => ({ playState: animation.playState, currentTime: animation.currentTime })),
          }
          return stable && shell.dataset.sidebarCollapsed === String(expectedCollapsed)
            && Math.abs(sidebar.getBoundingClientRect().width - expectedSidebarWidth) < 1
        }, "settled Manager navigation and panel bounds", 8_000)
        ;(report.managerLayouts ??= []).push({ width, height, sidebarWidth: sidebar.getBoundingClientRect().width, columns: manager.getComputedStyle(shell).gridTemplateColumns })
      }
      const theme = async (value) => {
        if (manager.document.documentElement.dataset.theme !== value) manager.document.getElementById("jadense-manager-theme-toggle").click()
        await waitFor(() => manager.document.documentElement.dataset.theme === value, "Manager " + value + " theme")
        await Zotero.Promise.delay(200)
      }
      const revealMessage = async (role) => {
        const log = manager.document.getElementById("jadense-chat-message-list")
        log.scrollTop += markdownNode(role).getBoundingClientRect().top - log.getBoundingClientRect().top - 8
        await Zotero.Promise.delay(100)
      }
      try {
        manager.focus()
        const detailsToggle = manager.document.getElementById("jadense-chat-details-toggle")
        if (detailsToggle.getAttribute("aria-expanded") === "true") detailsToggle.click()
        await resizeManager(1100, 760)
        await theme("light")
        await revealMessage("user")
        await screenshot("manager-markdown-user-light", manager)
        await revealMessage("assistant")
        await screenshot("manager-markdown-assistant-light", manager)
        await theme("dark")
        await screenshot("manager-markdown-assistant-dark", manager)
        await resizeManager(760, 620)
        await theme("light")
        await revealMessage("assistant")
        assert(manager.document.documentElement.scrollWidth <= manager.innerWidth + 2, "Compact Markdown widened the Manager document")
        for (const role of ["user", "assistant"]) {
          const body = markdownNode(role).querySelector(".jdx-chat-message-body")
          assert(body.scrollWidth <= body.clientWidth + 2, "Compact " + role + " Markdown code/table escaped its message")
        }
        await screenshot("manager-markdown-compact", manager)
        detailsToggle.click()
        const details = manager.document.getElementById("jadense-chat-source-panel")
        await waitFor(() => {
          const rect = details.getBoundingClientRect()
          const workbench = manager.document.getElementById("jadense-chat-workbench").getBoundingClientRect()
          return !details.hidden && rect.width >= 280 && rect.right <= workbench.right + 1 && rect.left >= workbench.left - 1
        }, "compact details overlay within the conversation", 8_000)
        await screenshot("manager-details-compact-open", manager)
        detailsToggle.click()
        report.checks.push("compact-details-open-width-and-bounds")
        report.checks.push("compact-markdown-scroll-contained")
      } finally {
        await theme(previousTheme)
        manager.resizeTo(...previousSize)
      }
    }

    await stage("reader-article-languages-reopen")
    // report 的 chars 等早期原生诊断对象也属于旧 Reader；在关闭前将它们固化为普通 JSON。
    Object.assign(report, JSON.parse(JSON.stringify(report)))
    // 关闭后的 PDFView 是 Gecko dead object；先释放诊断引用，避免掩盖重开阶段的原始错误。
    view = undefined
    reader.close()
    await waitFor(() => !Zotero.Reader._readers.includes(reader), "closed synthetic reader")
    await stage("reader-article-languages-reopening")
    reader = await Zotero.Reader.open(attachment.id)
    await reader._initPromise
    view = reader._internalReader._primaryView
    const reopenedLanguages = await waitFor(() => {
      const group = reader._iframeWindow.document.querySelector("[data-jadense-article-languages]")
      return group?.querySelector('select[aria-label="文章源语言"]')?.value === "fr"
        && group?.querySelector('select[aria-label="文章目标语言"]')?.value === "de" ? group : null
    }, "persisted article languages after reader reopen")
    assert(reopenedLanguages.closest('[data-jadense-reader-tools="renderToolbar"]'), "Article languages moved out of the permanent toolbar")
    await screenshot("reader-article-languages-reopened")
    report.checks.push("article-language-autosave", "article-language-inherited-by-next-selection", "article-language-reader-reopen")

    report.annotationCount = 2
    await stage("chat-image-upload-and-reload")
    manager.document.getElementById("jadense-manager-nav-chat").click()
    manager.document.getElementById("jadense-chat-new-session").click()
    const uploadSessionID = currentSession().id
    const uploadBlob = await manager.fetch(fixtureImageDataUrl).then(response => response.blob())
    const uploadFile = new manager.File(manager.Array.of(uploadBlob), "synthetic-upload.png", Components.utils.cloneInto({ type: "image/png" }, manager))
    const selectImage = (mode = "file") => {
      const transfer = new manager.DataTransfer()
      transfer.items.add(uploadFile)
      if (mode === "paste") {
        const event = new manager.ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true })
        // Gecko 的合成 ClipboardEvent 不接收文件列表；仅给 fixture 事件提供合成剪贴板，仍走真实 Manager listener。
        Object.defineProperty(event, "clipboardData", { value: transfer })
        assert(event.clipboardData?.files.length === 1, "Synthetic paste event lost its image FileList")
        manager.document.getElementById("jadense-chat-input").dispatchEvent(event)
        assert(event.defaultPrevented, "Image paste handler did not consume the synthetic clipboard event")
        return
      }
      if (mode === "drop") {
        const event = new manager.DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true })
        Object.defineProperty(event, "dataTransfer", { value: transfer })
        manager.document.getElementById("jadense-chat-workbench").dispatchEvent(event)
        return
      }
      const input = manager.document.getElementById("jadense-chat-image-input")
      input.files = transfer.files
      input.dispatchEvent(new manager.Event("change", Components.utils.cloneInto({ bubbles: true }, manager)))
    }
    selectImage()
    await waitFor(() => managerIdle() && manager.document.querySelector('#jadense-chat-image-preview img')?.naturalWidth > 0, "upload preview")
    manager.document.getElementById("jadense-chat-new-session").click()
    assert(manager.document.getElementById("jadense-chat-image-preview").hidden, "Image draft leaked into another conversation")
    manager.document.querySelector(`[data-session-id="${uploadSessionID}"]`).click()
    await waitFor(() => manager.document.querySelector('#jadense-chat-image-preview img')?.naturalWidth > 0, "image draft restored after session switch")
    manager.document.querySelector('#jadense-chat-image-preview button').click()
    assert(manager.document.getElementById("jadense-chat-image-preview").hidden && manager.document.getElementById("jadense-chat-send").disabled,
      "Removing an image draft did not restore empty composer state")
    selectImage("paste")
    await waitFor(() => managerIdle() && manager.document.querySelector('#jadense-chat-image-preview img')?.naturalWidth > 0, "pasted image preview")
    manager.document.querySelector('#jadense-chat-image-preview button').click()
    selectImage("drop")
    await waitFor(() => managerIdle() && !manager.document.getElementById("jadense-chat-send").disabled, "image-only send enabled")
    await screenshot("manager-image-upload-preview", manager)
    manager.document.getElementById("jadense-chat-send").click()
    await waitFor(() => managerIdle() && currentSession().messages.some(message => message.text === "SYNTHETIC_IMAGE_UPLOAD_VERIFIED"), "image-only response")
    const uploadedMessage = currentSession().messages.find(message => message.image)
    assert(uploadedMessage.image.origin === "upload", "Upload did not persist its own image reference")
    const oldImageDocument = manager.document
    manager.location.reload()
    await waitFor(() => manager.document !== oldImageDocument && manager.document.querySelector('.jdx-chat-message-image img')?.naturalWidth > 0, "uploaded image after reload")
    manager.document.getElementById("jadense-manager-nav-chat").click()
    assert(currentSession().id === uploadSessionID && !JSON.stringify(localState()).includes("data:image/"), "Image reload changed history or embedded image bytes")
    const imageButton = manager.document.querySelector('.jdx-chat-message-image button')
    imageButton.click()
    assert(imageButton.getAttribute("aria-expanded") === "true", "Message image could not be expanded")
    imageButton.click()
    const followup = manager.document.getElementById("jadense-chat-input")
    followup.value = "继续解读这张图片"
    followup.dispatchEvent(new manager.Event("input", Components.utils.cloneInto({ bubbles: true }, manager)))
    manager.document.getElementById("jadense-chat-send").click()
    await waitFor(() => managerIdle() && currentSession().messages.filter(message => message.text === "SYNTHETIC_IMAGE_UPLOAD_VERIFIED").length === 2, "reloaded image follow-up")
    await screenshot("manager-image-upload-history", manager)
    // 同一轮重开后读取原有两张阅读器图片，验证它们也使用持久化附件显示。
    manager.document.querySelector(`[data-session-id="${figureSessionId}"]`).click()
    await waitFor(() => Array.from(manager.document.querySelectorAll('.jdx-chat-message-image img')).filter(image => image.naturalWidth > 0).length === 2, "figure images after reload")
    await screenshot("manager-figure-image-history", manager)
    if (config.screenshots) {
      manager.resizeTo(760, 620)
      await waitFor(() => manager.innerWidth <= 780, "compact image conversation")
      for (const theme of ["light", "dark"]) {
        if (manager.document.documentElement.dataset.theme !== theme) manager.document.getElementById("jadense-manager-theme-toggle").click()
        assert(manager.document.documentElement.scrollWidth <= manager.innerWidth + 2, "Image history widened the compact Manager")
        const sendBounds = manager.document.getElementById("jadense-chat-send").getBoundingClientRect()
        assert(sendBounds.right <= manager.innerWidth && sendBounds.bottom <= manager.innerHeight, "Image composer hid Send in compact mode")
        await screenshot(`manager-image-history-compact-${theme}`, manager)
      }
    }
    // 只移除隔离 profile 内这个合成附件，确认缺图不会令整段历史消失。
    await IOUtils.remove(PathUtils.join(PathUtils.profileDir, "jadense-chat-images", `${firstFigureUser.image.id}.txt`))
    const beforeMissingImageReload = manager.document
    manager.location.reload()
    await waitFor(() => manager.document !== beforeMissingImageReload && manager.document.querySelector(`[data-message-id="${firstFigureUser.id}"] .jdx-chat-message-image`)?.textContent.includes("图片不可用"), "missing image local fallback")
    assert(currentSession().messages.length > 2, "Missing image removed readable conversation history")
    report.checks.push("chat-image-upload-preview-remove", "chat-image-draft-session-isolation", "chat-image-paste-drop", "chat-image-only-send", "chat-image-message-expand", "chat-image-history-reload", "chat-image-reloaded-followup", "figure-images-history-reload", "missing-image-history-fallback")
    report.assistantMessages = completed().length
    report.state = "passed"
    report.stage = "complete"
    await persist()
  } catch (error) {
    report.state = "failed"
    report.error = `${String(error)}\n${error?.stack || ""}`
    report.managerStatus = manager?.document?.getElementById("jadense-chat-status")?.textContent ?? ""
    report.analysisStatus = manager?.document?.getElementById("jadense-analysis-status")?.textContent ?? ""
    report.analysisUi = manager ? {
      sectionHidden: manager.document.getElementById("jadense-manager-section-analysis")?.hidden,
      stopHidden: manager.document.getElementById("jadense-analysis-stop")?.hidden,
      attachDisabled: manager.document.getElementById("jadense-chat-attach-items")?.disabled,
      statusBusy: manager.document.getElementById("jadense-analysis-status")?.dataset?.busy,
    } : null
    report.pdfPageData = Object.entries(view?._pdfPages ?? {}).map(([pageIndex, page]) => ({
      pageIndex: Number(pageIndex),
      chars: Array.isArray(page?.chars) ? page.chars.length : null,
    }))
    await persist()
  }
}

async function writeCompanion(extensionsDir, config) {
  const zip = new JSZip()
  zip.file("manifest.json", JSON.stringify({
    manifest_version: 2,
    name: "Jadense isolated research smoke companion",
    version: "1.0.0",
    applications: { zotero: {
      id: COMPANION_ID,
      // Zotero 的 manifest 校验要求 update_url；隔离 profile 已关闭自动更新。
      update_url: "https://example.invalid/research-smoke-updates.json",
      strict_min_version: "9.0",
      strict_max_version: "10.0.*",
    } },
  }))
  zip.file("bootstrap.js", [
    `const SMOKE_CONFIG = ${JSON.stringify(config)};`,
    runHarness.toString(),
    "function startup() { void runHarness(SMOKE_CONFIG).catch(error => Zotero.logError(error)); }",
    "function shutdown() {}",
    "function install() {}",
    "function uninstall() {}",
  ].join("\n"))
  await writeFile(path.join(extensionsDir, `${COMPANION_ID}.xpi`), await zip.generateAsync({ type: "nodebuffer" }))
}

/** 只终止命令行包含本次随机 profile 的 Zotero，绝不按进程名整体终止。 */
async function stopIsolatedProcess(child, profileDir) {
  if (process.platform === "win32") {
    const command = [
      "$taskProfile = $env:JADENSE_RESEARCH_SMOKE_PROFILE",
      "Get-CimInstance Win32_Process -Filter \"Name='zotero.exe'\" | Where-Object { $_.CommandLine -like ('*' + $taskProfile + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ].join("\n")
    const stopper = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      env: { ...process.env, JADENSE_RESEARCH_SMOKE_PROFILE: profileDir }, windowsHide: true, stdio: "ignore",
    })
    await new Promise((resolve, reject) => {
      stopper.once("error", reject)
      stopper.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Could not stop the isolated Zotero process")))
    })
  } else if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM")
  }
  await delay(500)
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

async function removeSmokeRoot(smokeRoot) {
  const resolvedRoot = await realpath(smokeRoot)
  const resolvedTemp = await realpath(tmpdir())
  if (path.dirname(resolvedRoot) !== resolvedTemp || !path.basename(resolvedRoot).startsWith("jadense-zotero-research-smoke-")) {
    throw new Error("Refused to remove a directory outside the isolated smoke root")
  }
  await rm(resolvedRoot, { recursive: true, force: true })
}

async function main() {
  const argv = process.argv.slice(2)
  const executable = argValue(argv, "--zotero") ?? (argv[0]?.startsWith("-") ? undefined : argv[0]) ?? process.env.ZOTERO_EXE
  if (!executable) throw new Error("Usage: node scripts/smoke-research.mjs <absolute-zotero-executable> [--xpi path] [--upgrade-from previous-xpi] [--keep-temp] [--screenshots]")
  const appearanceLanguage = argValue(argv, "--appearance-language")
  const timeoutMs = Number(argValue(argv, "--timeout-ms") ?? 150_000)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive")
  const { facts, version } = await loadReleaseContext()
  const pluginID = facts.manifest.applications.zotero.id
  const artifact = path.resolve(argValue(argv, "--xpi") ?? buildReleasePaths(facts, version).artifactPath)
  const upgradeFrom = argValue(argv, "--upgrade-from")
  const smokeRoot = await mkdtemp(path.join(tmpdir(), "jadense-zotero-research-smoke-"))
  const profileDir = path.join(smokeRoot, "profile")
  const dataDir = path.join(smokeRoot, "data")
  const reportPath = path.join(smokeRoot, "research-report.json")
  const pdfPath = path.join(smokeRoot, "synthetic-research.pdf")
  const extensionsDir = path.join(profileDir, "extensions")
  const stub = await startStub()
  let child
  let stdout
  let stderr
  let passed = false
  try {
    await mkdir(extensionsDir, { recursive: true })
    await mkdir(dataDir, { recursive: true })
    await writeFile(pdfPath, createResearchFixturePdf())
    await copyFile(upgradeFrom ? path.resolve(upgradeFrom) : artifact, path.join(extensionsDir, `${pluginID}.xpi`))
    const upgradeXpi = upgradeFrom ? path.join(smokeRoot, "upgrade.xpi") : undefined
    if (upgradeXpi) await copyFile(artifact, upgradeXpi)
    await writeCompanion(extensionsDir, {
      pluginID, profileDir, dataDir, pdfPath, reportPath, origin: stub.origin, upgradeXpi,
      token: SYNTHETIC_TOKEN, uploadFolderId: UPLOAD_FOLDER_ID,
      sentences: PDF_SENTENCES, translationMarker: TRANSLATION_MARKER, byokMarker: BYOK_MARKER,
      figureCaption: FIGURE_CAPTION, figureMarker: FIGURE_MARKER,
      figureFollowupPrompt: FIGURE_FOLLOWUP_PROMPT, figureFollowupMarker: FIGURE_FOLLOWUP_MARKER,
      figureCurrentMarker: FIGURE_CURRENT_MARKER,
      captureMarker: CAPTURE_MARKER, captureCurrentMarker: CAPTURE_CURRENT_MARKER,
      markdown: {
        marker: MARKDOWN_MARKER,
        user: createMarkdownFixture("user", stub.origin),
        assistant: createMarkdownFixture("assistant", stub.origin),
      },
      screenshots: argv.includes("--screenshots"), screenshotDir: smokeRoot, appearanceLanguage,
    })
    await writeFile(path.join(profileDir, "user.js"), [
      'user_pref("extensions.autoDisableScopes", 0);',
      'user_pref("extensions.enabledScopes", 15);',
      'user_pref("extensions.update.enabled", false);',
      'user_pref("intl.locale.requested", "zh-CN");',
      'user_pref("extensions.jadenseInZotero.displayLanguage", ' + JSON.stringify(appearanceLanguage || "zh-CN") + ');',
      "",
    ].join("\n"))
    stdout = await open(path.join(smokeRoot, "zotero.stdout.log"), "w")
    stderr = await open(path.join(smokeRoot, "zotero.stderr.log"), "w")
    child = spawn(executable, ["-no-remote", "-profile", profileDir, "-datadir", dataDir, "-ZoteroDebugText"], {
      windowsHide: true, stdio: ["ignore", stdout.fd, stderr.fd],
    })
    let spawnError
    child.once("error", (error) => { spawnError = error })
    const deadline = Date.now() + timeoutMs
    let report
    let previousStage
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      report = await readFile(reportPath, "utf8").then(JSON.parse).catch(() => undefined)
      if (report?.stage && report.stage !== previousStage) {
        previousStage = report.stage
        console.log(`Research smoke: ${report.stage}`)
      }
      if (report?.state === "failed") throw new Error(`${report.error}\nManager: ${report.managerStatus}`)
      if (report?.state === "passed") break
      await delay(250)
    }
    if (report?.state !== "passed") throw new Error(`Research smoke timed out at ${report?.stage ?? "companion startup"}`)
    if (stub.failures.length) throw new Error(stub.failures.join("\n"))
    if (!appearanceLanguage && (stub.requests.filter((request) => request.kind === "upload-metadata").length !== 2
      || stub.requests.filter((request) => request.kind === "upload-pdf").length !== 1)) {
      throw new Error("Expected two metadata uploads and exactly one multipart PDF; missing or disabled PDFs must not dispatch files")
    }
    if (!appearanceLanguage && (stub.requests.filter((request) => request.kind === "analysis-jadense").length !== 3
      || stub.requests.filter((request) => request.kind === "analysis-byok").length !== 1
      || stub.requests.filter((request) => request.kind === "translation").length !== 3
      || stub.requests.filter((request) => request.kind === "markdown").length !== 1
      || stub.requests.filter((request) => request.kind === "figure-interpretation").length !== 1
      || stub.requests.filter((request) => request.kind === "figure-followup").length !== 1
      || stub.requests.filter((request) => request.kind === "figure-current").length !== 1
      || stub.requests.filter((request) => request.kind === "manual-capture").length !== 1
      || stub.requests.filter((request) => request.kind === "manual-capture-current").length !== 1
      || stub.requests.filter((request) => request.kind === "byok-direct").length !== 1
      || stub.requests.filter((request) => request.kind === "image-upload").length !== 1
      || stub.requests.filter((request) => request.kind === "image-upload-followup").length !== 1
      || stub.requests.filter((request) => request.kind === "byok-test").length !== 1)) {
      throw new Error("Expected three Jadense analyses, one selected-BYOK analysis, three translations, one Markdown, three SDT and two manual-capture Figure Chat requests, one direct BYOK Chat, and one BYOK test request")
    }
    if (stub.requests.some((request) => request.kind === "points-check-in")) throw new Error("Plugin UI must never dispatch a direct check-in POST")
    report.checks.push("no-plugin-check-in-post")
    if (!appearanceLanguage) report.checks.push("markdown-no-automatic-network-resources")
    await writeFile(reportPath, JSON.stringify(report, null, 2))
    await writeFile(path.join(smokeRoot, "request-summary.json"), JSON.stringify(stub.requests, null, 2))
    passed = true
    console.log(`Research XPI smoke passed: ${report.checks.join(", ")}.`)
  } finally {
    await writeFile(path.join(smokeRoot, "request-summary.json"), JSON.stringify({ requests: stub.requests, failures: stub.failures }, null, 2))
    if (child) await stopIsolatedProcess(child, profileDir)
    await Promise.all([stdout?.close(), stderr?.close()])
    await new Promise((resolve) => stub.server.close(resolve))
    if (passed && !argv.includes("--keep-temp") && !argv.includes("--screenshots")) {
      await removeSmokeRoot(smokeRoot)
    } else {
      console.log(`Research smoke artifacts: ${smokeRoot}`)
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
