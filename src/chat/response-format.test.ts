/** 输出回执的本地脱敏投影；附加字段可读取但绝不进入诊断。 */
import { expect, it } from 'vitest'
import { structuredResponseReceipt } from './response-format'

it('records actual modes and hashes without retaining content or arbitrary reasons', () => {
  const schemaHash = `sha256:${'a'.repeat(64)}`
  expect(structuredResponseReceipt({ requestedMode: 'json-schema', effectiveMode: 'json-object', fallbackReason: 'protocol-rejection', schemaHash, schema: { secret: 'paper' }, text: 'paper' }, { effectiveThinkingEnabled: false })).toEqual({
    requestedOutputMode: 'json-schema', effectiveOutputMode: 'json-object', outputFallbackReason: 'protocol-rejection', outputSchemaHash: schemaHash, effectiveThinkingMode: 'disabled',
  })
  expect(structuredResponseReceipt({ requestedMode: 'paper', effectiveMode: 'paper', fallbackReason: 'paper', schemaHash: 'paper' })).toEqual({})
  expect(structuredResponseReceipt(undefined)).toEqual({})
})
