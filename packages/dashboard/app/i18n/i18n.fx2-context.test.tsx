// fx2 repair-round failing regression tests for Hydrogen H1, H2, H-L4 (docs search error),
// and Sonnet S1: React Context isolation (no SSR global activeLocale mutation), reactive
// Context subscriptions across client components, Nav/LocaleSwitcher without localeProp
// override, I18nProvider initialLocale prop sync, and useEffect locale/t dependencies.
import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import React, { Suspense } from "react"
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server"
import { I18nProvider, useLocale, useT } from "./provider.tsx"
import { LocaleSwitcher, Nav } from "../components/Nav.tsx"
import { HomeTodoSummary } from "../components/HomeTodoSummary.tsx"
import { SettingsView } from "../settings/settings-view.tsx"
import { LLMSettingsView } from "../settings/llm/llm-settings-view.tsx"
import type { WorkspaceSettingsSnapshot } from "../settings/settings-data.ts"
import { DecisionList } from "../decisions/DecisionList.tsx"
import DecisionsPage from "../decisions/page.tsx"
import { WorkBoard } from "../work/WorkBoard.tsx"
import type { LedgerPayload } from "../work/work-ledger-view.ts"
import { ScheduleView } from "../schedule/ScheduleView.tsx"
import type { BoardScheduleProjection } from "../schedule/schedule-board-projection.ts"
import { DocsView } from "../docs/DocsView.tsx"
import { DocEditor } from "../docs/DocEditor.tsx"
import DocsPage from "../docs/page.tsx"
import { MessengerView } from "../messages/MessengerView.tsx"
import type { MessengerState } from "../messages/messenger.ts"
import AxMessengerPage from "../ax/messenger/page.tsx"

const require = createRequire(import.meta.url)
const { SearchParamsContext } = require("next/dist/shared/lib/hooks-client-context.shared-runtime") as {
  SearchParamsContext: React.Context<URLSearchParams | null>
}
const { AppRouterContext } = require("next/dist/shared/lib/app-router-context.shared-runtime") as {
  AppRouterContext: React.Context<unknown>
}

const here = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(here, "..")
const HANGUL = /[\uAC00-\uD7A3]/

const snapshot: WorkspaceSettingsSnapshot = {
  runners: [
    {
      id: "agy",
      label: "agy",
      binary: "agy",
      available: true,
      profileHooksSupported: false,
      roles: ["tier-worker"],
      configDetected: true,
    },
  ],
  tierProfile: {
    status: "configured",
    path: "config/tier-profile.json",
    examplePath: "config/tier-profile.example.json",
    exampleExists: true,
    priority: ["agy"],
    workerSteps: ["implementation"],
    tiers: [{ tier: "2", purpose: "Design & implementation", candidateCount: 1, clis: ["agy"] }],
  },
  reviewModels: {
    readOnly: true,
    approvalGate: "CFG-",
    supportedRunners: ["agy"],
    deployConfigPath: ".claude/deploy/config.json",
    deployConfigExists: true,
    overrideCount: 1,
    overrides: [{ key: "argon", runner: "agy", effort: "high" }],
    reviewConfigPath: "naia-settings/review.json",
    reviewConfigExists: true,
    reviewerSlots: ["agy"],
    reviewerCount: 1,
  },
  llm: {
    yamlPath: ".agents/context/llm-config.yaml",
    yamlExists: true,
    jsonPath: "naia-settings/llm.json",
    jsonExists: true,
    defaultProvider: "naia",
    gatewayUrlConfigured: true,
    roleSlots: [{ role: "main", configured: true, provider: "openai-compat" }],
    providers: [
      { id: "naia", name: "Naia Account", configured: true, source: "file", note: "Workspace gateway provider slot" },
    ],
  },
  configFiles: [{ name: "llm.json", path: "naia-settings/llm.json", exists: true }],
}

