/**
 * 文献解析警告的展示边界：只把本地已知抽样说明转为内部诊断信息。
 * 历史读写、任务协调器与成果界面共用此兼容规则；未知警告和实际读取/生成/保存错误保持可见。
 */
const COVERAGE_NOTICE_PATTERNS = [
  /^为控制解析长度，均匀选取 \d+\/\d+ 个可定位原句；结论仅基于这些原句。$/u,
  /^Analysis uses an evenly sampled \d+\/\d+ passages with usable coordinates; conclusions are limited to these passages\.$/u,
  /^长文献均匀抽取 \d+\/\d+ 页（包括末页），未读取全部正文。$/u,
  /^This long document was sampled evenly across \d+\/\d+ pages, including the last page\. Not all text was read\.$/u,
]

/** 按完整模板分离旧版技术说明；不把包含相同词语的真实错误当作抽样说明。 */
export function splitAnalysisWarnings(entries: readonly string[] = []): { warnings: string[]; coverageWarnings: string[] } {
  const warnings: string[] = [], coverageWarnings: string[] = []
  const normalized = Array.isArray(entries) ? entries.flatMap(value => typeof value === 'string' && value.trim() ? [value.trim()] : []) : []
  for (const entry of new Set(normalized)) {
    (COVERAGE_NOTICE_PATTERNS.some(pattern => pattern.test(entry)) ? coverageWarnings : warnings).push(entry)
  }
  return { warnings, coverageWarnings }
}

/** 新记录只显示实际警告；旧任务或直接传入的历史记录同样在展示时兼容。 */
export function analysisWarningsForDisplay(record?: { warnings?: readonly string[] }): string[] {
  return splitAnalysisWarnings(record?.warnings).warnings
}
