/** 上传结果的界面摘要；原始结果字段保持稳定，不产生新的上传请求。 */
import { getUiLocale, uiText } from "./ui-preferences"

export function formatJadenseSyncResult(result: unknown) {
  if (!result || typeof result !== "object") return String(result ?? uiText("完成", "Done"))
  const record = result as Record<string, unknown>

  if (typeof record.collectionName === "string") {
    return [
      `${uiText("收藏夹：", "Collection: ")}${record.collectionName}`,
      ...([
        ["totalCount", "条目总数", "Total items"],
        ["importedCount", "元数据已导入", "Metadata imported"],
        ["skippedCount", "元数据已跳过", "Metadata skipped"],
        ["failedCount", "元数据失败", "Metadata failed"],
        ["pdfUploadedCount", "PDF 已上传", "PDFs uploaded"],
        ["pdfSkippedCount", "PDF 已跳过", "PDFs skipped"],
        ["pdfFailedCount", "PDF 失败", "PDFs failed"],
      ] as const).map(([key, zh, en]) => `${uiText(zh, en)}${uiText("：", ": ")}${new Intl.NumberFormat(getUiLocale()).format(Number(record[key] ?? 0))}`),
    ].join("\n")
  }

  return JSON.stringify(result, null, 2)
}