const ledger: LedgerPayload = {
  configured: true,
  available: true,
  view: "board",
  observedAt: "2026-11-18T06:00:00Z",
  todayDate: "2026-11-18",
  timezone: "Asia/Seoul",
  roles: ["coder"],
  summary: { total: 1, todoCount: 1, open: 1, waiting_human: 0, escalated_human: 0, done: 0, dropped: 0, overdue: 0 },
  filteredSummary: { total: 1, todoCount: 1, open: 1, waiting_human: 0, escalated_human: 0, done: 0, dropped: 0, overdue: 0 },
  items: [
    {
      id: "w-1",
      role: "coder",
      title: "ASCII task title",
      status: "open",
      due: null,
      dueDate: null,
      overdue: false,
      isTodo: true,
      createdAt: null,
      checkedAt: null,
      note: "",
      channel: "",
      msgId: "",
      quote: "",
      sourceUrl: null,
      resultLinks: [],
      workerName: null,
      hasDrive: false,
    },
  ],
  warnings: [],
}

const emptySchedule: BoardScheduleProjection = {
  observedAt: null,
  todayDate: "2026-11-18",
  workItems: [],
  undatedItems: [],
  milestones: [],
}

const messengerState: MessengerState = {
  channels: [{ id: "general", name: "general", kind: "channel", unread: 0 }],
  messages: { general: [] },
  alerts: [],
}

// Minimal deterministic React hook+context tree runner for client component tests.
type HookSlot =
  | { kind: "state"; value: unknown }
  | { kind: "ref"; current: unknown }
  | { kind: "memo"; deps: unknown[] | undefined; value: unknown }
  | { kind: "callback"; deps: unknown[] | undefined; value: unknown }
  | { kind: "effect"; deps: unknown[] | undefined; create: () => void | (() => void); cleanup?: void | (() => void) }

function depsChanged(prev: unknown[] | undefined, next: unknown[] | undefined): boolean {
  if (!prev || !next || prev.length !== next.length) return true
  return next.some((v, i) => !Object.is(prev[i], v))
}

