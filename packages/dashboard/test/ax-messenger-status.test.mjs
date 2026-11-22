import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observeAxMessengerStatus } from '../app/components/ax-messenger-status.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
test('설정 변경을 주기적으로 반영하고 늦은 응답과 종료 뒤 응답을 무시한다', async () => {
  const pending = [], states = []
  let poll, cleared = false
  const timers = { setInterval(fn) { poll = fn; return 1 }, clearInterval(id) { assert.equal(id, 1); cleared = true } }
  const stop = observeAxMessengerStatus(() => new Promise(resolve => pending.push(resolve)), value => states.push(value), timers)
  pending.shift()({ ok: true, json: async () => ({ enabled: false }) }); await tick()
  poll(); pending.shift()({ ok: true, json: async () => ({ enabled: true }) }); await tick()
  poll(); const old = pending.shift(); poll(); const latest = pending.shift()
  latest({ ok: true, json: async () => ({ enabled: false }) }); await tick()
  old({ ok: true, json: async () => ({ enabled: true }) }); await tick()
  poll(); const afterStop = pending.shift(); stop()
  afterStop({ ok: true, json: async () => ({ enabled: true }) }); await tick()
  assert.deepEqual(states, [false, true, false])
  assert.equal(cleared, true)
})
