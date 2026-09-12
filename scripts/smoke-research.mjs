import { verifyLiteratureWorkspace } from './smoke-literature-workspace.mjs'
import { verifyReaderChat } from "./smoke-reader-chat.mjs"
import { verifyMachineTranslation } from './smoke-machine-translation.mjs'
import { verifyOCRTranslation } from './smoke-ocr-translation.mjs'
/**
 * 实际 XPI 的科研与 UI smoke：独立 profile/data + 合成 PDF/Markdown + localhost AI stub。
 * 临时伴随插件只驱动实际阅读器/Manager UI，不改 release XPI，不加入生产测试后门。
 */
/* global Zotero, Services, Components, ChromeUtils, IOUtils, PathUtils */
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { copyFile, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { buildReleasePaths, loadReleaseContext } from "./release-common.mjs"
import { verifyAnalysisDetails } from "./smoke-analysis-details.mjs"
import { verifyTranslationSidebar } from "./smoke-translation-sidebar.mjs"
import { verifyTranslationPapers } from "./smoke-translation-papers.mjs"

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
export function createResearchFixturePdf(withReferences = false, translationLayout = false) {
  let streams = PDF_SENTENCES.map((sentences, pageIndex) => [
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
    ...(withReferences && pageIndex === 1 ? [
      "BT /F1 11 Tf 50 640 Td",
      ...["References", "[1] Smith, J. (2020). Reliable scientific evidence.", "Research Journal. doi:10.1234/evidence", "[2] Unresolved source without DOI", "[3] Smith, J. (2020). Reliable scientific evidence.", "Research Journal. doi:10.1234/evidence"].flatMap((line, index) => [...(index ? ["0 -20 Td"] : []), `(${line.replace(/[\\()]/g, "\\$&")}) Tj`]),
      "ET",
    ] : []),
  ].join("\n"))
  if (translationLayout) streams = [
    [["Results", 50, 705, 15], ["A complete scientific argument explains", 50, 675, 11],
      ["how the experiment preserves meaning", 50, 660, 11], ["across every line of the left column and", 50, 645, 11],
      ["continues with the evidence in the next", 330, 675, 11], ["column before reaching the following", 330, 660, 11],
      ["page where the same argument", 330, 645, 11]],
    [["ends with its complete conclusion.", 50, 705, 11], ["Methods", 50, 660, 15],
      ["An independent experiment measures", 50, 630, 11], ["the same effect with calibrated sensors.", 50, 615, 11],
      ["The analysis retains all observations", 50, 580, 11], ["and reports uncertainty in the estimate.", 50, 565, 11]],
  ].map((rows, index) => [
    ...[["Article", 50, 770, 9], ["Research Journal 2026", 360, 770, 9], ...rows, [String(index + 1), 300, 20, 9]].map(([text, x, y, size]) =>
      `BT /F1 ${size} Tf ${x} ${y} Td (${text}) Tj ET`),
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
      if (request.url === '/api/chat/temporary' && request.method === 'HEAD') {
        if (request.headers.authorization !== `Bearer ${SYNTHETIC_TOKEN}`) throw new Error('Unexpected temporary capability identity')
        response.writeHead(200, { 'x-jadense-temporary-protocol': '1' }); response.end(); return
      }
      if (request.url === '/api/chat') response.setHeader('x-jadense-temporary-protocol', '1')
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
        } else if (prompt.includes('<passage>')) {
          requests.push({ kind: 'ocr-translation' })
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          response.write(`data: ${JSON.stringify({ type: 'text-delta', delta: '## OCR_STREAM\n\n首片流式译文。\n\n' })}\n\n`)
          await delay(1800)
          response.end(`data: ${JSON.stringify({ type: 'text-delta', delta: '全文已完成。' + (prompt.split('<passage>')[1]?.match(/⟦F\d+⟧|!\[[^\]\n]*\]\(jdx-asset:image-\d+\)/gu) ?? []).join(' ') })}\n\ndata: {"type":"finish"}\n\n`)
          return
        } else if (prompt.startsWith("Translate every supplied passage") || prompt.startsWith("Translate the supplied continuous article passage")) {
          const passages = JSON.parse(prompt.split("\n").at(-1))
          const semanticTranslations = {
            Results: "结果", Methods: "研究方法",
            "A complete scientific argument explains how the experiment preserves meaning across every line of the left column and continues with the evidence in the next column before reaching the following page where the same argument ends with its complete conclusion.": "一个完整的科学论述说明，实验如何在换行后保留原意。左栏的论述延续至右栏的证据，并在下一页给出完整结论。",
            "An independent experiment measures the same effect with calibrated sensors.": "独立实验使用经过校准的传感器测量同一效应。",
            "The analysis retains all observations and reports uncertainty in the estimate.": "分析保留全部观测数据，并报告估计结果的不确定性。",
          }
          output = JSON.stringify({ translations: passages.map(passage => ({ id: passage.id, text: semanticTranslations[passage.text] ?? `全文测试译文：${passage.text}\n\n公式 $x^2$` })), additive: true })
          requests.push({ kind: "full-translation", ids: passages.map(passage => passage.id) })
          await delay(800)
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
        } else if (prompt.includes('SYNTHETIC_SIDEBAR_QUESTION')) {
          output = createMarkdownFixture('assistant', `http://127.0.0.1:${server.address().port}`)
          markdownStream = true
          requests.push({ kind: 'reader-chat', temporary: true, streamed: true })
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
async function runHarness(config, verifyAnalysisDetails, verifyTranslationSidebar, verifyTranslationPapers, verifyReaderChat) {
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
    // 合成连续操作不应被可选 Star 邀请抢焦点；邀请状态机由独立测试覆盖。
    Zotero.Prefs.set("extensions.jadenseInZotero.starInvitation", JSON.stringify({ uses: 0, lastPrompt: Date.now(), outcome: "later" }), true)
    Zotero.Prefs.set("extensions.jadenseInZotero.token", config.token)
    if (config.resumeOnly) {
      const jobs = Zotero.__jadenseDocumentJobs; await jobs.ready
      const task = jobs.list("translation").find(row => row.status === "paused")
      assert(task?.status === "paused" && task.completed > 0 && task.completed < task.total, "Interrupted task was not restored as manually resumable")
      await Zotero.Promise.delay(400)
      assert(task.status === "paused", "Restart automatically dispatched translation")
      const before = task.completed
      jobs.resume(task.id); await jobs.idle()
      assert(task.status === "complete" && task.completed === before + 1, "Native restart did not resume only the remaining chunk")
      const references = await jobs.store.references(jobs.list("references")[0].id)
      assert(references.length === 3 && references[0].imported?.itemID === references[2].imported?.itemID, "Restart lost original references or import associations")
      report.checks.push("native-restart-manual-resume", "native-restart-completed-chunks-retained", "native-restart-reference-import-history")
      report.state = "passed"; report.stage = "complete"; await persist(); return
    }
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
        // drawSnapshot 会忽略 WebRender backdrop-filter；成对毛玻璃截图从目标窗口 compositor 读取，不采桌面。
        const readback = name.includes("-translucent-")
        if (readback) {
          const main = Zotero.getMainWindow()
          ;(report.compositorTabs ??= []).push({ name, readerTab: reader.tabID, selectedTabBefore: main.Zotero_Tabs.selectedID })
          if (reader.tabID) main.Zotero_Tabs.select(reader.tabID)
          main.focus(); await Zotero.Promise.delay(250)
        }
        const canvas = await capture.canvas(captureWindow, browsingContext, 0, 0, viewport.width, viewport.height, { readback })
        let pixelSignature
        if (readback) {
          const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data
          let hash = 2166136261
          for (let index = 0; index < pixels.length; index += 4) hash = Math.imul(hash ^ pixels[index] ^ (pixels[index + 1] << 8) ^ (pixels[index + 2] << 16), 16777619) >>> 0
          pixelSignature = hash.toString(16)
        }
        const binary = win.atob(capture.toBase64(canvas, "image/png"))
        const filePath = PathUtils.join(config.screenshotDir, `${name}.png`)
        await IOUtils.write(filePath, Uint8Array.from(binary, (character) => character.charCodeAt(0)))
        ;(report.screenshots ??= []).push(filePath)
        const viewportKey = win === manager ? "managerViewports" : win === reader._iframeWindow ? "readerViewports" : "nativeViewports"
        ;(report[viewportKey] ??= []).push({ name, ...viewport, imageWidth: canvas.width, imageHeight: canvas.height, pixelSignature })
        return pixelSignature
      } catch (error) {
        // 功能验收仍可运行；截图不支持时必须明确记录，不能声称已完成视觉核验。
        ;(report.screenshotWarnings ??= []).push(`${name}: ${String(error)}`)
      }
    }
    /** 原生布局验收：真实浮窗的菜单、背景透明度与拖拽尺寸必须一起工作。 */
    const verifyFloatingWindow = async (panel, name) => {
      const doc = panel.ownerDocument, win = doc.defaultView
      const menu = panel.querySelector(".jdx-window-appearance")
      const toggle = menu?.querySelector("summary")
      assert(menu && toggle && !menu.open, name + " lacks a collapsed appearance toggle")
      const panelBounds = panel.getBoundingClientRect(), toggleBounds = toggle.getBoundingClientRect()
      assert(toggleBounds.left < panelBounds.left + panelBounds.width / 2
        && toggleBounds.top > panelBounds.top + panelBounds.height / 2, name + " appearance toggle is not bottom-left")
      toggle.click()
      await waitFor(() => menu.open, name + " appearance menu open")
      const style = menu.querySelector("select[data-jdx-translation-style]")
      const opacity = menu.querySelector("input[data-jdx-translation-opacity]")
      assert(style && opacity?.type === "range" && opacity.min === "0" && opacity.max === "100", name + " appearance menu lacks style or transparency slider")
      style.value = "glass"; style.dispatchEvent(new win.Event("change", { bubbles: true }))
      opacity.value = "55"; opacity.dispatchEvent(new win.Event("input", { bubbles: true }))
      await waitFor(() => Number(Zotero.Prefs.get("extensions.jadenseInZotero.translationWindowOpacity", true)) === 45, name + " opacity persisted")
      const computed = win.getComputedStyle(panel)
      assert(panel.dataset.windowStyle === "glass" && computed.backdropFilter.includes("blur"), name + " glass surface is not blurred")
      const swatch = doc.createElement("canvas"); swatch.width = swatch.height = 1
      const context = swatch.getContext("2d"); context.fillStyle = computed.backgroundColor; context.fillRect(0, 0, 1, 1)
      const backgroundAlpha = context.getImageData(0, 0, 1, 1).data[3]
      assert(backgroundAlpha > 0 && backgroundAlpha < 250 && Number(computed.opacity) === 1,
        name + " transparency faded text or kept a solid background")
      const menuBounds = menu.querySelector(".jdx-window-appearance-menu").getBoundingClientRect()
      assert(menuBounds.width > 0 && menuBounds.left >= 0 && menuBounds.right <= win.innerWidth + 1
        && menuBounds.top >= panelBounds.top && menuBounds.bottom <= panelBounds.bottom + 1, name + " appearance menu escaped its window")
      await screenshot(name + "-appearance-glass", win)
      toggle.click()
      assert(!menu.open, name + " appearance menu did not close")
      // 同一透明度、同一页面的成对截图用于区分实际模糊与单纯半透明；不以 CSS 属性代替视觉验收。
      const surfaces = {}
      for (const surface of ["default", "glass"]) {
        style.value = surface; style.dispatchEvent(new win.Event("change", { bubbles: true }))
        await Zotero.Promise.delay(150)
        const ancestors = []
        for (let element = panel; element; element = element.parentElement) {
          const css = win.getComputedStyle(element)
          ancestors.push({ tag: element.localName, id: element.id, classes: element.className, opacity: css.opacity, filter: css.filter, backdropFilter: css.backdropFilter, isolation: css.isolation, contain: css.contain, background: css.backgroundColor })
        }
        ;(report.floatingSurfaces ??= []).push({ name, surface, ancestors })
        surfaces[surface] = await screenshot(name + "-translucent-" + surface, win)
        if (config.glassProbe) {
          const main = Zotero.getMainWindow(), previousTitle = main.document.title
          try {
            main.document.title = `Jadense synthetic glass probe ${surface}`; main.focus()
            await stage(`glass-probe-${name}-${surface}`)
            await Zotero.Promise.delay(30000)
          } finally { main.document.title = previousTitle }
        }
      }
      if (surfaces.default && surfaces.glass) {
        assert(surfaces.default !== surfaces.glass, name + " glass pixels are identical to a plain translucent window")
        report.checks.push(name + "-rendered-frosted-backdrop")
      }
      const glassSource = panel.querySelector(".jdx-window-glass-source")
      assert(glassSource && win.getComputedStyle(glassSource).filter.includes("blur"), name + " has no native PDF glass source")
      const gesture = (target, deltaX, deltaY) => {
        const bounds = target.getBoundingClientRect(), x = bounds.left + bounds.width / 2, y = bounds.top + bounds.height / 2
        for (const [type, receiver, clientX, clientY, buttons] of [
          ["pointerdown", target, x, y, 1], ["pointermove", doc, x + deltaX, y + deltaY, 1], ["pointerup", doc, x + deltaX, y + deltaY, 0],
        ]) receiver.dispatchEvent(new win.PointerEvent(type, Components.utils.cloneInto({
          bubbles: true, cancelable: true, button: 0, buttons, clientX, clientY, pointerId: 93, pointerType: "mouse", isPrimary: true,
        }, win)))
      }
      const beforeDrag = panel.getBoundingClientRect()
      gesture(panel.querySelector("header strong, header h3, header"), -36, 28)
      await Zotero.Promise.delay(100)
      const afterDrag = panel.getBoundingClientRect()
      assert(Math.abs(afterDrag.left - beforeDrag.left) >= 20 || Math.abs(afterDrag.top - beforeDrag.top) >= 20, name + " title drag did not move its window")
      assert(panel.querySelectorAll("[data-jdx-resize]").length === 8, name + " lacks edge and corner resize handles")
      gesture(panel.querySelector('[data-jdx-resize="se"]'), -48, -38)
      await Zotero.Promise.delay(100)
      const afterResize = panel.getBoundingClientRect()
      assert(afterResize.width < afterDrag.width - 20 && afterResize.height < afterDrag.height - 20, name + " corner drag did not resize both dimensions")
      assert(afterResize.left >= 0 && afterResize.top >= 0 && afterResize.right <= win.innerWidth + 1
        && afterResize.bottom <= win.innerHeight + 1, name + " drag/resize escaped viewport")
      const header = panel.querySelector("header")
      const keyboardResize = new win.KeyboardEvent("keydown", Components.utils.cloneInto({ key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true }, win))
      header.dispatchEvent(keyboardResize)
      const afterKeyboard = panel.getBoundingClientRect()
      ;(report.floatingGeometry ??= []).push({ name, beforeDrag: beforeDrag.toJSON(), afterDrag: afterDrag.toJSON(), afterResize: afterResize.toJSON(), afterKeyboard: afterKeyboard.toJSON(), key: keyboardResize.key, shift: keyboardResize.shiftKey })
      assert(afterKeyboard.width >= afterResize.width + 9, name + " keyboard resize is unavailable")
      await screenshot(name + "-dragged-resized", win)
      const previousFont = Zotero.Prefs.get("extensions.jadenseInZotero.fontSize", true) || "13"
      gesture(panel.querySelector('[data-jdx-resize="se"]'), -10000, -10000)
      Zotero.Prefs.set("extensions.jadenseInZotero.fontSize", "24", true)
      await Zotero.Promise.delay(150)
      toggle.click(); await waitFor(() => menu.open, name + " small appearance menu")
      opacity.scrollIntoView({ block: "nearest" })
      const smallBounds = panel.getBoundingClientRect(), smallMenu = menu.querySelector(".jdx-window-appearance-menu").getBoundingClientRect()
      const sliderBounds = opacity.getBoundingClientRect(), sliderHit = doc.elementFromPoint(sliderBounds.left + sliderBounds.width / 2, sliderBounds.top + sliderBounds.height / 2)
      assert(smallMenu.top >= smallBounds.top && smallMenu.bottom <= smallBounds.bottom + 1
        && (sliderHit === opacity || opacity.contains(sliderHit)), name + " small window clips the appearance slider at 24px")
      const detail = panel.querySelector(":scope > .jdx-full-detail")
      if (detail) assert(win.getComputedStyle(detail).overflowY === "auto", name + " small detail can paint over its footer")
      await screenshot(name + "-appearance-small-24", win)
      toggle.click(); Zotero.Prefs.set("extensions.jadenseInZotero.fontSize", String(previousFont), true)
      gesture(panel.querySelector('[data-jdx-resize="se"]'), beforeDrag.width - smallBounds.width, beforeDrag.height - smallBounds.height)
      report.checks.push(name + "-bottom-left-appearance-toggle", name + "-glass-and-opacity", name + "-title-drag", name + "-edge-corner-resize", name + "-keyboard-resize")
      report.checks.push(name + "-small-window-large-font-menu")
      Zotero.Prefs.set("extensions.jadenseInZotero.translationWindowOpacity", "80", true)
    }
    /** 以原生内容盒和真实命中区域检查字号变化；字体恢复后继续既有翻译/引用流程。 */
    const verifySelectionPopupBounds = async (popup, label) => {
      const previousFont = Zotero.Prefs.get("extensions.jadenseInZotero.fontSize", true) || "13"
      try {
        for (const fontSize of [12, 13, 15, 18, 24]) {
          Zotero.Prefs.set("extensions.jadenseInZotero.fontSize", String(fontSize), true)
          await Zotero.Promise.delay(150)
          const bounds = popup.getBoundingClientRect(), host = popup.parentElement.getBoundingClientRect()
          ;(report.selectionPopupBounds ??= []).push({ label, fontSize, group: bounds.toJSON(), host: host.toJSON() })
          await screenshot("reader-selection-popup-" + label + "-" + fontSize)
          assert(bounds.left >= host.left && bounds.right <= host.right + 1
            && bounds.top >= host.top && bounds.bottom <= host.bottom + 1,
          "Selection actions overflow the native popup content at " + fontSize + "px")
          for (const button of popup.querySelectorAll("button")) {
            const rect = button.getBoundingClientRect(), text = button.querySelector(".jadense-reader-label")
            const hit = readerDoc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
            assert(rect.left >= bounds.left && rect.right <= bounds.right + 1
              && rect.top >= bounds.top && rect.bottom <= bounds.bottom + 1
              && text.scrollWidth <= text.clientWidth + 1 && button.contains(hit),
            "Selection action is clipped or unreachable at " + fontSize + "px")
          }
        }
      } finally { Zotero.Prefs.set("extensions.jadenseInZotero.fontSize", String(previousFont), true) }
      report.checks.push("native-selection-popup-font-size-bounds-" + label)
    }
    /** 小窗口使用单一入口，并核验原生页码真实宽度和命中区域，避免只看插件自身是否溢出。 */
    const verifyCompactReaderToolbar = async () => {
      const main = Zotero.getMainWindow(), win = reader._iframeWindow, doc = win.document
      await waitFor(() => doc.querySelector('[data-jadense-reader-tools="renderToolbar"] .jadense-reader-actions-toggle')
        && doc.getElementById("pageNumber") && doc.querySelector("#numPages div"), "native toolbar and page controls ready")
      const previousSize = [main.outerWidth, main.outerHeight]
      const previousFont = Zotero.Prefs.get("extensions.jadenseInZotero.fontSize", true) || "13"
      try {
        if (reader.tabID) main.Zotero_Tabs?.select?.(reader.tabID)
        main.restore?.(); main.focus()
        // Windows Zotero 自身最小外窗约1016px（Reader 1000px）；不可把未成功的760px请求误记成窄屏验收。
        for (const width of [1400, 1100, 1016]) {
          main.resizeTo(width, 740)
          await waitFor(() => {
            report.compactResize = { requested: width, outerWidth: main.outerWidth, outerHeight: main.outerHeight, viewportWidth: win.innerWidth, viewportHeight: win.innerHeight }
            return win.innerWidth > 0 && win.innerWidth <= width
          }, "compact native viewport near " + width, 8000)
          Zotero.Prefs.set("extensions.jadenseInZotero.fontSize", width === 1016 ? "24" : "13", true)
          await Zotero.Promise.delay(300)
          const group = doc.querySelector('[data-jadense-reader-tools="renderToolbar"]')
          const toggle = group?.querySelector(".jadense-reader-actions-toggle")
          const page = doc.getElementById("pageNumber"), total = doc.querySelector("#numPages div")
          assert(group && toggle && page && total, "Reader lacks the plugin toggle or native page controls")
          const groupBounds = group.getBoundingClientRect(), pageBounds = page.getBoundingClientRect(), totalBounds = total.getBoundingClientRect()
          ;(report.compactToolbarBounds ??= []).push({ requestedWidth: width, actualOuterWidth: main.outerWidth, viewport: win.innerWidth, plugin: groupBounds.toJSON(), page: pageBounds.toJSON(), total: totalBounds.toJSON() })
          assert(groupBounds.width < 100 && toggle.getBoundingClientRect().width > 0, "Compact actions still consume the permanent toolbar")
          assert(pageBounds.width >= 50 && pageBounds.right <= win.innerWidth
            && doc.elementFromPoint(pageBounds.left + pageBounds.width / 2, pageBounds.top + pageBounds.height / 2) === page,
          "Reading actions squeeze or cover the native page-number input at " + width)
          const totalHit = doc.elementFromPoint(totalBounds.left + totalBounds.width / 2, totalBounds.top + totalBounds.height / 2)
          assert(totalBounds.width > 0 && totalBounds.right <= win.innerWidth && (total === totalHit || total.contains(totalHit)), "Native total-page text is covered at " + width)
          assert(!doc.querySelector('[data-jadense-article-languages], [data-jadense-action="references"]'), "Removed toolbar entries returned at compact width")
          toggle.click()
          const menu = await waitFor(() => doc.querySelector("[data-jadense-action-menu]"), "compact action menu")
          const actions = Array.from(menu.querySelectorAll("[data-jadense-action]"))
          assert(menu.getAttribute("role") === "menu" && actions.map(button => button.dataset.jadenseAction).join(",") === "attach,analyze,quote,fullTranslate", "Compact menu changed the available reading actions")
          const menuBounds = menu.getBoundingClientRect()
          assert(menuBounds.left >= 0 && menuBounds.right <= win.innerWidth + 1 && menuBounds.top >= 0
            && menuBounds.bottom <= win.innerHeight + 1 && actions.every(button => button.getBoundingClientRect().height >= 24), "Compact action menu is clipped or compressed")
          assert(actions.at(-1).textContent.trim() === (config.appearanceLanguage === 'en-US' ? 'Full translation' : '全文翻译'), "Compact menu full translation label changed")
          await screenshot("reader-actions-" + width)
          menu.dispatchEvent(new win.KeyboardEvent("keydown", Components.utils.cloneInto({ key: "Escape", bubbles: true, cancelable: true }, win)))
          assert(toggle.getAttribute("aria-expanded") === "false" && !doc.querySelector("[data-jadense-action-menu]"), "Escape did not close compact actions")
        }
        report.checks.push("reader-actions-single-compact-toggle", "reader-actions-menu-viewport", "reader-native-page-controls-unobscured", "reader-actions-keyboard-dismissal")
      } finally {
        Zotero.Prefs.set("extensions.jadenseInZotero.fontSize", String(previousFont), true)
        main.resizeTo(...previousSize)
        await Zotero.Promise.delay(200)
      }
    }
    if (config.machineOnly) {
      await stage('machine-translation')
      readerDoc.querySelector('.jadense-reader-brand').click()
      manager = await waitFor(() => findManager()?.receiveJadenseContext && findManager(), 'machine Manager')
      await verifyMachineTranslation({ Zotero, reader, manager, waitFor, assert, screenshot, report, findWindowContaining, live: config.machineLive })
      report.state = 'passed'; report.stage = 'complete'; await persist(); return
    }
    if (!config.documentsOnly) {
    const toolbarButton = (kind) => readerDoc.querySelector(`[data-jadense-reader-tools="renderToolbar"] [data-jadense-action="${kind}"], [data-jadense-action-menu] [data-jadense-action="${kind}"]`)
    const pressKey = (win, key, modifiers = {}, target = win.document.body) => {
      const event = new win.KeyboardEvent("keydown", Components.utils.cloneInto({
        key, bubbles: true, cancelable: true, ...modifiers,
      }, win))
      target.dispatchEvent(event)
      return event.defaultPrevented
    }
    await waitFor(() => toolbarButton("analyze"), "actual release toolbar")
    if (config.shellOnly) {
      await stage("unified-manager-shell")
      readerDoc.querySelector(".jadense-reader-brand").click()
      manager = await waitFor(() => findManager()?.receiveJadenseContext && findManager(), "unified Manager")
      const doc = manager.document, element = id => doc.getElementById("jadense-" + id)
      report.shellHost = { os: Services.appinfo.OS, version: Services.appinfo.version, build: Services.sysinfo.getProperty("build"), dpi: manager.devicePixelRatio, customtitlebar: doc.documentElement.getAttribute("customtitlebar") }
      report.shellHost.capabilities = [typeof manager.ChromeUtils, typeof manager.Services, typeof manager.minimize, typeof manager.maximize, typeof manager.restore]
      await persist()
      assert(doc.documentElement.getAttribute("customtitlebar") === "true", "Verified Windows host did not enable its integrated titlebar")
      assert(manager.getComputedStyle(element("titlebar")).getPropertyValue("-moz-window-dragging") === "drag", "Titlebar is not a native drag region")
      assert(manager.getComputedStyle(element("github")).getPropertyValue("-moz-window-dragging") === "no-drag", "Interactive control remains draggable")
      const launchURL = Zotero.launchURL, helpLinks = []
      Zotero.launchURL = url => helpLinks.push(url)
      try { element("home").click(); element("github").click(); element("check-in").click() } finally { Zotero.launchURL = launchURL }
      assert(helpLinks.join(",") === "https://jadense.cn,https://github.com/jadense-ai/jadense-in-zotero,https://jadense.cn", "Shell links did not use the system-browser API with fixed destinations")
      assert(element("titlebar").querySelector("button") === element("manager-sidebar-toggle"), "Navigation toggle is not the first shell control")
      const original = manager
      readerDoc.querySelector(".jadense-reader-brand").click()
      assert(findManager() === original, "Reopening created another Manager")
      element("help-toggle").click()
      assert(!element("help-menu").hidden && doc.activeElement === element("manager-nav-guide"), "Help menu focus is incorrect")
      pressKey(manager, "End", {}, element("help-menu"))
      assert(doc.activeElement === element("help-update"), "Help End navigation failed")
      pressKey(manager, "Escape", {}, element("help-menu"))
      assert(element("help-menu").hidden && doc.activeElement === element("help-toggle"), "Help Escape/focus failed")
      element("help-about").click()
      await waitFor(() => element("help-version").textContent.includes("0.4.5"), "runtime installed version")
      assert(element("help-dialog").open, "About is not modal")
      element("help-dialog").close()
      await Zotero.Promise.delay(50)
      assert(doc.activeElement === element("help-toggle"), "Dialog did not restore focus")
      // 使用真实 Gecko 比较器，并仅替换可选 GitHub GET；不发送外网请求。
      const fetchBefore = manager.fetch
      let updateRequests = 0, mode = "available"
      manager.fetch = async (url, options) => {
        if (String(url).includes("api.github.com/repos/jadense-ai/jadense-in-zotero/releases/latest")) {
          updateRequests++
          if (mode === "failure") return { ok: false, status: 429 }
          const tag = mode === "latest" ? "v0.4.5" : mode === "ahead" ? "v0.4.2" : "v0.4.10"
          return { ok: true, json: async () => ({ tag_name: tag, draft: false, prerelease: false, future: true }) }
        }
        return fetchBefore.call(manager, url, options)
      }
      try {
        assert(updateRequests === 0, "Opening help checked updates automatically")
        for (const state of ["available", "latest", "ahead", "failure"]) {
          mode = state
          element("help-update").click()
          await waitFor(() => !element("help-retry").disabled, "manual update " + state)
          const text = element("help-status").textContent
          assert(state === "available" ? /发现新版本|New version available/.test(text) : state === "latest" ? /已是最新|up to date/.test(text) : state === "ahead" ? /无需降级|No downgrade/.test(text) : /检查失败|Check failed/.test(text), "Incorrect update state " + text)
        }
        mode = "latest"; element("help-retry").click()
        await waitFor(() => !element("help-retry").disabled, "update retry")
        assert(updateRequests === 5, "Unexpected update polling")
      } finally { manager.fetch = fetchBefore; element("help-dialog").close() }
      await waitFor(() => doc.activeElement === element("help-toggle"), "update dialog focus restored before window controls")
      manager.restore()
      await waitFor(() => manager.windowState === manager.STATE_NORMAL, "normal shell before controls")
      element("window-minimize").click()
      await waitFor(() => manager.windowState === manager.STATE_MINIMIZED, "titlebar minimize")
      readerDoc.querySelector(".jadense-reader-brand").click()
      await waitFor(() => manager.windowState === manager.STATE_NORMAL, "reopen restores minimized Manager")
      element("window-maximize").click()
      await waitFor(() => manager.windowState === manager.STATE_MAXIMIZED, "titlebar maximize")
      await screenshot("unified-maximized", manager)
      element("window-maximize").click()
      await waitFor(() => manager.windowState === manager.STATE_NORMAL, "titlebar restore")
      for (const [width, height] of [[1360, 860], [760, 620]]) {
        manager.resizeTo(width + manager.outerWidth - manager.innerWidth, height + manager.outerHeight - manager.innerHeight)
        await Zotero.Promise.delay(300)
        for (const theme of ["light", "dark"]) {
          Zotero.Prefs.set("extensions.jadenseInZotero.theme", theme, true)
          await waitFor(() => doc.documentElement.dataset.theme === theme, "shell theme")
          const panel = doc.querySelector(".jdx-manager-content"), workbench = element("chat-workbench")
          const bounds = panel.getBoundingClientRect()
          assert(bounds.bottom <= manager.innerHeight && bounds.right <= manager.innerWidth, "Unified panel escapes viewport")
          assert(manager.getComputedStyle(panel).borderRadius === "8px" && manager.getComputedStyle(workbench).borderRadius === "0px", "Duplicate panel shell")
          const send = element("chat-send").getBoundingClientRect()
          assert(send.bottom <= manager.innerHeight && send.width > 0, "Composer outside viewport")
          await screenshot("unified-" + (config.appearanceLanguage || "zh-CN") + "-" + theme + "-" + width, manager)
        }
      }
      report.checks.push("unified-shell-geometry", "shell-home-github-and-check-in-links", "help-keyboard-and-focus", "runtime-installed-version", "gecko-version-numeric-order", "updates-manual-only-all-states-retry", "titlebar-minimize-maximize-restore", "window-reuse", "native-content-light-dark-compact")
      report.state = "passed"; report.stage = "complete"; await persist(); return
    }
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
      const nativeReferenceAI = await waitFor(() => preferenceRoot.querySelector('[data-reference-ai]'), 'native reference AI setting')
      const managerReferenceAI = element('jadense-settings-panel-features').querySelector('[data-reference-ai]')
      assert(!nativeReferenceAI.checked && !managerReferenceAI.checked, 'Reference AI must default off in both settings')
      nativeReferenceAI.click()
      await waitFor(() => managerReferenceAI.checked && Zotero.Prefs.get('extensions.jadenseInZotero.referenceAIEnabled', true) === true, 'reference AI setting synchronization')
      managerReferenceAI.click()
      await waitFor(() => !nativeReferenceAI.checked, 'reference AI setting disabled across windows')
      report.checks.push('reference-ai-default-off-upgrade', 'reference-ai-two-settings-synchronized')
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
        element('jadense-settings-tab-features').click()
        await screenshot('reference-ai-' + config.appearanceLanguage + '-' + value, manager)
        element('jadense-settings-tab-general').click()
        await screenshot("reader-" + config.appearanceLanguage + "-" + value)
        // 使用真实启动语言的选区插槽，覆盖英文长标签和浅/深色，不覆写宿主布局。
        const chars = nativePage.chars.slice(0, 10)
        const rect = [Math.min(...chars.map(char => char.rect[0])), Math.min(...chars.map(char => char.rect[1])),
          Math.max(...chars.map(char => char.rect[2])), Math.max(...chars.map(char => char.rect[3]))]
        view._setSelectionRanges(Components.utils.cloneInto([{
          pageIndex: 0, position: { pageIndex: 0, rects: [rect] }, sortIndex: "00000|000000|00000",
          text: chars.map(char => char.c).join(""), collapsed: false, anchor: true, head: true, anchorOffset: 0, headOffset: 10,
        }], reader._iframeWindow))
        const selectionPopup = await waitFor(() => readerDoc.querySelector('[data-jadense-reader-tools="renderTextSelectionPopup"]'), "localized selection popup")
        await verifySelectionPopupBounds(selectionPopup, config.appearanceLanguage + "-" + value)
        view._setSelectionRanges()

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
    assert(!readerDoc.querySelector('[data-jadense-article-languages], button[aria-label="文章翻译语言设置"]')
      && !toolbarButton("references") && !toolbarButton("translate"), "Reader still exposes removed language, selection translation or references toolbar entries")
    assert(toolbarButton("fullTranslate")?.textContent.trim() === "全文翻译", "Full translation toolbar label is incorrect")
    const changeLanguage = (select, value) => {
      select.value = value
      select.dispatchEvent(new reader._iframeWindow.Event("change", Components.utils.cloneInto({ bubbles: true }, reader._iframeWindow)))
    }
    report.checks.push("reader-toolbar-simplified-actions", "reader-full-translation-label")
    await stage("empty-selection-hint")
    view._setSelectionRanges()
    toolbarButton("quote").click()
    const notice = await waitFor(() => readerDoc.querySelector("[data-jadense-reader-notice]:not([hidden])"), "local missing-selection hint")
    assert(notice.textContent.includes("先选中") && notice.getAttribute("role") === "status", "Missing selection hint is not visible and accessible")
    assert(!findManager() && messages().length === 0, "Missing selection unexpectedly opened Manager or created a Chat message")
    pressKey(reader._iframeWindow, "Escape")
    assert(notice.hidden, "Escape did not dismiss the local hint")
    report.checks.push("empty-selection-stays-in-reader", "reader-hint-keyboard-dismissal")

    await stage("reader-logo-opens-manager")
    const logoButton = brand.parentElement
    const beforeLogoChatState = JSON.stringify(localState())
    assert(logoButton.localName === "button" && logoButton.getAttribute("aria-label") === "打开攻玉工作台"
      && !logoButton.hasAttribute("aria-hidden") && logoButton.tabIndex === 0, "Reader logo is not an accessible Manager button")
    logoButton.click()
    manager = await waitFor(() => {
      const win = findManager()
      return win?.receiveJadenseContext ? win : null
    }, "logo-opened Manager")
    assert(!manager.document.getElementById("jadense-manager-section-chat").hidden, "Reader logo did not open Chat")
    const quickStart = manager.document.getElementById("jadense-quick-start-dialog")
    if (quickStart) {
      await waitFor(() => quickStart.open || Zotero.Prefs.get("extensions.jadenseInZotero.quickStartShown") === true, "quick-start dialog")
      if (quickStart.open) manager.document.getElementById("jadense-quick-start-close")?.click()
      await waitFor(() => !quickStart.open, "quick-start dismissal")
    }
    const logoSession = currentSession()
    assert(JSON.stringify(localState()) === beforeLogoChatState
      && (!logoSession || (logoSession.messages.length === 0 && logoSession.sources.length === 0)), "Reader logo changed Chat state or dispatched a paper action")
    if (config.chatSidebarOnly) {
      await verifyReaderChat({ Zotero, reader, manager, assert, waitFor, screenshot, report })
      report.state = 'passed'; await persist(); return
    }
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
    // 消息操作必须在正文和图片之后；长草稿只扩展输入框，不挤出发送入口。
    const figureArticle = figureMessageImage.closest("article")
    assert(figureArticle.lastElementChild.classList.contains("jdx-chat-message-actions"), "Message actions are not below the attachment")
    assert(!figureArticle.querySelector("[data-copy-plain]").disabled, "Visible message cannot be copied as plain text")
    const growingInput = manager.document.getElementById("jadense-chat-input")
    growingInput.value = Array(30).fill("Synthetic multiline draft").join("\n")
    growingInput.dispatchEvent(new manager.Event("input", { bubbles: true }))
    assert(growingInput.getBoundingClientRect().height <= 200 && growingInput.scrollHeight > growingInput.clientHeight, "Long draft does not scroll within its height cap")
    growingInput.value = ""
    growingInput.dispatchEvent(new manager.Event("input", { bubbles: true }))
    assert(growingInput.getBoundingClientRect().height < 200, "Cleared draft does not shrink")
    report.checks.push("chat-actions-below-image", "chat-plain-copy-available", "chat-textarea-bounded-autogrow")
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
    const beforeQuestionState = JSON.stringify(localState())
    const beforeQuestionIDs = new Set(localState().sessions.map(session => session.id))
    assert(toolbarButton("attach").textContent.trim() === "提问" && toolbarButton("attach").title.includes("发起新对话"), "Reader question entry lost its new-conversation label")
    toolbarButton("attach").click()
    const readerSidebar = await waitFor(() => Zotero.getMainWindow().document.querySelector(`.jdx-reader-workspace[data-reader-item="${reader.itemID}"]`), "Reader Chat shell")
    const readerChat = readerSidebar.querySelector(".jdx-reader-chat")
    await waitFor(() => readerChat?.dataset.chatSession === "", "new Reader question draft")
    assert(JSON.stringify(localState()) === beforeQuestionState
      && readerChat.querySelector(".jdx-chat-association").textContent.includes("发送时将关联"), "Opening Reader question persisted a session before send")
    const readerQuestionInput = readerChat.querySelector("textarea")
    readerQuestionInput.value = "SYNTHETIC_SIDEBAR_QUESTION"
    readerQuestionInput.dispatchEvent(new (Zotero.getMainWindow().Event)("input", { bubbles: true }))
    readerChat.querySelector("form").requestSubmit()
    const questionInSidebar = await waitFor(() => localState().sessions.find(session => !beforeQuestionIDs.has(session.id) && session.sources.some(source => source.itemID === attachment.id)), "new Reader question session")
    const questionSessionId = questionInSidebar.id
    await waitFor(() => localState().sessions.find(session => session.id === questionSessionId)?.messages.some(message => message.role === "assistant" && message.status === "complete") && managerIdle(), "Reader question response")
    const questionInManager = await waitFor(() => manager.document.querySelector(`[data-session-id="${questionSessionId}"]`), "Reader session shared to Manager")
    questionInManager.click()
    manager = await waitFor(findManager, "actual release Manager")
    await waitFor(() => managerIdle() && currentSession()?.sources?.some((source) => source.kind === "file" && source.itemID === attachment.id), "question document association")
    assert(currentSession().id === questionSessionId && currentSession().messages.some(message => message.role === "user" && message.text === "SYNTHETIC_SIDEBAR_QUESTION")
      && currentSession().title.includes(parent.getField("title")), "Reader question session lost its sent prompt or paper title")
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
    const beforePickerIDs = new Set(localState().sessions.map(session => session.id))
    toolbarButton("attach").click()
    await waitFor(() => readerChat.dataset.chatSession === "", "second Reader question draft")
    const pickerInput = readerChat.querySelector("textarea")
    pickerInput.value = "SYNTHETIC_SIDEBAR_QUESTION picker"
    pickerInput.dispatchEvent(new (Zotero.getMainWindow().Event)("input", { bubbles: true }))
    readerChat.querySelector("form").requestSubmit()
    const pickerSession = await waitFor(() => localState().sessions.find(session => !beforePickerIDs.has(session.id) && session.sources.some(source => source.itemID === attachment.id)), "resource-picker conversation")
    const pickerSessionId = pickerSession.id
    await waitFor(() => localState().sessions.find(session => session.id === pickerSessionId)?.messages.some(message => message.role === "assistant" && message.status === "complete") && managerIdle(), "resource-picker conversation response")
    const pickerInManager = await waitFor(() => manager.document.querySelector(`[data-session-id="${pickerSessionId}"]`), "resource conversation in Manager")
    pickerInManager.click()
    await waitFor(() => currentSession()?.id === pickerSessionId && managerIdle(), "resource conversation selected")
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
    assert(currentSession().sources.length === 2
      && currentSession().sources.some((source) => source.kind === "item" && source.itemID === parent.id)
      && currentSession().sources.some((source) => source.kind === "file" && source.itemID === attachment.id),
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
      `Source removal focused the wrong element: ${JSON.stringify({ active: manager.document.activeElement?.outerHTML?.slice(0, 240), remaining: remainingSummary?.outerHTML?.slice(0, 240) })}`)
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
      ["jadense-manager-sidebar-toggle", "jadense-chat-sessions"],
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
    assert(!manager.document.getElementById("jadense-chat-details-close"), "Conversation details still expose a duplicate sidebar collapse button")
    assert(!manager.document.getElementById("jadense-chat-details-count"), "Conversation details header still exposes a linked-resource count")
    detailsToggle.click()
    assert(detailsToggle.getAttribute("aria-expanded") === "false", "Conversation details header toggle did not collapse the panel")
    detailsToggle.click()
    report.checks.push("conversation-list-collapse-expand", "conversation-details-collapse-expand", "panel-toggles-preserve-draft-and-sources")

    await stage("first-analysis")
    const chatBeforeAnalysis = JSON.stringify(localState())
    assert(analysisState().records?.length === 1, "Fresh analysis history was lost or old Chat was migrated into it")
    await Zotero.Reader.open(attachment.id)
    toolbarButton("analyze").click()
    await waitFor(() => !manager.document.getElementById("jadense-manager-section-analysis").hidden
      && !manager.document.getElementById("jadense-analysis-panel-history").hidden, "independent analysis history page")
    await screenshot("manager-analysis-in-progress", manager)
    toolbarButton("analyze").click()
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
    const detail = manager.document.querySelector('.jdx-analysis-detail:not([hidden])')
    assert(detail && detail.querySelectorAll('[role="tab"]').length === 3, "Analysis lacks its independent three-tab detail")
    assert(!manager.document.getElementById("jadense-analysis-tab-references"), "Cross-paper reference tab remains")
    detail.querySelector('.jdx-detail-navigation button:last-child').click()
    await waitFor(() => Zotero.Reader._readers.some(value => value.itemID === attachment.id), "detail PDF Reader navigation")
    detail.querySelector('.jdx-detail-navigation button').click()
    const analysisTitle = manager.document.querySelector("#jadense-analysis-history .jdx-analysis-title")
    assert(analysisTitle?.localName === "button" && analysisTitle.type === "button", "History title lacks keyboard button semantics")
    analysisTitle.click()
    const notesTab = manager.document.getElementById('jdx-literature-tab-notes')
    notesTab.click()
    const analysisNotes = await waitFor(() => manager.document.querySelector('.jdx-literature-panel:not([hidden]) .jdx-analysis-notes-text'), 'paper notes result')
    assert(!analysisNotes.parentElement.hidden && analysisNotes.textContent.includes("Controlled improvement."), "Analysis notes detail lost its readable backup")
    notesTab.dispatchEvent(new manager.KeyboardEvent("keydown", Components.utils.cloneInto({ key: "ArrowRight", bubbles: true }, manager)))
    assert(manager.document.activeElement.id.endsWith("-tab-references"), "Detail tabs lost keyboard navigation")
    manager.document.querySelector('.jdx-literature-detail > .jdx-result-tools button').click()
    report.checks.push("analysis-multiline-code-block", "analysis-detail-native-reader", "analysis-three-result-tabs", "analysis-duplicate-start-focus-only")
    assert(!manager.document.getElementById("jadense-analysis-tabs") && !manager.document.getElementById("jadense-analysis-panel-config"), "History still has configuration tabs")
    report.checks.push("analysis-independent-from-chat", "analysis-history-readable-backup", "analysis-notes-detail", "analysis-history-without-tabs")
    const annotationKeys = annotations.map((annotation) => annotation.key).sort()
    await stage("repeat-analysis")
    toolbarButton("analyze").click()
    await waitFor(() => analysisState().records?.length === 3 && managerIdle(), "repeat independent analysis completion")
    assert(JSON.stringify(localState()) === chatBeforeAnalysis, "Repeated analysis changed local Chat")
    assert(analysisState().records[1].notes === firstAnalysisRecord.notes && analysisState().records[1].summary === firstAnalysisRecord.summary, "New analysis changed the prior analysis content")
    assert(manager.document.querySelectorAll('.jdx-analysis-record').length < analysisState().records.length, "Repeated analyses were not grouped by PDF")
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
    await verifySelectionPopupBounds(popup, "zh-CN")
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
    assert(sentenceSourceLanguage.querySelector('option[value="auto"]')
      && !sentenceTargetLanguage.querySelector('option[value="auto"]')
      && sentenceTargetLanguage.options.length >= 8, "Sentence translation lost source detection or target languages")
    await screenshot("reader-translation-panel")
    await verifyFloatingWindow(translationPanel, "selection-translation")
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
    const articlePreferenceKey = `extensions.jadenseInZotero.articleTranslationLanguages.${parent.libraryID}.${encodeURIComponent(parent.key)}`
    assert(!Zotero.Prefs.get(articlePreferenceKey, true), "Sentence language override changed the article preferences")
    await screenshot("reader-translation-sentence-languages")
    report.checks.push("sentence-language-explicit-retranslation", "sentence-retranslation-preserves-source-snapshot", "sentence-language-isolated-from-article", "translation-history-language-labels")
    await stage("reader-legacy-article-language-preferences")
    // 工具条语言入口已移除；旧 profile 的文章偏好仍须兼容，合成值仅属于隔离资料库。
    Zotero.Prefs.set(articlePreferenceKey, JSON.stringify({ sourceLanguage: "fr", targetLanguage: "de" }), true)
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
    manager.document.getElementById("jadense-manager-nav-analysis").click()
    const paperTitle = await waitFor(() => [...manager.document.querySelectorAll('.jdx-analysis-title')].find(button => button.textContent.includes(firstAnalysisRecord.source.title)), 'paper history title')
    paperTitle.click()
    manager.document.getElementById('jdx-literature-tab-selection').click()
    const selectionEntry = await waitFor(() => manager.document.querySelector('.jdx-literature-panel:not([hidden]) .jdx-selection-result'), 'selection result in paper workspace')
    selectionEntry.querySelector('.jdx-selection-toggle').click()
    const translationRecord = translationState().records[0]
    assert(translationRecord.source.itemID === attachment.id && translationRecord.source.libraryID === attachment.libraryID
      && translationRecord.source.itemKey === attachment.key && translationRecord.source.pageIndex === 0,
      'Translation history lost exact attachment and page')
    assert(selectionEntry.querySelector('.jdx-markdown h2') && selectionEntry.querySelector('.jdx-markdown ul')
      && selectionEntry.querySelector('.jdx-markdown strong') && selectionEntry.querySelector('.jdx-markdown math annotation')?.textContent === "\\epsilon = 0.2",
      'Selection history lost Markdown or formula notation')
    const translationTitle = selectionEntry.querySelector('.jdx-selection-content button')
    assert(translationTitle?.localName === 'button' && translationTitle.type === 'button', 'Source navigation is not a button')
    await reader.navigate({ pageIndex: JSON.parse(second.annotationPosition).pageIndex })
    await waitFor(() => view._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber === 2, 'second PDF page before translation navigation')
    translationTitle.click()
    await waitFor(() => view._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber === 1, 'selection history exact-page Reader navigation')
    await screenshot("manager-translation-history", manager)
    const restoredPickerButton = await waitFor(() => manager.document.querySelector(`[data-session-id="${pickerSessionId}"]`), "resource conversation after returning to Chat")
    restoredPickerButton.click()
    await waitFor(() => currentSession()?.id === pickerSessionId, "resource conversation restored after returning to Chat")
    report.checks.push("native-popup-translation", "translation-markdown-and-formula", "translation-no-chat-or-annotation-side-effects", "translation-history-page", "translation-title-native-reader-page")

    await stage("native-manager-window-controls")
    const chrome = Components.interfaces.nsIWebBrowserChrome
    const appWindow = manager.docShell.treeOwner.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
      .getInterface(Components.interfaces.nsIAppWindow)
    const flags = appWindow.chromeFlags
    assert((flags & chrome.CHROME_OPENAS_DIALOG) === 0, "Manager is still a dialog without ordinary native window controls")
    assert((flags & chrome.CHROME_TITLEBAR) !== 0 && (flags & chrome.CHROME_WINDOW_RESIZE) !== 0, "Manager lost native titlebar/resize capabilities required by either shell")
    assert(["minimize", "maximize", "restore"].every((method) => typeof manager[method] === "function"), "Native Manager window controls are unavailable")
    report.managerChromeFlags = { value: flags >>> 0, dialog: false, titlebar: true, integrated: manager.document.documentElement.getAttribute("customtitlebar") === "true", resizable: true }
    const sessionBeforeControls = localState().activeSessionId
    const messageCountBeforeControls = messages().length
    const reopenManager = async (expectedState) => {
      // 必须走 release 的入口触发 focus；smoke 自己 restore 会掩盖最小化恢复缺陷。
      const previousSessionId = currentSession().id
      logoButton.click()
      await waitFor(() => manager.windowState === expectedState, "Manager restored by reader entry", 8_000)
      const opened = findManagers()
      assert(opened.length === 1 && opened[0] === manager, "Reader entry created another Manager")
      assert(currentSession().id === previousSessionId && messages().length === messageCountBeforeControls,
        "Reader brand entry changed the conversation")
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
        `Reader actions discarded the previous draft or its explicitly appended quote: ${JSON.stringify(restoredDraft)}`)
    }
    report.checks.push("native-manager-minimize-maximize-restore", "manager-entry-restores-normal-and-maximized", "manager-window-reused-with-new-question-session", "reader-actions-preserve-prior-draft")

    await stage("manager-byok-direct-chat")
    manager.document.getElementById("jadense-manager-nav-settings").click()
    await waitFor(() => !manager.document.getElementById("jadense-manager-section-settings").hidden, "Manager settings section")
    manager.document.getElementById("jadense-settings-tab-ai").click()
    const featureTab = manager.document.getElementById("jadense-settings-tab-features")
    assert(Array.from(manager.document.querySelectorAll('#jadense-settings-tabs [role="tab"]')).map(tab => tab.textContent.trim()).join(" / ") === "常规 / 功能配置 / OCR配置 / 快捷键设置 / 连接攻玉 / BYOK", "Feature settings tab labels/order changed")
    assert(!manager.document.getElementById("jadense-manager-route-byok"), "Obsolete global channel is still visible")
    featureTab.click()
    const autoFollowChatModel = manager.document.getElementById("jadense-auto-follow-chat-model")
    assert(autoFollowChatModel?.checked === true, "Feature model following is not enabled by default")
    autoFollowChatModel.click()
    await waitFor(() => autoFollowChatModel.checked === false, "Disable automatic feature model following")
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
    const managerModelEditor = manager.document.getElementById("jadense-manager-byok-model-editor")
    const managerModelList = manager.document.getElementById("jadense-manager-byok-model-select")
    assert(managerModelEditor.hidden && managerModelEditor.nextElementSibling === managerModelList, "BYOK model editor is visible in the normal state")
    manager.document.getElementById("jadense-manager-byok-model-new").click()
    assert(!managerModelEditor.hidden && managerModelEditor.nextElementSibling === managerModelList, "Add-model editor was not inserted before the model list")
    manager.document.getElementById("jadense-manager-byok-model-name").value = "Synthetic Model"
    byokModel.value = "synthetic-byok-model"
    byokMaxTokens.value = "96000"
    manager.document.getElementById("jadense-manager-byok-save").click()
    await waitFor(() => manager.document.getElementById("jadense-manager-byok-status").dataset.kind === "success", "BYOK form save")
    assert(managerModelEditor.hidden && managerModelList.querySelectorAll('button[data-model-id]').length === 1, "Saved BYOK model did not return to list mode")
    managerModelList.querySelector('button[data-model-id]').click()
    assert(!managerModelEditor.hidden && managerModelEditor.parentElement === managerModelList, "Editing did not replace the model list in place")
    assert(managerModelList.querySelector('button[data-model-id]').hidden, "Edited BYOK model remained visible below its editor")
    manager.document.getElementById("jadense-manager-byok-save").click()
    await waitFor(() => manager.document.getElementById("jadense-manager-byok-status").dataset.kind === "success", "BYOK edited model save")
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
    preferencesWindow.document.getElementById("jadense-in-zotero-byok-model-new").click()
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
    assert(connectionNav.textContent.includes("攻玉学术")
      && ["account", "sync"].every((name) => connectionTab(name) && connectionPanel(name))
      && !connectionPanel("account").hidden
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
      const rowsBeforeClear = manager.document.querySelectorAll(".jdx-analysis-record").length
      Zotero.Prefs.clear("extensions.jadenseInZotero.paperAnalysisHistory")
      // 空状态使用真实刷新入口；这里只验证展示，不应触发 chrome unload 清理已注册的 Reader 窗口上下文。
      manager.document.getElementById("jadense-analysis-history-refresh").click()
      await waitFor(() => !manager.document.getElementById("jadense-manager-section-analysis").hidden
        && manager.document.querySelector(".jdx-analysis-record"), "reference-only history remains readable")
      await screenshot("manager-analysis-reference-only-history", manager)
      Zotero.Prefs.set("extensions.jadenseInZotero.paperAnalysisHistory", savedAnalysisHistory)
      manager.document.getElementById("jadense-analysis-history-refresh").click()
      await waitFor(() => manager.document.querySelectorAll("#jadense-analysis-history .jdx-analysis-record").length === rowsBeforeClear,
        "restored analysis history after empty-state visual")
    }
    manager.document.getElementById("jadense-manager-nav-settings").click()
    manager.document.getElementById("jadense-settings-tab-features").click()
    await waitFor(() => manager.document.getElementById("jadense-feature-analysis-model-status").dataset.kind === "error", "stale analysis model error")
    assert(manager.document.getElementById("jadense-feature-analysis-model-status").textContent.includes("已删除或配置不完整"), "Stale analysis model did not fail closed")
    await screenshot("manager-analysis-config-error", manager)
    toolbarButton("analyze").click()
    await waitFor(() => manager.document.getElementById("jadense-analysis-status").dataset.kind === "error", "stale BYOK analysis rejection")
    assert(analysisState().records.length === historyBeforeByokAnalysis && JSON.stringify(localState()) === chatBeforeByokAnalysis,
      "Stale BYOK analysis wrote history or Chat")

    manager.document.getElementById("jadense-manager-nav-settings").click()
    manager.document.getElementById("jadense-settings-tab-features").click()
    const analysisModelSelect = manager.document.getElementById("jadense-feature-analysis-model")
    analysisModelSelect.querySelector(".jdx-select-trigger").click()
    const analysisModelOption = Array.from(analysisModelSelect.querySelectorAll('[role="option"]'))
      .find((option) => option.textContent.includes("Synthetic Model") && option.textContent.includes("Synthetic Provider"))
    assert(analysisModelOption, "Analysis configuration does not list the saved Provider / model")
    analysisModelOption.click()
    await waitFor(() => JSON.parse(Zotero.Prefs.get("extensions.jadenseInZotero.paperAnalysisModel")).modelId === selectedAnalysisModel.id
      && manager.document.getElementById("jadense-feature-analysis-model-status").dataset.kind === "idle", "independent analysis model selection")
    assert(Zotero.Prefs.get("extensions.jadenseInZotero.aiRoute") === globalRouteBeforeAnalysis
      && Zotero.Prefs.get("extensions.jadenseInZotero.byokConfig") === globalByokBeforeAnalysis,
    "Independent analysis model selection changed Chat route or active BYOK settings")
    await screenshot("manager-analysis-config-light", manager)
    themeToggle.click()
    await screenshot("manager-analysis-config-dark", manager)
    themeToggle.click()
    manager.document.getElementById("jadense-manager-nav-analysis").click()
    await screenshot("manager-analysis-history-light", manager)
    themeToggle.click()
    await screenshot("manager-analysis-history-dark", manager)
    themeToggle.click()
    manager.resizeTo(760 + settingsChromeWidth, 620 + settingsChromeHeight)
    await waitFor(() => manager.innerWidth === 760 && manager.innerHeight === 620, "compact analysis viewport")
    await screenshot("manager-analysis-history-compact", manager)
    manager.document.getElementById("jadense-manager-nav-settings").click()
    manager.document.getElementById("jadense-settings-tab-features").click()
    await screenshot("manager-analysis-config-compact", manager)
    manager.resizeTo(1360 + settingsChromeWidth, 860 + settingsChromeHeight)
    await waitFor(() => manager.innerWidth === 1360 && manager.innerHeight === 860, "restored analysis viewport")
    manager.document.getElementById("jadense-manager-nav-analysis").click()
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
    manager.document.getElementById("jadense-manager-nav-chat").click()
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
        const node = markdownNode(role)
        const body = node?.querySelector(".jdx-chat-message-body")
        assert(body, `Missing rendered ${role} Markdown: ${JSON.stringify({ saved: messages().filter(message => message.role === role && message.text === config.markdown[role]).map(message => message.id), dom: Array.from(manager.document.querySelectorAll(".jdx-chat-message")).map(item => ({ id: item.dataset.messageId, role: item.dataset.role, text: item.textContent.slice(0, 80) })) })}`)
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
        && manager.document.querySelectorAll("#jadense-analysis-history .jdx-analysis-record").length >= 1,
      "Ordinary Chat leaked analysis cards or displaced independent analysis history")
    }
    verifyMarkdown()
    report.checks.push("user-and-assistant-markdown", "markdown-lists-code-tables-links", "markdown-literal-html-and-safe-links", "markdown-original-source-preserved", "markdown-paragraph-and-list-spacing")

    await stage("markdown-history-reload")
    const documentBeforeReload = manager.document
    manager.location.reload()
    await waitFor(() => manager.document !== documentBeforeReload && markdownNode("assistant")?.querySelector("table"), "Markdown history after Manager reload")
    const researchAfterReload = await waitFor(() => manager.document.querySelector(`[data-session-id="${sessionBeforeControls}"]`), "research conversation after Manager reload")
    researchAfterReload.click()
    await waitFor(() => !manager.document.getElementById("jadense-manager-section-chat").hidden && currentSession()?.id === sessionBeforeControls, "Chat after Manager reload")
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
        const actionToggle = readerDoc.querySelector(".jadense-reader-actions-toggle")
        assert(actionToggle?.getBoundingClientRect().width > 0, "Compact Reader lacks its reading actions toggle")
        actionToggle.click()
        assert(actionToggle.getAttribute("aria-expanded") === "true", "Compact reading actions did not open")
        await screenshot("reader-action-menu-compact")
        reader.setColorScheme("dark")
        await Zotero.Promise.delay(200)
        report.compactActionMenuDarkColors = [readerDoc.querySelector("[data-jadense-action-menu]"), toolbarButton("fullTranslate")].map((element) => {
          const style = reader._iframeWindow.getComputedStyle(element)
          return { label: element.getAttribute("aria-label"), color: style.color, background: style.backgroundColor }
        })
        await screenshot("reader-action-menu-compact-dark")
        actionToggle.click()
        assert(actionToggle.getAttribute("aria-expanded") === "false", "Compact reading actions did not close")
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

    await stage("reader-simplified-toolbar-reopen")
    // report 的 chars 等早期原生诊断对象也属于旧 Reader；在关闭前将它们固化为普通 JSON。
    Object.assign(report, JSON.parse(JSON.stringify(report)))
    // 关闭后的 PDFView 是 Gecko dead object；先释放诊断引用，避免掩盖重开阶段的原始错误。
    view = undefined
    reader.close()
    await waitFor(() => !Zotero.Reader._readers.includes(reader), "closed synthetic reader")
    await stage("reader-simplified-toolbar-reopening")
    reader = await Zotero.Reader.open(attachment.id)
    await reader._initPromise
    view = reader._internalReader._primaryView
    await waitFor(() => reader._iframeWindow.document.querySelector('[data-jadense-action="fullTranslate"]'), "simplified toolbar after reader reopen")
    assert(!reader._iframeWindow.document.querySelector('[data-jadense-article-languages], [data-jadense-action="references"], [data-jadense-reader-tools="renderToolbar"] [data-jadense-action="translate"], [data-jadense-action-menu] [data-jadense-action="translate"]'), "Reopened Reader restored removed toolbar entries")
    assert(JSON.parse(Zotero.Prefs.get(articlePreferenceKey, true)).targetLanguage === "de", "Reader reopen lost legacy article language preference")
    await screenshot("reader-simplified-toolbar-reopened")
    report.checks.push("legacy-article-language-inherited-by-next-selection", "legacy-article-language-reader-reopen")

    report.annotationCount = 2
    await stage("chat-image-upload-and-reload")
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
    manager.document.querySelector(`[data-session-id="${questionSessionId}"]`).click()
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
    manager.document.querySelector(`[data-session-id="${uploadSessionID}"]`).click()
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
    }
    await stage("document-research-042")
    await verifyCompactReaderToolbar()
    Zotero.Prefs.set("extensions.jadenseInZotero.translationModel", JSON.stringify({ route: "jadense", selection: { kind: "model", modelId: "synthetic-platform-model" } }))
    const jobs = Zotero.__jadenseDocumentJobs
    assert(jobs, "Plugin lifecycle did not own the document jobs")
    if (config.literatureOnly) {
      await verifyLiteratureWorkspace({ Zotero, reader, jobs, assert, waitFor, screenshot, report, findManager })
      report.state = 'passed'; report.stage = 'complete'; await persist(); return
    }
    if (config.ocrOnly) {
      await verifyOCRTranslation({ Zotero, reader, jobs, assert, waitFor, screenshot, report })
      report.state = 'passed'; report.stage = 'complete'; await persist(); return
    }
    if (config.translationPapers) {
      await verifyTranslationPapers({ Zotero, jobs, directory: config.translationPapers, report, assert })
      report.state = 'passed'; report.stage = 'complete'; await persist(); return
    }
    if (config.sidebarOnly) {
      await verifyTranslationSidebar({ Zotero, reader, jobs, assert, waitFor, screenshot, report, findManager })
      report.state = 'passed'; report.stage = 'complete'; await persist(); return
    }
    let fullTask
    if (!config.analysisOnly) {
      const result = await verifyTranslationSidebar({ Zotero, reader, jobs, assert, waitFor, screenshot, report, findManager })
      fullTask = result.task
    }
    await stage("references-042")
    const referenceAttachment = await Zotero.Attachments.importFromFile({ file: config.referencePdfPath, parentItemID: parent.id, contentType: "application/pdf" })
    Zotero.Prefs.set("extensions.jadenseInZotero.paperAnalysisModel", JSON.stringify({ route: "byok", modelId: "unconfigured-fixture" }))
    const NativeSearch = Zotero.Translate.Search
    let lookupCount = 0
    Zotero.Translate.Search = class {
      setIdentifier() {}
      async getTranslators() { return [{}] }
      setTranslator() {}
      async translate(options) {
        assert(options.libraryID === false && options.saveAttachments === false, "Verification attempted a library write")
        lookupCount++
        return [{ title: "Reliable scientific evidence", DOI: "10.1234/evidence", date: "2020", creators: [{ firstName: "J.", lastName: "Smith", creatorType: "author" }], itemType: "journalArticle" }]
      }
    }
    try {
      const task = await jobs.start("references", referenceAttachment.id)
      await jobs.idle()
      let entries = await jobs.store.references(task.id)
      assert(entries.length === 3 && entries.map(row => row.label).join(",") === "1,2,3", `Reference source coverage failed: ${JSON.stringify(entries)}`)
      assert(entries[0].verification === "verified" && entries[2].verification === "verified" && entries[1].verification === "unverified", "Reference verification statuses are wrong")
      assert(lookupCount === 1, "Successful DOI query was not cached")
      const historyKey = "extensions.jadenseInZotero.paperAnalysisHistory"
      const previousRecords = JSON.parse(Zotero.Prefs.get(historyKey) || '{"records":[]}').records
      Zotero.Prefs.set(historyKey, JSON.stringify({ version: 1, records: [{ id: 'analysis-detail-fixture', createdAt: new Date().toISOString(), source: { ...task.source, authors: ['J. Smith', 'L. Chen'], title: 'Reliable scientific evidence: methods, findings and limitations', year: '2020', publicationTitle: 'Research Journal' }, referenceTaskID: task.id, summary: '## Research overview\n\nThis study examines **reliable scientific evidence** using a controlled comparison. The findings connect the observed treatment response to the design of the experiment.\n\n### Main findings\n\n- The controlled comparison identifies a consistent improvement.\n- The small sample limits generalization to other populations.\n\n### Reading perspective\n\nReview the source passages and methods before applying these results.', notes: '文献解析（AI 辅助，请核对原文）\n\n总体概述\nA controlled comparison identifies a consistent improvement.\n\n关键句与批注（2 条）\n\n【创新点】第 1 页\n原句：Our method improves the controlled outcome.\nAI 批注：The comparison provides evidence for a measurable improvement within the study design.\n\n【局限性】第 2 页\n原句：The sample is restricted to a single population.\nAI 批注：The sampling restriction limits external validity. Broader populations require independent evaluation.' }, ...previousRecords] }))
      const refReader = Zotero.Reader._readers.find(value => value.itemID === referenceAttachment.id)
      const refButton = refReader._iframeWindow.document.querySelector('[data-jadense-action="analyze"]')
      assert(refButton && !refReader._iframeWindow.document.querySelector('[data-jadense-action="references"]'), "References were not consolidated under literature analysis"); refButton.click()
      manager = await waitFor(findManager, "reference Manager")
      // 先验证 Reader 失败仍保留已有结果，再重载按历史浏览，截图不带本次失败的临时状态。
      await waitFor(() => manager.document.querySelector('.jdx-analysis-summary strong'), 'previous result after failed analysis')
      const beforeDetailReload = manager.document
      manager.location.reload()
      await waitFor(() => manager.document !== beforeDetailReload && manager.receiveJadenseContext && manager.document.querySelector('.jdx-analysis-title'), 'history-only detail reload')
      manager.document.getElementById('jadense-manager-nav-analysis').click()
      Array.from(manager.document.querySelectorAll('.jdx-analysis-title')).find(button => button.textContent.includes('methods, findings')).click()
      const referenceTab = await waitFor(() => manager.document.querySelector('.jdx-analysis-detail:not([hidden]) [id$="-tab-references"]'), "single-paper reference tab")
      referenceTab.click()
      await waitFor(() => manager.document.querySelectorAll(".jdx-reference-row").length === 3, "reference result rows")
      const staticRow = manager.document.querySelector('[data-verification="unverified"]')
      assert(staticRow && Array.from(staticRow.querySelectorAll("button")).some(button => /定位原文|Locate original/.test(button.textContent)), "Unverified reference lost source navigation")
      assert(Array.from(staticRow.querySelectorAll("button")).some(button => /搜索文献|Search publication/.test(button.textContent)), "Unverified reference lost publication search")
      assert(!Array.from(staticRow.querySelectorAll("input")).some(input => !input.hidden && !input.disabled), "Unmatched reference enabled import selection")
      await screenshot("references-verified-and-static", manager)
      const rawBefore = entries.map(row => row.raw).join("\n")
      const siblingAttachment = await Zotero.Attachments.importFromFile({ file: config.pdfPath, parentItemID: parent.id, contentType: 'application/pdf' })
      await verifyAnalysisDetails({ manager, Zotero, task, jobs, assert, waitFor, screenshot, report, language: config.appearanceLanguage || 'zh-CN', sibling: { itemID: siblingAttachment.id, libraryID: siblingAttachment.libraryID, itemKey: siblingAttachment.key } })
      assert(lookupCount === 1, 'Browsing or importing redispatched reference verification')
      entries = await jobs.store.references(task.id)
      assert(entries.length === 3 && entries.map(row => row.raw).join("\n") === rawBefore, "Import changed the original reference list")
      assert(entries[0].imported?.itemID && entries[0].imported.itemID === entries[2].imported?.itemID && !entries[1].imported, `Verified-only import and duplicate detection failed: ${JSON.stringify(entries)}`)
      const saved = Zotero.Items.get(entries[0].imported.itemID)
      assert(saved.getField("DOI") === "10.1234/evidence" && saved.getAttachments().length === 0, "Metadata import changed DOI or downloaded an attachment")
      // 从同一 Manager 刷新后再次接收阅读器动作，不能开出第二个工作台或调用旧内层窗口。
      const previousDocument = manager.document
      manager.location.reload()
      await waitFor(() => manager.document !== previousDocument && manager.receiveJadenseContext && manager.document.querySelector(".jdx-reading-preferences"), "reloaded Manager action receiver")
      refButton.click()
      const reloadedReferenceTab = await waitFor(() => manager.document.querySelector('.jdx-analysis-detail:not([hidden]) [id$="-tab-references"]'), "reloaded single-paper reference tab")
      reloadedReferenceTab.click()
      await waitFor(() => manager.document.querySelectorAll(".jdx-reference-row").length === 3, "references after Manager reload")
      assert(findManagers().length === 1, "Reader opened a duplicate Manager after reload")
      if (config.analysisOnly) { report.state = 'passed'; report.stage = 'complete'; await persist(); return }
      manager.document.getElementById("jadense-manager-nav-settings").click()
      manager.document.getElementById("jadense-settings-tab-general").click()
      const readingControls = manager.document.querySelector("#jadense-settings-panel-general .jdx-manager-settings-card .jdx-reading-preferences")
      assert(readingControls && readingControls.querySelectorAll(".jdx-reading-preference-row").length === 3, "New reading preferences are outside the General settings card")
      const sizeInput = readingControls.querySelector("input[data-jdx-font-size]")
      const opacityInput = readingControls.querySelector("input[data-jdx-translation-opacity]")
      const styleControl = readingControls.querySelector("[data-jdx-translation-style]")
      assert(sizeInput && opacityInput && styleControl?.querySelector(".jdx-select-trigger"), "General reading preferences lack the existing styled controls")
      await Promise.resolve(Zotero.Utilities.Internal.openPreferences("jadense-in-zotero-preferences"))
      const preferences = await waitFor(() => findWindowContaining("jadense-in-zotero-preferences-pane"), "document native Preferences")
      const preferenceRoot = preferences.document.getElementById("jadense-in-zotero-preferences-pane")
      await waitFor(() => preferenceRoot.querySelector('.jdx-reading-preferences input[type="number"]'), "native font preference")
      const nativeOpacity = preferenceRoot.querySelector("input[data-jdx-translation-opacity]")
      assert(nativeOpacity?.closest('[data-settings-section="general"]'), "Native opacity setting is outside General")
      styleControl.querySelector(".jdx-select-trigger").click()
      styleControl.querySelectorAll('[role="option"]')[1].click()
      opacityInput.value = "65"; opacityInput.dispatchEvent(new manager.Event("input", { bubbles: true }))
      await waitFor(() => nativeOpacity.value === "65", "shared General opacity across settings")
      assert(preferenceRoot.querySelector("[data-jdx-translation-opacity-value]").textContent === "65%"
        , "Style or transparency label failed to synchronize")
      nativeOpacity.value = "30"; nativeOpacity.dispatchEvent(new preferences.Event("input", { bubbles: true }))
      await waitFor(() => opacityInput.value === "30" && readingControls.querySelector("[data-jdx-translation-opacity-value]").textContent === "30%", "native opacity updates Manager")
      for (const theme of ["light", "dark"]) {
        Zotero.Prefs.set("extensions.jadenseInZotero.theme", theme, true)
        for (const size of [12, 13, 18, 24]) {
          sizeInput.value = String(size); sizeInput.dispatchEvent(new manager.Event("change", { bubbles: true }))
          await Zotero.Promise.delay(120)
          assert(preferenceRoot.querySelector('input[type="number"]').value === String(size), "Native Preferences font control is stale")
          assert(Math.abs(parseFloat(manager.getComputedStyle(manager.document.documentElement).fontSize) - size) < .1, "Manager font is stale")
          const card = readingControls.closest(".jdx-manager-settings-card").getBoundingClientRect()
          for (const control of [sizeInput, opacityInput, styleControl]) {
            const bounds = control.getBoundingClientRect()
            assert(bounds.width > 0 && bounds.left >= card.left && bounds.right <= card.right + 1,
              "General reading control escaped its card at font size " + size)
          }
          await screenshot(`document-general-${config.appearanceLanguage || "zh-CN"}-${theme}-${size}`, manager)
          if (size === 24) await screenshot(`document-native-general-${theme}-${size}`, preferences)
        }
      }
      Zotero.Prefs.set("extensions.jadenseInZotero.fontSize", "13", true); preferences.close()
      report.checks.push("references-native-text-order-duplicates", "references-zero-write-lookup", "references-success-cache", "references-unverified-static-dom", "references-batch-verification-guard", "references-native-import-and-doi-dedup", "references-source-retained-after-import")
      report.checks.push("references-manager-reload-reuses-window", "font-shared-manager-native-preferences")
      report.checks.push("reading-preferences-integrated-general-card", "reading-preferences-styled-controls", "opacity-shared-manager-native-floating", "references-within-literature-analysis")
    } finally { Zotero.Translate.Search = NativeSearch }
    await stage("semantic-full-translation")
    const semanticAttachment = await Zotero.Attachments.importFromFile({ file: config.translationPdfPath, parentItemID: parent.id, contentType: "application/pdf" })
    const semanticReader = await Zotero.Reader.open(semanticAttachment.id)
    await semanticReader._initPromise
    const semanticDoc = semanticReader._iframeWindow.document
    const semanticButton = await waitFor(() => semanticDoc.querySelector('[data-jadense-action="fullTranslate"]'), "semantic full translation entry")
    semanticButton.click()
    const semanticRoot = await waitFor(() => Zotero.getMainWindow().document.querySelector(`.jdx-reader-workspace[data-reader-item="${semanticAttachment.id}"]`), "semantic translation sidebar")
    const semanticStart = semanticRoot.querySelector('.jdx-reader-translation-confirmation button')
    assert(semanticStart, "Semantic full translation confirmation is missing")
    await waitFor(() => !jobs.list("translation").some(row => row.source.itemID === semanticAttachment.id), "semantic translation confirmation before dispatch")
    semanticStart.click()
    report.semanticOpen = { itemID: semanticAttachment.id, tab: semanticReader.tabID, window: semanticReader._window.document.URL, text: semanticDoc.body.textContent.slice(-1800), tasks: jobs.list('translation').map(task => ({ itemID: task.source.itemID, status: task.status })), roots: Array.from(Zotero.getMainWindow().document.querySelectorAll('.jdx-reader-workspace')).map(root => ({ item: root.dataset.readerItem, text: root.textContent.slice(0, 700) })) }
    const semanticTask = await waitFor(() => jobs.list("translation").find(row => row.source.itemID === semanticAttachment.id), "semantic task")
    await waitFor(() => semanticTask.status === "complete", "semantic translation completion")
    const sourcePage = await jobs.store.page(semanticTask.id, 0), nextPage = await jobs.store.page(semanticTask.id, 1)
    report.semanticSource = { pages: [sourcePage, nextPage].map(page => ({ viewBox: page.viewBox, paragraphs: page.paragraphs, excludedLines: page.excludedLines })) }
    assert(sourcePage.excludedLines.some(line => line.text.includes("Article")), "Native Article header was retained in translation")
    const continued = sourcePage.paragraphs.find(row => row.text.startsWith("A complete scientific"))
    assert(continued?.text.includes("ends with its complete conclusion.") && continued.locations.length === 2, "Native cross-column/page argument was split")
    const semanticBody = await waitFor(() => semanticRoot.querySelector('.jdx-reading-body'), "semantic continuous prose")
    assert(!semanticBody.querySelector('button,details'), "Semantic prose contains source controls")
    await screenshot("semantic-full-complete", Zotero.getMainWindow())
    report.checks.push("full-native-header-removal", "full-native-cross-column-page-paragraph", "full-semantic-continuous-layout")
    report.assistantMessages = completed().length
    if (config.documentRestart) {
      // 只修改合成任务：保留前面成果，模拟最后一个请求尚未完成时进程退出。
      const page = await jobs.store.page(fullTask.id, fullTask.totalPages - 1)
      delete page.translations[page.pieces.at(-1).id]
      await jobs.store.savePage(fullTask.id, page)
      fullTask.completed--; fullTask.status = "running"; await jobs.store.save(fullTask)
    }
    report.state = "passed"
    report.stage = "complete"
    await persist()
  } catch (error) {
    report.state = "failed"
    report.error = `${String(error)}\n${error?.stack || ""}`
    report.managerStatus = manager?.document?.getElementById("jadense-chat-status")?.textContent ?? ""
    report.analysisStatus = manager?.document?.getElementById("jadense-analysis-status")?.textContent ?? ""
    report.documentUI = Zotero.getMainWindow()?.document.querySelector(".jdx-reader-workspace")?.textContent
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
    verifyReaderChat.toString(),
    verifyMachineTranslation.toString(),
    verifyOCRTranslation.toString(),
    verifyLiteratureWorkspace.toString(),
    verifyAnalysisDetails.toString(),
    verifyTranslationSidebar.toString(),
    verifyTranslationPapers.toString(),
    runHarness.toString(),
    "function startup() { void runHarness(SMOKE_CONFIG, verifyAnalysisDetails, verifyTranslationSidebar, verifyTranslationPapers, verifyReaderChat).catch(error => Zotero.logError(error)); }",
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
  const referencePdfPath = path.join(smokeRoot, "synthetic-references.pdf")
  const translationPdfPath = path.join(smokeRoot, "synthetic-translation.pdf")
  const extensionsDir = path.join(profileDir, "extensions")
  const stub = await startStub()
  let child
  let stdout
  let stderr
  let passed = false
  try {
    await mkdir(extensionsDir, { recursive: true })
    await mkdir(dataDir, { recursive: true })
    const ocrRuntime = argValue(argv, '--ocr-runtime')
    if (ocrRuntime) {
      // 仅复用用户显式指定的测试环境，不能把此快速复测记为首次安装验收。
      const runtime = await realpath(ocrRuntime)
      await mkdir(path.join(profileDir, 'jadense-ocr'), { recursive: true })
      await symlink(runtime, path.join(profileDir, 'jadense-ocr', 'v1'), process.platform === 'win32' ? 'junction' : 'dir')
    }
    await writeFile(pdfPath, createResearchFixturePdf())
    await writeFile(referencePdfPath, createResearchFixturePdf(true))
    await writeFile(translationPdfPath, createResearchFixturePdf(false, true))
    await copyFile(upgradeFrom ? path.resolve(upgradeFrom) : artifact, path.join(extensionsDir, `${pluginID}.xpi`))
    const upgradeXpi = upgradeFrom ? path.join(smokeRoot, "upgrade.xpi") : undefined
    if (upgradeXpi) await copyFile(artifact, upgradeXpi)
    const companionConfig = {
      pluginID, profileDir, dataDir, pdfPath, referencePdfPath, translationPdfPath, reportPath, origin: stub.origin, upgradeXpi,
      translationPapers: argValue(argv, '--translation-papers') ? path.resolve(argValue(argv, '--translation-papers')) : undefined,
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
      machineOnly: argv.includes('--machine-only'), machineLive: argv.includes('--machine-live'),
      literatureOnly: argv.includes('--literature-only'), ocrOnly: argv.includes('--ocr-only'), chatSidebarOnly: argv.includes("--chat-sidebar-only"), shellOnly: argv.includes("--shell-only"), screenshots: argv.includes("--screenshots"), screenshotDir: smokeRoot, appearanceLanguage, documentsOnly: argv.includes("--documents-only"), analysisOnly: argv.includes("--analysis-only"), sidebarOnly: argv.includes("--sidebar-only"), documentRestart: argv.includes("--document-restart"), glassProbe: argv.includes("--glass-probe"),
    }
    await writeCompanion(extensionsDir, companionConfig)
    await writeFile(path.join(profileDir, "user.js"), [
      'user_pref("extensions.autoDisableScopes", 0);',
      'user_pref("extensions.enabledScopes", 15);',
      'user_pref("extensions.update.enabled", false);',
      'user_pref("intl.locale.requested", "zh-CN");',
      ...(argValue(argv, "--display-scale") === "1.5" ? ['user_pref("layout.css.devPixelsPerPx", "1.5");'] : []),
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
    if (argv.includes("--document-restart")) {
      const requestsBefore = stub.requests.filter(row => row.kind === "full-translation").length
      await stopIsolatedProcess(child, profileDir)
      const resumeReportPath = path.join(smokeRoot, "document-restart-report.json")
      await writeCompanion(extensionsDir, { ...companionConfig, resumeOnly: true, upgradeXpi: undefined, reportPath: resumeReportPath })
      child = spawn(executable, ["-no-remote", "-profile", profileDir, "-datadir", dataDir, "-ZoteroDebugText"], { windowsHide: true, stdio: ["ignore", stdout.fd, stderr.fd] })
      const resumeDeadline = Date.now() + 60_000
      let resumed
      while (Date.now() < resumeDeadline) {
        resumed = await readFile(resumeReportPath, "utf8").then(JSON.parse).catch(() => undefined)
        if (resumed?.state === "failed") throw new Error(resumed.error)
        if (resumed?.state === "passed") break
        await delay(250)
      }
      if (resumed?.state !== "passed") throw new Error("Native document restart timed out")
      if (stub.requests.filter(row => row.kind === "full-translation").length !== requestsBefore + 1) throw new Error("Native resume redispatched completed chunks")
      report.checks.push(...resumed.checks)
    }
    if (stub.failures.length) throw new Error(stub.failures.join("\n"))
    if (!argv.includes("--shell-only") && !argv.includes("--chat-sidebar-only") && !appearanceLanguage && !argv.includes("--documents-only") && (stub.requests.filter((request) => request.kind === "upload-metadata").length !== 2
      || stub.requests.filter((request) => request.kind === "upload-pdf").length !== 1)) {
      throw new Error("Expected two metadata uploads and exactly one multipart PDF; missing or disabled PDFs must not dispatch files")
    }
    if (!argv.includes("--shell-only") && !argv.includes("--chat-sidebar-only") && !appearanceLanguage && !argv.includes("--documents-only") && (stub.requests.filter((request) => request.kind === "analysis-jadense").length !== 3
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
    if (!argv.includes("--shell-only") && !argv.includes("--chat-sidebar-only") && !appearanceLanguage && !argv.includes("--documents-only")) report.checks.push("markdown-no-automatic-network-resources")
    await writeFile(reportPath, JSON.stringify(report, null, 2))
    await writeFile(path.join(smokeRoot, "request-summary.json"), JSON.stringify(stub.requests, null, 2))
    passed = true
    if (argv.includes("--hold-open")) { console.log(`Isolated Manager held open: ${smokeRoot}`); await delay(900_000) }
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