function mountTree(renderRoot: () => React.ReactNode) {
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown }
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const instanceSlots = new Map<string, HookSlot[]>()
  const activeKeys = new Set<string>()
  const pendingEffects: Array<{ slot: Extract<HookSlot, { kind: "effect" }> }> = []
  let lastTree: React.ReactNode = null

  function renderNode(
    node: React.ReactNode,
    pathKey: string,
    ctxMap: Map<unknown, unknown>,
  ): React.ReactNode {
    if (node === null || node === undefined || typeof node === "boolean" || typeof node === "string" || typeof node === "number") {
      return node
    }
    if (Array.isArray(node)) {
      return node.map((child, idx) => renderNode(child, `${pathKey}[${idx}]`, ctxMap))
    }
    if (!React.isValidElement(node)) return node

    const elType = node.type as unknown
    // Context Provider (<Ctx.Provider value={...}> or React 19 <Ctx value={...}>)
    if (elType && typeof elType === "object") {
      const obj = elType as { $$typeof?: symbol; _context?: unknown }
      const providerTag = Symbol.for("react.provider")
      const contextTag = Symbol.for("react.context")
      if (obj.$$typeof === providerTag && obj._context) {
        const nextMap = new Map(ctxMap)
        nextMap.set(obj._context, (node.props as { value?: unknown }).value)
        return renderNode((node.props as { children?: React.ReactNode }).children, `${pathKey}:P`, nextMap)
      }
      if (obj.$$typeof === contextTag) {
        const nextMap = new Map(ctxMap)
        nextMap.set(elType, (node.props as { value?: unknown }).value)
        return renderNode((node.props as { children?: React.ReactNode }).children, `${pathKey}:C`, nextMap)
      }
    }

    if (typeof elType === "symbol") {
      return renderNode((node.props as { children?: React.ReactNode }).children, `${pathKey}:S`, ctxMap)
    }

    if (typeof elType === "string") {
      const props = node.props as { children?: React.ReactNode }
      if (props.children === undefined) return node
      return React.cloneElement(node, undefined, renderNode(props.children, `${pathKey}/${elType}`, ctxMap))
    }

    if (typeof elType === "function") {
      const fnName = (elType as { name?: string }).name || "Comp"
      const compKey = `${pathKey}/${fnName}`
      activeKeys.add(compKey)
      let slots = instanceSlots.get(compKey)
      if (!slots) {
        slots = []
        instanceSlots.set(compKey, slots)
      }
      let idx = 0
      const prevH = internals.H
      internals.H = {
        useState(initial: unknown) {
          const i = idx++
          if (!slots![i]) {
            slots![i] = { kind: "state", value: typeof initial === "function" ? (initial as () => unknown)() : initial }
          }
          const slot = slots![i] as Extract<HookSlot, { kind: "state" }>
          const setState = (next: unknown) => {
            slot.value = typeof next === "function" ? (next as (prev: unknown) => unknown)(slot.value) : next
          }
          return [slot.value, setState]
        },
        useRef(initial: unknown) {
          const i = idx++
          if (!slots![i]) slots![i] = { kind: "ref", current: initial }
          return slots![i]
        },
        useMemo(fn: () => unknown, deps?: unknown[]) {
          const i = idx++
          const prevSlot = slots![i] as Extract<HookSlot, { kind: "memo" }> | undefined
          if (!prevSlot || depsChanged(prevSlot.deps, deps)) {
            slots![i] = { kind: "memo", deps, value: fn() }
          }
          return (slots![i] as Extract<HookSlot, { kind: "memo" }>).value
        },
        useCallback(fn: unknown, deps?: unknown[]) {
          const i = idx++
          const prevSlot = slots![i] as Extract<HookSlot, { kind: "callback" }> | undefined
          if (!prevSlot || depsChanged(prevSlot.deps, deps)) {
            slots![i] = { kind: "callback", deps, value: fn }
          }
          return (slots![i] as Extract<HookSlot, { kind: "callback" }>).value
        },
        useEffect(create: () => void | (() => void), deps?: unknown[]) {
          const i = idx++
          const prevSlot = slots![i] as Extract<HookSlot, { kind: "effect" }> | undefined
          if (!prevSlot || deps === undefined || depsChanged(prevSlot.deps, deps)) {
            const nextSlot: Extract<HookSlot, { kind: "effect" }> = {
              kind: "effect",
              deps,
              create,
              cleanup: prevSlot?.cleanup,
            }
            slots![i] = nextSlot
            pendingEffects.push({ slot: nextSlot })
          }
        },
        useContext(ctx: React.Context<unknown>) {
          if (ctxMap.has(ctx)) return ctxMap.get(ctx)
          return (ctx as unknown as { _currentValue?: unknown })._currentValue
        },
      }
      let rendered: React.ReactNode
      try {
        rendered = (elType as (p: unknown) => React.ReactNode)(node.props)
      } finally {
        internals.H = prevH
      }
      return renderNode(rendered, compKey, ctxMap)
    }

    return node
  }

  function render() {
    activeKeys.clear()
    lastTree = renderNode(renderRoot(), "root", new Map())
    for (const key of [...instanceSlots.keys()]) {
      if (!activeKeys.has(key)) {
        for (const slot of instanceSlots.get(key)!) {
          if (slot.kind === "effect" && typeof slot.cleanup === "function") slot.cleanup()
        }
        instanceSlots.delete(key)
      }
    }
    while (pendingEffects.length > 0) {
      const { slot } = pendingEffects.shift()!
      if (typeof slot.cleanup === "function") slot.cleanup()
      slot.cleanup = slot.create()
    }
    return lastTree
  }

  function unmount() {
    for (const slots of instanceSlots.values()) {
      for (const slot of slots) {
        if (slot.kind === "effect" && typeof slot.cleanup === "function") slot.cleanup()
      }
    }
    instanceSlots.clear()
  }

  return { render, unmount, current: () => lastTree }
}

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

function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (React.isValidElement(node)) return textOf((node.props as { children?: React.ReactNode }).children)
  return ""
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve))
}

