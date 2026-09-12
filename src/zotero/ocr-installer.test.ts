/** Windows PowerShell 5.1 必须完整解析中文注释后的解压及缓存配置；不下载或安装依赖。 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('ships the Windows installer with a UTF-8 BOM for direct manual execution', () => {
  const bytes = readFileSync(new URL('../../content/ocr/install.ps1', import.meta.url))
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
})

it.skipIf(process.platform !== 'win32')('keeps extraction and cache configuration executable under Windows PowerShell', () => {
  const script = fileURLToPath(new URL('../../content/ocr/install.ps1', import.meta.url)).replaceAll("'", "''")
  const output = execFileSync(`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ['-NoProfile', '-NonInteractive', '-Command',
    `$tokens=$null; $errors=$null; $ast=[System.Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$tokens,[ref]$errors); if ($errors.Count) { throw 'Installer parse failed' }; $ast.FindAll({param($node) $node -is [System.Management.Automation.Language.CommandAst]},$true) | ForEach-Object { $_.GetCommandName() }; $ast.FindAll({param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst]},$true) | ForEach-Object { $_.Left.Extent.Text }`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  expect(output).toContain('Add-Type')
  expect(output).toContain('$env:UV_CACHE_DIR')
  expect(output).toContain('$env:UV_PROJECT_ENVIRONMENT')
})
