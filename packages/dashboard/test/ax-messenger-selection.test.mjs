import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadSelectedMessages } from '../app/ax/messenger/selection.mjs'

test('방을 바꾼 뒤 도착한 이전 방 응답은 표시하지 않는다', async () => {
  let resolveFirst, selected = 'first'
  const waiting = loadSelectedMessages('first', () => new Promise(resolve => { resolveFirst = resolve }), () => selected)
  selected = 'second'
  resolveFirst([{ body: 'first room only' }])
  assert.equal(await waiting, null)
  assert.deepEqual(await loadSelectedMessages('second', async () => [{ body: 'second room' }], () => selected), [{ body: 'second room' }])
})

test('같은 방으로 돌아와도 이전 선택에서 시작한 응답은 버린다', async () => {
  let resolveFirst, selection = { room: 'first' }
  const original = selection
  const waiting = loadSelectedMessages('first', () => new Promise(resolve => { resolveFirst = resolve }), () => selection, original)
  selection = { room: 'second' }
  selection = { room: 'first' }
  resolveFirst([{ body: 'stale' }])
  assert.equal(await waiting, null)
  assert.deepEqual(await loadSelectedMessages('first', async () => [{ body: 'current' }], () => selection, selection), [{ body: 'current' }])
})
