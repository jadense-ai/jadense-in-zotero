/** 邀请仅依据本机行为，覆盖跨日冷却、重启持久化及可选存储故障。 */
import { describe, expect, it, vi } from 'vitest'
import type { ZoteroLike } from './runtime'
import { readStarInvitation, recordStarInvitationUse, STAR_INVITATION_PREF, starInvitationDue } from './star-invitation'

function fixture() {
  const values = new Map<string, unknown>()
  const host = { Prefs: { get: (key: string) => values.get(key), set: (key: string, value: unknown) => { values.set(key, value) }, clear: (key: string) => { values.delete(key) } } } satisfies ZoteroLike
  return { host, values }
}

describe('local Star invitation', () => {
  it('counts successful uses to five and survives a new host instance', () => {
    const { host } = fixture()
    for (let i = 0; i < 4; i++) recordStarInvitationUse(host)
    expect(starInvitationDue(readStarInvitation(host))).toBe(false)
    recordStarInvitationUse(host)
    expect(starInvitationDue(readStarInvitation({ ...host }))).toBe(true)
    expect(readStarInvitation(host)?.uses).toBe(5)
  })
  it('requires 24 hours as well as a different local date, and tolerates clock rollback', () => {
    const lastPrompt = new Date(2026, 8, 12, 23, 59).getTime()
    const state = { uses: 5, lastPrompt, outcome: 'later' as const }
    expect(starInvitationDue(state, lastPrompt - 1000)).toBe(false)
    expect(starInvitationDue(state, lastPrompt + 120_000)).toBe(false)
    expect(starInvitationDue(state, lastPrompt + 86_400_000)).toBe(true)
  })
  it.each(['confirmed', 'likely'])('never repeats for %s, including after restart', outcome => {
    const { host, values } = fixture()
    values.set(STAR_INVITATION_PREF, JSON.stringify({ uses: 5, lastPrompt: 1, outcome, additive: true }))
    recordStarInvitationUse(host)
    expect(starInvitationDue(readStarInvitation({ ...host }))).toBe(false)
    expect(readStarInvitation(host)?.outcome).toBe(outcome)
  })
  it('contains missing, corrupt, and throwing preference storage', () => {
    const { host, values } = fixture()
    values.set(STAR_INVITATION_PREF, '{broken')
    expect(readStarInvitation(host)).toBeNull()
    expect(() => recordStarInvitationUse(host)).not.toThrow()
    expect(() => recordStarInvitationUse({})).not.toThrow()
    host.Prefs.get = vi.fn(() => { throw new Error('unavailable') })
    expect(() => recordStarInvitationUse(host)).not.toThrow()
    host.Prefs.get = () => undefined
    host.Prefs.set = () => { throw new Error('disk full') }
    expect(() => recordStarInvitationUse(host)).not.toThrow()
  })
})
