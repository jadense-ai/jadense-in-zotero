export function formatJadenseSyncResult(result: unknown) {
  if (!result || typeof result !== "object") return String(result ?? "完成")
  const record = result as Record<string, unknown>

  if (typeof record.collectionName === "string") {
    return [
      `收藏夹：${record.collectionName}`,
      `条目总数：${record.totalCount ?? 0}`,
      `元数据已导入：${record.importedCount ?? 0}`,
      `元数据已跳过：${record.skippedCount ?? 0}`,
      `元数据失败：${record.failedCount ?? 0}`,
      `PDF 已上传：${record.pdfUploadedCount ?? 0}`,
      `PDF 已跳过：${record.pdfSkippedCount ?? 0}`,
      `PDF 失败：${record.pdfFailedCount ?? 0}`,
    ].join("\n")
  }

  return JSON.stringify(result, null, 2)
}
