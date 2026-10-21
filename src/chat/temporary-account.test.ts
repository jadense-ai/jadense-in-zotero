/** 账户身份由已鉴权服务端提供；换令牌不换任务，换账户必须隔离。 */
import { expect, it, vi } from 'vitest'
import { resolveTemporaryAccount } from './temporary-account'
import { requestHash } from './temporary-request-store'

it('keeps one owner across token renewal but separates another owner and server', async () => {
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Response(null, { headers: {
    'x-jadense-temporary-protocol': '1',
    'x-jadense-temporary-account': String(new Headers(init?.headers).get('authorization')).includes('other') ? 'owner-b' : 'owner-a',
  } }))
  const before = await resolveTemporaryAccount({ baseUrl: 'https://account.test/', token: 'before', fetchImpl })
  expect(await resolveTemporaryAccount({ baseUrl: 'https://account.test', token: 'after', fetchImpl })).toEqual(before)
  expect(await resolveTemporaryAccount({ baseUrl: 'https://account.test', token: 'other', fetchImpl })).not.toEqual(before)
  expect(await resolveTemporaryAccount({ baseUrl: 'https://another.test', token: 'after', fetchImpl })).not.toEqual(before)
  expect(before.verified).toBe(true)
})

it('keeps legacy token-scoped identity without inventing verified ownership', async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { headers: { 'x-jadense-temporary-protocol': '1' } }))
  expect(await resolveTemporaryAccount({ baseUrl: 'https://old.test', token: 'synthetic', fetchImpl })).toEqual({
    account: await requestHash('https://old.test\nsynthetic'), verified: false,
  })
})

it('does not turn an authorization failure or offline probe into another account', async () => {
  await expect(resolveTemporaryAccount({ baseUrl: 'https://denied.test', token: 'synthetic',
    fetchImpl: async () => Response.json({ error: 'denied' }, { status: 401 }) })).rejects.toMatchObject({ status: 401 })
  await expect(resolveTemporaryAccount({ baseUrl: 'https://offline.test', token: 'synthetic',
    fetchImpl: async () => { throw new TypeError('offline') } })).rejects.toThrow('offline')
})