function withFakeBrowserEnv(fn: () => void | Promise<void>) {
  const g = globalThis as unknown as Record<string, unknown>
  const prevWindow = g.window
  const prevDocument = g.document
  const prevLocalStorage = g.localStorage
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  const attrs: Record<string, string> = {}
  const storageMap = new Map<string, string>()
  const storage = {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storageMap.set(k, String(v))
    },
  }
  let cookieStr = ""
  g.document = {
    get cookie() {
      return cookieStr
    },
    set cookie(v: string) {
      const pair = v.split(";")[0] ?? ""
      const eq = pair.indexOf("=")
      if (eq !== -1) {
        const k = pair.slice(0, eq).trim()
        const rest = cookieStr
          .split(";")
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith(`${k}=`))
        rest.push(pair.trim())
        cookieStr = rest.join("; ")
      }
    },
    documentElement: {
      setAttribute: (k: string, v: string) => {
        attrs[k] = v
      },
      getAttribute: (k: string) => attrs[k] ?? null,
    },
  }
  g.localStorage = storage
  g.window = {
    location: { search: "", origin: "http://localhost:3142", pathname: "/" },
    localStorage: storage,
    addEventListener(type: string, cb: (e: unknown) => void) {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(cb)
    },
    removeEventListener(type: string, cb: (e: unknown) => void) {
      listeners.get(type)?.delete(cb)
    },
    dispatchEvent(ev: { type?: string }) {
      const set = listeners.get(ev.type ?? "")
      if (set) {
        for (const cb of [...set]) cb(ev)
      }
      return true
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevWindow === undefined) delete g.window
      else g.window = prevWindow
      if (prevDocument === undefined) delete g.document
      else g.document = prevDocument
      if (prevLocalStorage === undefined) delete g.localStorage
      else g.localStorage = prevLocalStorage
    })
}

