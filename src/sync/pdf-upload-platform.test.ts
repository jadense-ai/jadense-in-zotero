import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { portableSha256, uploadFileSha256, uploadRequestId } from './pdf-upload-platform'
describe('upload host hashing', () => {
  it.each([0,3,55,56,63,64,65,129,1024])('matches SHA-256 for %i bytes including padding boundaries', size => {
    const bytes = Uint8Array.from({ length:size },(_,i)=>i%251)
    expect(portableSha256(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'))
  })
  it('uploads without subtle and binds host UUID', async () => {
    expect(await uploadFileSha256(new Blob(['abc']),{})).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    const crypto = { randomUUID() { expect(this).toBe(crypto); return 'host-id' } }
    expect(uploadRequestId({ crypto:crypto as unknown as Crypto })).toBe('host-id')
  })
})
