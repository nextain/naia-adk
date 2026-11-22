// Run through heavy-run: this builds the actual dashboard in its workspace.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const dashboard = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

test('production build renders the schedule and exposes the Matrix entry', () => {
  const result = spawnSync(process.execPath, [require.resolve('next/dist/bin/next'), 'build'], {
    cwd: dashboard, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  for (const page of ['schedule.html', 'ax/messenger.html']) {
    assert.ok(fs.existsSync(path.join(dashboard, '.next/server/app', page)), `missing ${page}`)
  }
})