describe("fx2 finding H1/H2/S1: Context isolation and reactive subscriptions", () => {
  it("interleaved concurrent SSR streams in en and ko never pollute each other", async () => {
    let releaseEn!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseEn = resolve
    })
    async function SuspendedEn({ children }: { children: React.ReactNode }) {
      await gate
      return <>{children}</>
    }

    const enStreamPromise = renderToReadableStream(
      <I18nProvider initialLocale="en">
        <Suspense fallback={<span>loading</span>}>
          <SuspendedEn>
            <div>
              <Nav initialTheme="light" initialFontSize="md" hasBoard={true} hasLedger={true} hasMessenger={true} hasAxMessenger={true} todoBadgeCount={2} />
              <WorkBoard status="ready" ledger={ledger} hasBoard={false} initialTab="summary" onRefresh={() => {}} />
              <HomeTodoSummary initialLedger={ledger} nowMs={Date.parse("2026-11-18T06:00:00Z")} />
              <ScheduleView hasBoard={true} initialAnchorDate="2026-11-18" initialBoardSchedule={emptySchedule} />
              <DecisionList
                markdown={"## pending\n| # | Task |\n|---|---|\n| 1 | Item |\n## done\n| # | Task |\n|---|---|\n"}
                config={{ source: "adk", path: "guide.md", pendingHeading: "## pending", doneHeading: "## done" }}
              />
              <SettingsView snapshot={snapshot} health={{ status: "ok", root: "/w" }} />
              <LLMSettingsView snapshot={snapshot} />
              <DocsView activeTab="common" sources={[]} tabSections={[]} currentSource={null} currentPath={null} viewMode="grid" />
              <MessengerView initialState={messengerState} initialChannelId="general" disableStream />
              <AxMessengerPage />
            </div>
          </SuspendedEn>
        </Suspense>
      </I18nProvider>,
    )

    // Let the outer en I18nProvider execute and suspend at <SuspendedEn>,
    // then render a full ko tree concurrently before resuming en.
    await new Promise((r) => setImmediate(r))
    const koHtml = renderToStaticMarkup(
      <I18nProvider initialLocale="ko">
        <Nav initialTheme="light" initialFontSize="md" hasBoard={true} hasLedger={true} todoBadgeCount={1} />
      </I18nProvider>,
    )
    assert.ok(koHtml.includes(">문서<"))

    releaseEn()
    const enStream = await enStreamPromise
    const enHtml = await new Response(enStream).text()

    assert.ok(enHtml.includes(">Docs<"), "en stream Nav must stay English after concurrent ko render")
    assert.ok(enHtml.includes("Work board"), "en stream WorkBoard must stay English")
    assert.ok(enHtml.includes("Task summary"), "en stream HomeTodoSummary must stay English")
    assert.ok(enHtml.includes("2026-11"), "en stream ScheduleView must stay English")
    assert.ok(enHtml.includes("To decide now"), "en stream DecisionList must stay English")
    assert.ok(enHtml.includes(">Settings<"), "en stream SettingsView must stay English")
    assert.ok(enHtml.includes(">LLM Settings<"), "en stream LLMSettingsView must stay English")
    assert.ok(enHtml.includes("Matrix Chat"), "en stream AxMessengerPage must stay English")
    assert.equal(HANGUL.test(enHtml), false, "en stream must contain zero Hangul after concurrent ko render")
  })

  it("LocaleSwitcher uses Context locale rather than stale localeProp", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <LocaleSwitcher locale="ko" />
      </I18nProvider>,
    )
    assert.match(html, /data-testid="locale-btn-en"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="locale-btn-en"/)
    assert.match(html, /data-testid="locale-btn-ko"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-testid="locale-btn-ko"/)
  })

  it("I18nProvider updates Context consumers on switcher click, mount correction, and initialLocale prop change", async () => {
    await withFakeBrowserEnv(async () => {
      let currentInitial: "en" | "ko" = "ko"
      function Probe() {
        const locale = useLocale()
        const t = useT()
        return (
          <div>
            <span data-testid="probe-locale">{locale}</span>
            <span data-testid="probe-docs">{t("nav.docs")}</span>
            <Nav initialTheme="light" initialFontSize="md" hasBoard={true} hasLedger={false} />
            <WorkBoard status="ready" ledger={ledger} hasBoard={false} initialTab="summary" onRefresh={() => {}} />
          </div>
        )
      }

      const app = mountTree(() => (
        <AppRouterContext.Provider value={{ push: () => {}, replace: () => {}, refresh: () => {} }}>
          <I18nProvider initialLocale={currentInitial}>
            <Probe />
          </I18nProvider>
        </AppRouterContext.Provider>
      ))
      try {
        let tree = app.render()
        assert.equal(textOf(findElement(tree, (el) => (el.props as Record<string, unknown>)["data-testid"] === "probe-locale")), "ko")
        assert.ok(textOf(tree).includes("작업 보드"))

        // 1) Click EN in LocaleSwitcher -> children re-render reactively in English.
        const enBtn = findElement(tree, (el) => (el.props as Record<string, unknown>)["data-testid"] === "locale-btn-en")!
        ;(enBtn.props as { onClick: () => void }).onClick()
        tree = app.render()
        assert.equal(textOf(findElement(tree, (el) => (el.props as Record<string, unknown>)["data-testid"] === "probe-locale")), "en")
        assert.equal(textOf(findElement(tree, (el) => (el.props as Record<string, unknown>)["data-testid"] === "probe-docs")), "Docs")
        assert.ok(textOf(tree).includes("Work board"))

        // 2) Update initialLocale prop "en" -> "ko" -> provider syncs prop changes.
        currentInitial = "en"
        app.render()
        app.render()
        currentInitial = "ko"
        app.render()
        tree = app.render()
        assert.equal(textOf(findElement(tree, (el) => (el.props as Record<string, unknown>)["data-testid"] === "probe-locale")), "ko")
        assert.ok(textOf(tree).includes("작업 보드"))
      } finally {
        app.unmount()
      }

      // 3) Mount correction when stored cookie is "en" and SSR initialLocale was "ko".
      document.cookie = "naia-adk-lang=en"
      const mountApp = mountTree(() => (
        <I18nProvider initialLocale="ko">
          <Probe />
        </I18nProvider>
      ))
      try {
        mountApp.render()
        const tree = mountApp.render()
        assert.equal(textOf(findElement(tree, (el) => (el.props as Record<string, unknown>)["data-testid"] === "probe-locale")), "en")
        assert.ok(textOf(tree).includes("Work board"))
      } finally {
        mountApp.unmount()
      }
    })
  })

  it("no UI component under app/ calls getActiveLocale() and provider.tsx has no module-global activeLocale", () => {
    const providerSource = fs.readFileSync(path.join(here, "provider.tsx"), "utf8")
    assert.equal(/\blet\s+activeLocale\b/.test(providerSource), false, "provider.tsx must not hold module-global activeLocale")

    const callers: string[] = []
    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const rel = path.relative(appDir, full)
          if (rel === path.join("i18n", "provider.tsx")) continue
          const src = fs.readFileSync(full, "utf8")
          if (src.includes("getActiveLocale(")) callers.push(rel)
        }
      }
    }
    walk(appDir)
    assert.deepEqual(callers, [], `UI files still calling getActiveLocale(): ${callers.join(", ")}`)
  })
})

