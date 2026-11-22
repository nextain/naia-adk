import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
;(globalThis as { React?: typeof React }).React = React
const require = createRequire(import.meta.url)
const { default: AxMessengerPage } = require("./page.tsx") as typeof import("./page.tsx")

type HookSlot = { kind: "state"; value: unknown } | { kind: "ref"; current: unknown } | { kind: "callback"; deps: unknown[]; value: unknown } | { kind: "effect"; deps: unknown[]; create: () => void | (() => void); cleanup?: void | (() => void) }

function findElement(node: React.ReactNode, pred: (el: React.ReactElement) => boolean): React.ReactElement | null {
  if (!node || typeof node !== "object") return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findElement(item, pred)
      if (hit) return hit
    }
    return null
  }
  if (!React.isValidElement(node)) return null
  if (pred(node)) return node
  return findElement((node.props as { children?: React.ReactNode }).children, pred)
}

function depsChanged(prev: unknown[] | undefined, next: unknown[] | undefined) {
  if (!prev || !next || prev.length !== next.length) return true
  return next.some((v, i) => !Object.is(prev[i], v))
}

function mountPage() {
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const slots: HookSlot[] = []
  const pendingEffects: Array<{ slot: Extract<HookSlot, { kind: "effect" }> }> = []
  let tree: React.ReactNode = null

  function render() {
    let idx = 0
    const prev = internals.H
    internals.H = {
      useState(initial: unknown) {
        const i = idx++
        if (!slots[i]) slots[i] = { kind: "state", value: typeof initial === "function" ? (initial as () => unknown)() : initial }
        const slot = slots[i] as Extract<HookSlot, { kind: "state" }>
        const setState = (next: unknown) => {
          slot.value = typeof next === "function" ? (next as (prev: unknown) => unknown)(slot.value) : next
        }
        return [slot.value, setState]
      },
      useRef(initial: unknown) {
        const i = idx++
        if (!slots[i]) slots[i] = { kind: "ref", current: initial }
        return slots[i]
      },
      useCallback(fn: unknown, deps: unknown[]) {
        const i = idx++
        const prevSlot = slots[i] as Extract<HookSlot, { kind: "callback" }> | undefined
        if (!prevSlot || depsChanged(prevSlot.deps, deps)) slots[i] = { kind: "callback", deps, value: fn }
        return (slots[i] as Extract<HookSlot, { kind: "callback" }>).value
      },
      useEffect(create: () => void | (() => void), deps: unknown[]) {
        const i = idx++
        const prevSlot = slots[i] as Extract<HookSlot, { kind: "effect" }> | undefined
        if (!prevSlot || depsChanged(prevSlot.deps, deps)) {
          const nextSlot: Extract<HookSlot, { kind: "effect" }> = { kind: "effect", deps, create, cleanup: prevSlot?.cleanup }
          slots[i] = nextSlot
          pendingEffects.push({ slot: nextSlot })
        }
      },
    }
    try {
      tree = AxMessengerPage()
    } finally {
      internals.H = prev
    }
    while (pendingEffects.length > 0) {
      const { slot } = pendingEffects.shift()!
      if (typeof slot.cleanup === "function") slot.cleanup()
      slot.cleanup = slot.create()
    }
    return tree
  }

  function unmount() {
    for (const slot of slots) {
      if (slot.kind === "effect" && typeof slot.cleanup === "function") slot.cleanup()
    }
  }

  return { render, unmount, current: () => tree }
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe("Matrix 메신저 화면 세션 만료(401) 복귀", () => {
  it("초기 렌더는 로그인 폼을 그린다", () => {
    const html = renderToStaticMarkup(<AxMessengerPage />)
    assert.ok(html.includes("Matrix 계정"))
    assert.ok(html.includes("비밀번호"))
    assert.ok(html.includes(">연결<"))
  })

  it("/rooms 가 401 을 돌려주면 connected 를 false 로 되돌리고 로그인 폼을 다시 표시한다 (502 는 유지)", async (t) => {
    let roomsResponse = { ok: true, status: 200, json: async () => ({ rooms: [{ roomId: "!r1:example.invalid", name: "일반" }] }) }
    let poll: (() => void) | undefined
    t.mock.method(globalThis, "setInterval", (fn: () => void) => { poll = fn; return 1 })
    t.mock.method(globalThis, "clearInterval", () => {})
    t.mock.method(globalThis, "fetch", async (url: string) => {
      if (String(url).endsWith("/login")) return { ok: true, status: 200, json: async () => ({ ok: true }) }
      if (String(url).endsWith("/rooms")) return roomsResponse
      return { ok: true, status: 200, json: async () => ({ messages: [] }) }
    })

    const app = mountPage()
    try {
      let tree = app.render()
      const loginForm = findElement(tree, (el) => el.type === "form")!
      await (loginForm.props as { onSubmit: (e: { preventDefault(): void }) => Promise<void> }).onSubmit({ preventDefault() {} })
      tree = app.render()
      await flush()
      tree = app.render()
      assert.ok(findElement(tree, (el) => el.type === "button" && (el.props as { children?: unknown }).children === "연결 종료"))
      assert.equal(typeof poll, "function")

      // 502 일시 오류는 연결 상태를 유지한다.
      roomsResponse = { ok: false, status: 502, json: async () => ({ error: "Matrix 연결에 실패했습니다." }) }
      poll!()
      await flush()
      tree = app.render()
      assert.ok(findElement(tree, (el) => el.type === "button" && (el.props as { children?: unknown }).children === "연결 종료"), "502 에서는 연결 화면을 유지한다")

      // 401 세션 만료에서는 connected 가 false 로 돌아가 로그인 폼을 보여야 한다.
      roomsResponse = { ok: false, status: 401, json: async () => ({ error: "Matrix 로그인이 필요합니다." }) }
      poll!()
      await flush()
      tree = app.render()
      assert.equal(findElement(tree, (el) => el.type === "button" && (el.props as { children?: unknown }).children === "연결 종료"), null, "401 뒤에는 연결 종료 화면이 남지 않는다")
      assert.ok(findElement(tree, (el) => el.type === "button" && (el.props as { children?: unknown }).children === "연결"), "401 뒤에는 로그인 연결 버튼이 보여야 한다")
    } finally { app.unmount() }
  })

  it("/send 와 /messages 가 401 을 돌려줘도 로그인 폼으로 돌아간다", async (t) => {
    let phase: "ok" | "send-401" | "msg-401" = "ok"
    t.mock.method(globalThis, "setInterval", () => 1)
    t.mock.method(globalThis, "clearInterval", () => {})
    t.mock.method(globalThis, "fetch", async (url: string) => {
      const target = String(url)
      if (target.endsWith("/login")) return { ok: true, status: 200, json: async () => ({ ok: true }) }
      if (target.endsWith("/rooms")) return { ok: true, status: 200, json: async () => ({ rooms: [{ roomId: "!r1:example.invalid", name: "일반" }] }) }
      if (target.includes("/messages")) {
        if (phase === "msg-401") return { ok: false, status: 401, json: async () => ({ error: "Matrix 로그인이 필요합니다." }) }
        return { ok: true, status: 200, json: async () => ({ messages: [] }) }
      }
      if (target.endsWith("/send")) {
        if (phase === "send-401") return { ok: false, status: 401, json: async () => ({ error: "Matrix 로그인이 필요합니다." }) }
        return { ok: true, status: 200, json: async () => ({ ok: true }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    })

    for (const targetPhase of ["send-401", "msg-401"] as const) {
      phase = "ok"
      const app = mountPage()
      try {
        let tree = app.render()
        const loginForm = findElement(tree, (el) => el.type === "form")!
        await (loginForm.props as { onSubmit: (e: { preventDefault(): void }) => Promise<void> }).onSubmit({ preventDefault() {} })
        tree = app.render()
        await flush()
        tree = app.render()
        const roomBtn = findElement(tree, (el) => el.type === "button" && (el.props as { children?: unknown }).children === "일반")!
        phase = targetPhase === "msg-401" ? "msg-401" : "ok"
        ;(roomBtn.props as { onClick: () => void }).onClick()
        tree = app.render()
        await flush()
        tree = app.render()
        if (targetPhase === "send-401") {
          phase = "send-401"
          const sendForm = findElement(tree, (el) => el.type === "form")!
          await (sendForm.props as { onSubmit: (e: { preventDefault(): void }) => Promise<void> }).onSubmit({ preventDefault() {} })
          tree = app.render()
          await flush()
          tree = app.render()
        }
        assert.equal(findElement(tree, (el) => el.type === "button" && (el.props as { children?: unknown }).children === "연결 종료"), null, `${targetPhase}: 연결 종료 화면이 남지 않는다`)
        assert.ok(findElement(tree, (el) => el.type === "button" && (el.props as { children?: unknown }).children === "연결"), `${targetPhase}: 로그인 폼으로 복귀한다`)
      } finally { app.unmount() }
    }
  })
})
