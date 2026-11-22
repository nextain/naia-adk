import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleTopNavTabs, isTopNavTabActive, mainClassForPath } from './nav-tabs.ts'

test('Matrix 메신저는 설정이 켜진 경우에만 메뉴에 표시한다', () => {
  for (const enabled of [false, null, undefined]) assert.equal(visibleTopNavTabs(true, enabled).some(tab => tab.id === 'ax-messenger'), false)
  const tab = visibleTopNavTabs(true, true).find(tab => tab.id === 'ax-messenger')!
  assert.equal(tab.href, '/ax/messenger')
  assert.equal(isTopNavTabActive(tab, '/ax/messenger/room'), true)
  assert.equal(mainClassForPath('/ax/messenger'), 'w-full')
})
