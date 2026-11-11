import { describe, expect, it } from 'vitest'
import { messengerRoleIds, messengerRoles } from '../src/messenger-roles.js'
import { messengerRoleIds as wakeMoveRoleIds } from '../../../scripts/messenger/wake-move.mjs'

describe('messenger roles', () => {
  it('defaults to the naia role when NAIA_MESSENGER_ROLES is unset or blank', () => {
    expect(messengerRoles({})).toEqual([{ id: 'naia', label: '나이아' }])
    expect(messengerRoleIds({ NAIA_MESSENGER_ROLES: '  ' })).toEqual(['naia'])
  })
  it('reads id or id:label, drops bad ids and duplicates', () => {
    const env = { NAIA_MESSENGER_ROLES: 'coder:코더, reviewer ,Bad,1x,coder:again,a b,ops:운영:팀' }
    expect(messengerRoles(env)).toEqual([
      { id: 'coder', label: '코더' },
      { id: 'reviewer', label: 'reviewer' },
      { id: 'ops', label: '운영:팀' },
    ])
  })
  it('falls back to naia with one warning when every entry is invalid', () => {
    const warnings: string[] = []
    const env = { NAIA_MESSENGER_ROLES: 'Coder,리뷰어' }
    expect(messengerRoles(env, (line) => warnings.push(line))).toEqual([{ id: 'naia', label: '나이아' }])
    expect(messengerRoleIds(env, (line) => warnings.push(line))).toEqual(['naia'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/NAIA_MESSENGER_ROLES/)
    const moveWarnings: string[] = []
    expect(wakeMoveRoleIds(env, (line: string) => moveWarnings.push(line))).toEqual(['naia'])
    expect(moveWarnings).toHaveLength(1)
  })
  it('wake-move reads the same ids as the server', () => {
    const quiet = () => {}
    for (const raw of ['', 'coder:코더, reviewer ,Bad,1x,coder:again,a b,ops:운영:팀', 'Bad,1x']) {
      const env = { NAIA_MESSENGER_ROLES: raw }
      expect(wakeMoveRoleIds(env, quiet)).toEqual(messengerRoleIds(env, quiet))
    }
  })
})
