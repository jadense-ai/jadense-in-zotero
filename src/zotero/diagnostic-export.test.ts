/** 导出失败不得伪报成功或继续写其他路径；原生菜单负责显示恢复指引。 */
import { expect, it, vi } from 'vitest'
import { saveDiagnosticExport } from './diagnostics-panel'
it('propagates a local export write failure to the caller without retrying', async () => {
  class FilePicker { modeSave = 1; returnCancel = 1; defaultString = ''; defaultExtension = ''; file = 'synthetic.json'; init() {} appendFilter() {} async show() { return 0 } }
  const writeUTF8 = vi.fn(async () => { throw new Error('synthetic disk failure') })
  await expect(saveDiagnosticExport({} as Window, '{}', { ChromeUtils: { importESModule: () => ({ FilePicker }) }, IOUtils: { writeUTF8 } })).rejects.toThrow('synthetic disk failure')
  expect(writeUTF8).toHaveBeenCalledTimes(1)
})