describe("fx2 finding H1 + H-L4: useEffect locale/t dependencies and DocsViewer search error", () => {
  it("DocsViewer search failure uses docs.searchFailed and updates when locale changes", async () => {
    await withFakeBrowserEnv(async () => {
      const prevFetch = globalThis.fetch
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith("/api/portal/search")) {
          return new Response("err", { status: 500 })
        }
        return Response.json({ sources: [], items: [] })
      }) as typeof fetch

      let locale: "ko" | "en" = "ko"
      const app = mountTree(() => (
        <AppRouterContext.Provider value={{ push: () => {}, replace: () => {}, refresh: () => {} }}>
          <SearchParamsContext.Provider value={new URLSearchParams("q=hello")}>
            <I18nProvider initialLocale={locale}>
              <DocsPage />
            </I18nProvider>
          </SearchParamsContext.Provider>
        </AppRouterContext.Provider>
      ))
      try {
        app.render()
        app.render()
        await flush()
        let tree = app.render()
        assert.ok(textOf(tree).includes("검색하지 못했습니다 (500)"), `expected ko searchError, got: ${textOf(tree).slice(0, 300)}`)

        locale = "en"
        app.render()
        app.render()
        await flush()
        tree = app.render()
        assert.ok(textOf(tree).includes("Search failed (500)"), `expected en searchError, got: ${textOf(tree).slice(0, 300)}`)
      } finally {
        globalThis.fetch = prevFetch
        app.unmount()
      }
    })
  })

  it("DocEditor beforeunload prompt updates when locale changes while dirty", async () => {
    await withFakeBrowserEnv(async () => {
      let locale: "ko" | "en" = "ko"
      const app = mountTree(() => (
        <I18nProvider initialLocale={locale}>
          <DocEditor source="adk" path="a.md" initialContent="old" content="edited" initialBaseHash="h" />
        </I18nProvider>
      ))
      try {
        app.render()
        const evKo = { type: "beforeunload", preventDefault() {}, returnValue: "" }
        window.dispatchEvent(evKo as unknown as Event)
        assert.equal(evKo.returnValue, "고친 내용이 사라집니다. 나갈까요?")

        locale = "en"
        app.render()
        app.render()
        const evEn = { type: "beforeunload", preventDefault() {}, returnValue: "" }
        window.dispatchEvent(evEn as unknown as Event)
        assert.equal(evEn.returnValue, "Unsaved changes will be lost. Leave?")
      } finally {
        app.unmount()
      }
    })
  })

  it("DecisionsPage updates error messages on locale switch without clobbering edited form", async () => {
    await withFakeBrowserEnv(async () => {
      const prevFetch = globalThis.fetch
      globalThis.fetch = (async () => new Response("bad", { status: 500 })) as typeof fetch
      window.localStorage.setItem(
        "naia.decision-document.v1",
        JSON.stringify({ source: "adk", path: "d.md", pendingHeading: "## p", doneHeading: "## d" }),
      )

      let locale: "ko" | "en" = "ko"
      const app = mountTree(() => (
        <I18nProvider initialLocale={locale}>
          <DecisionsPage />
        </I18nProvider>
      ))
      try {
        app.render()
        app.render()
        await flush()
        let tree = app.render()
        const alertKo = findElement(tree, (el) => (el.props as Record<string, unknown>).role === "alert")
        assert.ok(textOf(alertKo).includes("문서를 불러오지 못했습니다"))

        // Open settings form so we verify locale switch doesn't re-run mount effect & close form.
        const toggleBtn = findElement(tree, (el) => el.type === "button" && textOf(el) === "문서 설정")!
        ;(toggleBtn.props as { onClick: () => void }).onClick()
        tree = app.render()
        assert.ok(findElement(tree, (el) => el.type === "form"), "form should be open")

        locale = "en"
        app.render()
        app.render()
        await flush()
        tree = app.render()
        const alertEn = findElement(tree, (el) => (el.props as Record<string, unknown>).role === "alert")
        assert.ok(textOf(alertEn).includes("Could not load the doc"), `expected English error, got: ${textOf(alertEn)}`)
        assert.ok(findElement(tree, (el) => el.type === "form"), "form must stay open across locale switch")
      } finally {
        globalThis.fetch = prevFetch
        app.unmount()
      }
    })
  })
})
