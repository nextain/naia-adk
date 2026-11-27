import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { setTimeout } from "node:timers/promises"
import test, { type TestContext } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import * as Dialog from "@radix-ui/react-dialog"
import { createRichDocEditorPlugins, RichImageUploadForm } from "./RichDocEditorPlugins"
import { RichDocEditorBoundary, type RichDocEditorComponentProps } from "./RichDocEditor"
import { uploadRichEditorImage, RichEditorUploadError, RichEditorUploadCancelledError, type RichEditorUploadBatch } from "./rich-editor-upload"
import { saveDocument } from "./DocEditor"

for (const entry of ["dialog", "paste", "drop"] as const) {
  test(`그림 ${entry} 대기 중 표 되돌리기로 교체한 편집기의 새 입력은 늦은 성공 뒤에도 저장된다`, async (context) => {
    consumePluginUploadRejections(context)
    const dashboardRequire = createRequire(__filename)
    // 클라이언트 모듈의 스타일만 생략한다. 반환한 편집기 설정과 플러그인은 실제로 실행한다.
    const originalCss = dashboardRequire.extensions[".css"]
    dashboardRequire.extensions[".css"] = (module) => { module.exports = {} }
    let Client: (props: RichDocEditorComponentProps) => React.ReactElement<any>
    try { Client = dashboardRequire("./RichDocEditorClient").default }
    finally {
      if (originalCss) dashboardRequire.extensions[".css"] = originalCss
      else delete dashboardRequire.extensions[".css"]
    }
    const editorRequire = createRequire(dashboardRequire.resolve("@mdxeditor/editor"))
    const { Realm } = editorRequire("@mdxeditor/gurx")
    const core = dashboardRequire("@mdxeditor/editor")
    const lexical = editorRequire("lexical")
    const original = "| 값 |\n| --- |\n| 표 내용 |\n\n본문"
    let accepted = original
    let finish!: (response: Response) => void
    const saved: string[] = [], pending: number[] = []
    context.mock.method(globalThis, "fetch", (_url: unknown, request: RequestInit) => {
      if (request.method === "POST") return new Promise<Response>((resolve) => { finish = resolve })
      saved.push(JSON.parse(String(request.body)).content)
      return Promise.resolve(Response.json({ sha256: "2".repeat(64) }))
    })
    const boundary = new RichDocEditorBoundary({
      source: "adk", path: "index.md", content: original, EditorComponent: () => null,
      imagePreviewHandler: async (src) => src, onChange: (value) => { accepted = value },
      onUploadPendingChange: (count) => pending.push(count),
    })
    boundary.componentDidMount()
    context.after(() => boundary.componentWillUnmount())
    const props = (boundary.render() as React.ReactElement<RichDocEditorComponentProps>).props
    const values: any[] = []
    const render = () => {
      const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
      const previous = internals.H
      let cursor = 0
      internals.H = {
        useRef: (initial: unknown) => values[cursor++] ??= { current: initial },
        useState: (initial: unknown) => {
          const index = cursor++
          if (!(index in values)) values[index] = initial
          return [values[index], (next: any) => { values[index] = typeof next === "function" ? next(values[index]) : next }]
        },
        useCallback: (callback: unknown) => callback,
        useEffect() {},
      }
      try { return Client(props).props.children as React.ReactElement<any> }
      finally { internals.H = previous }
    }
    const open = async (element: React.ReactElement<any>) => {
      const plugins = [core.corePlugin({ ...element.props, initialMarkdown: element.props.markdown }), ...element.props.plugins]
      const realm = new Realm()
      for (const plugin of plugins) plugin.init?.(realm)
      for (const plugin of plugins) plugin.postInit?.(realm)
      realm.getValue(core.imageDialogState$)
      await setTimeout(0)
      const editor = realm.getValue(core.rootEditor$)
      editor._headless = true
      realm.pub(core.activeEditor$, editor)
      editor.update(() => lexical.$getRoot().getLastChild().selectEnd(), { discrete: true })
      return { realm, editor }
    }
    const oldElement = render(), old = await open(oldElement)
    const file = new File(["png"], "대기.png", { type: "image/png" })
    if (entry === "dialog") {
      old.realm.pub(core.imageDialogState$, { type: "new" })
      old.realm.pub(core.saveImage$, { file: { length: 1, item: () => file }, src: "", altText: "대기 그림" })
    } else {
      const data = { items: [{ type: file.type, kind: "file", getAsFile: () => file }] }
      old.editor.dispatchCommand(entry === "paste" ? lexical.PASTE_COMMAND : lexical.DROP_COMMAND, { clipboardData: data, dataTransfer: data, preventDefault() {} })
    }
    assert.equal(pending.at(-1), 1)
    // 실제 표 역사 리스너가 편집기 교체를 요청하게 한다.
    old.editor.update(() => lexical.$getRoot().getFirstChild().remove(), { discrete: true, tag: "historic" })
    const nextElement = render()
    assert.notEqual(nextElement.key, oldElement.key)
    const next = await open(nextElement)
    next.editor.update(() => lexical.$getRoot().getLastChild().getFirstChild().setTextContent("새 편집기에서 남긴 입력"), { discrete: true })
    const expected = accepted
    assert.match(expected, /새 편집기에서 남긴 입력/)
    oldElement.props.onChange("옛 편집기의 늦은 본문", false)
    assert.equal(accepted, expected, "이전 세대의 변경 콜백도 무효여야 한다")
    finish(Response.json({ path: "assets/대기.png" }))
    await setTimeout(0)
    await setTimeout(0)
    assert.equal(pending.at(-1), 0)
    assert.equal(accepted, expected)
    assert.doesNotMatch(render().props.markdown, /옛 편집기|assets\//)
    assert.equal((await saveDocument({ source: "adk", path: "index.md", content: accepted, baseHash: "1".repeat(64) })).ok, true)
    assert.deepEqual(saved, [expected])
  })
}

// 설치된 그림 플러그인의 대화 상자·붙여넣기·끌어놓기 명령을 실제로 실행한다.
for (const entry of ["dialog", "paste", "drop"] as const) {
  test(`그림 ${entry} 명령은 같은 업로드 처리기를 거쳐 상대 경로를 저장한다`, async (context) => {
    const dashboardRequire = createRequire(__filename)
    const editorRequire = createRequire(dashboardRequire.resolve("@mdxeditor/editor"))
    const { Realm } = editorRequire("@mdxeditor/gurx")
    const core = dashboardRequire("@mdxeditor/editor")
    const lexical = editorRequire("lexical")
    const changes: string[] = []
    const errors: unknown[] = []
    const file = new File(["png"], `${entry}.png`, { type: "image/png" })
    const requests: string[] = []
    let pending = 0
    const pendingCounts: number[] = []
    context.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push(String(url))
      assert.equal(init.body, file)
      return Response.json({ path: `assets/${entry}.png` })
    })
    const handler = (file: File) => {
      pendingCounts.push(++pending)
      return uploadRichEditorImage("adk", "article/index.md", file)
    }
    const plugins = [
      core.corePlugin({ initialMarkdown: "# 본문\n\n내용", onChange: (value: string, initial: boolean) => { if (!initial) changes.push(value) }, onError: (error: unknown) => errors.push(error) }),
      ...createRichDocEditorPlugins(async (src) => src, undefined, handler, () => {
        assert.ok(changes.some((markdown) => markdown.includes(`](assets/${entry}.png)`)), "그림 변경을 전달한 뒤 대기를 해제해야 한다")
        pendingCounts.push(--pending)
      }),
    ]
    const realm = new Realm()
    for (const plugin of plugins) plugin.init?.(realm)
    for (const plugin of plugins) plugin.postInit?.(realm)
    // 실제 대화 상자와 도구 단추가 읽는 셀을 열어 명령 구독을 등록한다.
    realm.getValue(core.imageDialogState$)
    await setTimeout(0)
    const editor = realm.getValue(core.rootEditor$)
    editor._headless = true
    realm.pub(core.activeEditor$, editor)
    editor.update(() => lexical.$getRoot().getLastChild().selectEnd(), { discrete: true })
    assert.equal(typeof realm.getValue(core.imageUploadHandler$), "function")
    if (entry === "dialog") {
      realm.pub(core.imageDialogState$, { type: "new" })
      realm.pub(core.saveImage$, { file: { length: 1, item: () => file }, src: "", altText: "그림" })
    } else {
      const data = { items: [{ type: file.type, kind: "file", getAsFile: () => file }] }
      const event = { clipboardData: data, dataTransfer: data, preventDefault() {} }
      assert.equal(editor.dispatchCommand(entry === "paste" ? lexical.PASTE_COMMAND : lexical.DROP_COMMAND, event), true)
    }
    assert.equal(pending, 1)
    await setTimeout(0)
    await setTimeout(0)
    assert.equal(requests.length, 1)
    assert.match(requests[0], /\/api\/portal\/doc-assets\?/)
    assert.ok(changes.some((markdown) => markdown.includes(`](assets/${entry}.png)`)), changes.join("\n"))
    assert.ok(changes.every((markdown) => !markdown.includes("/api/portal/asset")))
    assert.deepEqual(errors, [])
    assert.deepEqual(pendingCounts, [1, 0])
  })
}

test("그림 올리기 실패는 대화 상자를 닫고 본문을 보존한다", async (context) => {
  const dashboardRequire = createRequire(__filename)
  const editorRequire = createRequire(dashboardRequire.resolve("@mdxeditor/editor"))
  const { Realm } = editorRequire("@mdxeditor/gurx")
  const core = dashboardRequire("@mdxeditor/editor")
  const changes: string[] = []
  context.mock.method(globalThis, "fetch", async () => Response.json({ message: "확장자를 고쳐 주세요." }, { status: 415 }))
  const plugins = [
    core.corePlugin({ initialMarkdown: "# 본문", onChange: (value: string, initial: boolean) => { if (!initial) changes.push(value) } }),
    ...createRichDocEditorPlugins(async (src) => src, undefined, (file) => uploadRichEditorImage("adk", "index.md", file)),
  ]
  const realm = new Realm()
  for (const plugin of plugins) plugin.init?.(realm)
  for (const plugin of plugins) plugin.postInit?.(realm)
  await setTimeout(0)
  realm.pub(core.imageDialogState$, { type: "new" })
  await assert.rejects(realm.getValue(core.imageUploadHandler$)(new File(["png"], "위장.jpg")), /위장.jpg: 확장자를 고쳐 주세요/)
  assert.equal(realm.getValue(core.imageDialogState$).type, "inactive")
  assert.deepEqual(changes, [])
})

test("같은 경로 그림 두 개 동시 붙여넣기는 마지막 실제 삽입 이후 저장 대기를 해제한다", async (context) => {
  const dashboardRequire = createRequire(__filename)
  const editorRequire = createRequire(dashboardRequire.resolve("@mdxeditor/editor"))
  const { Realm } = editorRequire("@mdxeditor/gurx")
  const core = dashboardRequire("@mdxeditor/editor")
  const lexical = editorRequire("lexical")
  const requests: ((src: string) => void)[] = []
  const changes: string[] = []
  let pending = 0
  const counts: number[] = []
  const plugins = [
    core.corePlugin({ initialMarkdown: "![기존](assets/same.png)\n\n본문", onChange: (value: string, initial: boolean) => { if (!initial) changes.push(value) } }),
    ...createRichDocEditorPlugins(async (src) => src, undefined, () => {
      counts.push(++pending)
      return new Promise<string>((resolve) => requests.push(resolve))
    }, () => {
      counts.push(--pending)
      if (pending === 0) assert.equal(changes.at(-1)!.split("](assets/same.png)").length - 1, 3)
    }),
  ]
  const realm = new Realm()
  for (const plugin of plugins) plugin.init?.(realm)
  for (const plugin of plugins) plugin.postInit?.(realm)
  realm.getValue(core.imageDialogState$)
  await setTimeout(0)
  const editor = realm.getValue(core.rootEditor$)
  editor._headless = true
  realm.pub(core.activeEditor$, editor)
  editor.update(() => lexical.$getRoot().getLastChild().selectEnd(), { discrete: true })
  const file = new File(["png"], "same.png", { type: "image/png" })
  editor.dispatchCommand(lexical.PASTE_COMMAND, { clipboardData: { items: [file, file].map((file) => ({ type: file.type, kind: "file", getAsFile: () => file })) }, preventDefault() {} })
  assert.equal(pending, 2)
  requests[0]("assets/same.png")
  await setTimeout(0)
  await setTimeout(0)
  assert.equal(pending, 1)
  assert.equal(changes.at(-1)?.split("](assets/same.png)").length ?? 2, 2)
  requests[1]("assets/same.png")
  await setTimeout(0)
  await setTimeout(0)
  assert.equal(pending, 0)
  assert.deepEqual(counts, [1, 2, 1, 0])
})

test("업로드 묶음 일부 실패도 남은 성공 요청이 끝난 뒤 대기 수가 0이 된다", async (context) => {
  const dashboardRequire = createRequire(__filename)
  const editorRequire = createRequire(dashboardRequire.resolve("@mdxeditor/editor"))
  const { Realm } = editorRequire("@mdxeditor/gurx")
  const core = dashboardRequire("@mdxeditor/editor")
  const requests: { resolve(src: string): void; reject(error: Error): void }[] = []
  let pending = 0
  const changes: string[] = []
  const plugins = [
    core.corePlugin({ initialMarkdown: "본문", onChange: (value: string, initial: boolean) => { if (!initial) changes.push(value) } }),
    ...createRichDocEditorPlugins(async (src) => src, undefined, () => {
      pending++
      return new Promise<string>((resolve, reject) => requests.push({ resolve, reject }))
    }, () => { pending-- }),
  ]
  const realm = new Realm()
  for (const plugin of plugins) plugin.init?.(realm)
  for (const plugin of plugins) plugin.postInit?.(realm)
  await setTimeout(0)
  const handler = realm.getValue(core.imageUploadHandler$)
  // The installed paste/drop plugin uses this Promise.all contract. Its
  // rejected batch never publishes image insertion, even for a successful URL.
  const batch = Promise.all([handler(new File(["png"], "good.png")), handler(new File(["png"], "bad.png"))])
  const failed = assert.rejects(batch, /업로드 실패/)
  requests[1].reject(new Error("업로드 실패"))
  await failed
  await setTimeout(0)
  assert.equal(pending, 1)
  requests[0].resolve("assets/good.png")
  await setTimeout(0)
  await setTimeout(0)
  assert.equal(pending, 0)
  assert.deepEqual(changes, [])
})

test("기존 그림을 같은 src로 다시 올려도 markdown 변경 없이 대기를 해제한다", async (context) => {
  const dashboardRequire = createRequire(__filename)
  const editorRequire = createRequire(dashboardRequire.resolve("@mdxeditor/editor"))
  const { Realm } = editorRequire("@mdxeditor/gurx")
  const core = dashboardRequire("@mdxeditor/editor")
  const lexical = editorRequire("lexical")
  let pending = 0
  const changes: string[] = []
  const plugins = [
    core.corePlugin({ initialMarkdown: "![기존](assets/same.png)", onChange: (value: string, initial: boolean) => { if (!initial) changes.push(value) } }),
    ...createRichDocEditorPlugins(async (src) => src, undefined, async () => { pending++; return "assets/same.png" }, () => { pending-- }),
  ]
  const realm = new Realm()
  for (const plugin of plugins) plugin.init?.(realm)
  for (const plugin of plugins) plugin.postInit?.(realm)
  realm.getValue(core.imageDialogState$)
  await setTimeout(0)
  const editor = realm.getValue(core.rootEditor$)
  editor._headless = true
  realm.pub(core.activeEditor$, editor)
  let nodeKey = ""
  editor.getEditorState().read(() => { nodeKey = lexical.$getRoot().getFirstChild().getFirstChild().getKey() })
  realm.pub(core.imageDialogState$, { type: "editing", nodeKey, src: "assets/same.png", altText: "기존", title: "" })
  realm.pub(core.saveImage$, { file: { length: 1, item: () => new File(["png"], "same.png") }, src: "assets/same.png", altText: "기존", title: "" })
  assert.equal(pending, 1)
  await setTimeout(0)
  await setTimeout(0)
  assert.equal(pending, 0)
  assert.deepEqual(changes, [])
})

// 기본 플러그인은 catch에서도 업로드 오류를 다시 던진다. 브라우저의
// RichDocEditorClient와 같이 알려진 업로드 오류만 소비하고 나머지는 드러낸다.
function consumePluginUploadRejections(context: TestContext) {
  const originalCatch = Promise.prototype.catch
  context.mock.method(Promise.prototype, "catch", function (this: Promise<unknown>, reject: (error: unknown) => unknown) {
    const result = originalCatch.call(this, reject)
    originalCatch.call(result, (error) => { if (!(error instanceof RichEditorUploadError)) throw error })
    return result
  })
}

async function uploadHarness(context: TestContext) {
  consumePluginUploadRejections(context)
  const dashboardRequire = createRequire(__filename)
  const editorRequire = createRequire(dashboardRequire.resolve("@mdxeditor/editor"))
  const { Realm } = editorRequire("@mdxeditor/gurx")
  const core = dashboardRequire("@mdxeditor/editor")
  const lexical = editorRequire("lexical")
  const requests: { name: string; finish(response: Response): void }[] = []
  const batches: RichEditorUploadBatch[] = []
  const changes: string[] = []
  const pending: number[] = []
  let notice: { message: string; dismiss?: () => void } | null = null
  context.mock.method(globalThis, "fetch", (url: string) => new Promise<Response>((finish) => {
    requests.push({ name: new URL(url, "http://localhost").searchParams.get("name")!, finish })
  }))
  const boundary = new RichDocEditorBoundary({
    source: "adk", path: "index.md", content: "본문", onChange: (markdown) => changes.push(markdown),
    EditorComponent: () => null, imagePreviewHandler: async (src) => src,
    onUploadError: (message, dismiss) => { notice = message ? { message, dismiss } : null },
    onUploadPendingChange: (count) => pending.push(count),
  })
  boundary.componentDidMount()
  context.after(() => boundary.componentWillUnmount())
  const props = (boundary.render() as React.ReactElement<RichDocEditorComponentProps>).props
  const plugins = [
    core.corePlugin({ initialMarkdown: "본문", onChange: props.onChange }),
    ...createRichDocEditorPlugins(async (src) => src, undefined, (file, batch) => {
      batches.push(batch!)
      return props.imageUploadHandler!(file, batch)
    }, props.onImageUploadSettled),
  ]
  const realm = new Realm()
  for (const plugin of plugins) plugin.init?.(realm)
  for (const plugin of plugins) plugin.postInit?.(realm)
  await setTimeout(0)
  const editor = realm.getValue(core.rootEditor$)
  editor._headless = true
  realm.pub(core.activeEditor$, editor)
  editor.update(() => lexical.$getRoot().getLastChild().selectEnd(), { discrete: true })
  return {
    core, realm, editor, requests, batches, changes, pending,
    notice: () => notice,
    dismiss() { notice?.dismiss?.() },
    dispatch(kind: "paste" | "drop", names: string[]) {
      const items = names.map((name) => ({ kind: "file", type: "image/png", getAsFile: () => new File(["png"], name, { type: "image/png" }) }))
      assert.equal(editor.dispatchCommand(kind === "paste" ? lexical.PASTE_COMMAND : lexical.DROP_COMMAND, {
        clipboardData: { items }, dataTransfer: { items }, preventDefault() {},
      }), true)
    },
  }
}

async function settleUploads() { await setTimeout(0); await setTimeout(0) }

for (const response of ["성공", "실패"] as const) {
  test(`대화 상자 취소는 요청을 즉시 거절하고 늦은 ${response} 응답과 새 요청을 분리한다`, async (context) => {
    const h = await uploadHarness(context)
    const original = h.realm.getValue(h.core.imageUploadHandler$)
    let request: Promise<string>
    h.realm.pub(h.core.imageUploadHandler$, (file: File) => { request = original(file); return request })
    const save = (name: string) => h.realm.pub(h.core.saveImage$, {
      file: { length: 1, item: () => new File(["png"], name) }, src: "", altText: "그림", title: "",
    })
    h.realm.pub(h.core.openNewImageDialog$)
    save("취소한.png")
    const cancelled = assert.rejects(request!, (error: Error) => error instanceof RichEditorUploadCancelledError && error instanceof RichEditorUploadError)
    h.realm.pub(h.core.closeImageDialog$)
    await cancelled
    await settleUploads()
    assert.equal(h.pending.at(-1), 0, "응답을 기다리지 않고 취소한 요청의 저장 대기를 풀어야 한다")
    assert.equal(h.notice(), null)
    h.realm.pub(h.core.openNewImageDialog$)
    save("새요청.png")
    assert.notEqual(h.batches[0], h.batches[1])
    h.requests[0].finish(response === "성공" ? Response.json({ path: "assets/cancelled.png" }) : Response.json({ message: "크기를 줄여 주세요." }, { status: 413 }))
    await settleUploads()
    assert.equal(h.realm.getValue(h.core.imageDialogState$).type, "new", "이전 응답으로 새 대화 상자를 닫으면 안 된다")
    assert.equal(h.pending.at(-1), 1)
    assert.equal(h.notice(), null)
    assert.deepEqual(h.changes, [])
    h.requests[1].finish(Response.json({ path: "assets/new.png" }))
    await settleUploads()
    assert.equal(h.pending.at(-1), 0)
    assert.match(h.changes.at(-1)!, /assets\/new.png/)
    assert.ok(h.changes.every((value) => !value.includes("cancelled.png")))
  })
}

for (const kind of ["paste", "drop"] as const) {
  test(`${kind} 한 묶음의 모든 실패 파일·고칠 점을 모으고 개별 성공은 안내를 지우지 않는다`, async (context) => {
    const h = await uploadHarness(context)
    h.dispatch(kind, ["확장자.png", "좋은.png", "큰그림.png"])
    assert.equal(h.batches[0].kind, kind)
    assert.equal(h.batches[0], h.batches[1])
    assert.equal(h.batches[1], h.batches[2])
    h.requests[0].finish(Response.json({ message: "확장자를 맞춰 주세요." }, { status: 415 }))
    await settleUploads()
    assert.match(h.notice()!.message, /그림이 들어가지 않았습니다/)
    assert.match(h.notice()!.message, /확장자.png: 확장자를 맞춰 주세요/)
    h.requests[1].finish(Response.json({ path: "assets/good.png" }))
    await settleUploads()
    assert.match(h.notice()!.message, /확장자.png/)
    h.requests[2].finish(Response.json({ message: "크기를 줄여 주세요." }, { status: 413 }))
    await settleUploads()
    assert.match(h.notice()!.message, /확장자.png: 확장자를 맞춰 주세요/)
    assert.match(h.notice()!.message, /큰그림.png: 크기를 줄여 주세요/)
    assert.deepEqual(h.changes, [], "Promise.all이 거절된 묶음은 성공 파일도 넣지 않는다")
    assert.equal(h.pending.at(-1), 0)
    h.dispatch(kind, ["다음하나.png", "다음둘.png"])
    assert.notEqual(h.batches[2], h.batches[3])
    h.requests[3].finish(Response.json({ path: "assets/next-one.png" }))
    await settleUploads()
    assert.ok(h.notice(), "다음 묶음도 전부 성공하기 전까지 이전 안내를 유지한다")
    h.requests[4].finish(Response.json({ path: "assets/next-two.png" }))
    await settleUploads()
    assert.match(h.notice()!.message, /확장자.png: 확장자를 맞춰 주세요/)
    assert.match(h.notice()!.message, /큰그림.png: 크기를 줄여 주세요/)
    assert.match(h.changes.at(-1)!, /assets\/next-one.png/)
    assert.match(h.changes.at(-1)!, /assets\/next-two.png/)
    assert.doesNotMatch(h.changes.at(-1)!, /assets\/good.png/)
  })
}

test("사람이 닫은 실패 안내는 같은 묶음의 나머지 실패로 다시 열리지 않는다", async (context) => {
  const h = await uploadHarness(context)
  h.dispatch("paste", ["먼저.png", "나중.png"])
  h.requests[0].finish(Response.json({ message: "확장자를 맞춰 주세요." }, { status: 415 }))
  await settleUploads()
  assert.ok(h.notice())
  h.dismiss()
  h.requests[1].finish(Response.json({ message: "크기를 줄여 주세요." }, { status: 413 }))
  await settleUploads()
  assert.equal(h.notice(), null)
  h.dispatch("paste", ["다음실패.png"])
  h.requests[2].finish(Response.json({ message: "그림 형식을 바꿔 주세요." }, { status: 415 }))
  await settleUploads()
  assert.match(h.notice()!.message, /다음실패.png/)
})

test("같은 실행 차례에 발생한 서로 다른 편집기 사건도 다른 묶음으로 다룬다", async (context) => {
  const h = await uploadHarness(context)
  h.dispatch("paste", ["붙임.png"])
  h.dispatch("drop", ["놓음.png"])
  assert.notEqual(h.batches[0], h.batches[1])
  assert.equal(h.batches[0].kind, "paste")
  assert.equal(h.batches[1].kind, "drop")
  h.requests[0].finish(Response.json({ message: "확장자를 맞춰 주세요." }, { status: 415 }))
  await settleUploads()
  assert.match(h.notice()!.message, /붙임.png/)
  h.requests[1].finish(Response.json({ path: "assets/drop.png" }))
  await settleUploads()
  assert.match(h.notice()!.message, /붙임.png: 확장자를 맞춰 주세요/)
  assert.match(h.changes.at(-1)!, /assets\/drop.png/)
})

test("앞 실패와 뒤 실패 뒤 늦은 앞 실패도 모든 파일·고칠 점을 함께 유지한다", async (context) => {
  const h = await uploadHarness(context)
  h.dispatch("paste", ["앞먼저.png", "앞나중.png"])
  h.dispatch("drop", ["뒤먼저.png", "뒤나중.png"])
  h.requests[0].finish(Response.json({ message: "확장자를 맞춰 주세요." }, { status: 415 }))
  await settleUploads()
  h.requests[2].finish(Response.json({ message: "크기를 줄여 주세요." }, { status: 413 }))
  await settleUploads()
  h.requests[1].finish(Response.json({ message: "그림 형식을 바꿔 주세요." }, { status: 415 }))
  await settleUploads()
  assert.equal(h.notice()!.message, [
    "그림이 들어가지 않았습니다.",
    "앞먼저.png: 확장자를 맞춰 주세요.",
    "앞나중.png: 그림 형식을 바꿔 주세요.",
    "뒤먼저.png: 크기를 줄여 주세요.",
  ].join("\n"))
  h.dismiss()
  assert.equal(h.notice(), null)
  h.requests[3].finish(Response.json({ message: "다시 올려 주세요." }, { status: 415 }))
  await settleUploads()
  assert.equal(h.notice(), null, "전체 닫기는 표시된 모든 실패 묶음의 늦은 오류도 숨긴다")
  assert.equal(h.pending.at(-1), 0)
  assert.deepEqual(h.changes, [])
})

test("뒤 묶음 전체 성공 뒤에도 앞 실패와 늦은 앞 실패를 모두 유지한다", async (context) => {
  const h = await uploadHarness(context)
  h.dispatch("paste", ["앞먼저.png", "앞나중.png"])
  h.dispatch("drop", ["뒤성공.png"])
  h.requests[0].finish(Response.json({ message: "확장자를 맞춰 주세요." }, { status: 415 }))
  await settleUploads()
  h.requests[2].finish(Response.json({ path: "assets/success.png" }))
  await settleUploads()
  assert.match(h.notice()!.message, /앞먼저.png: 확장자를 맞춰 주세요/)
  h.requests[1].finish(Response.json({ message: "크기를 줄여 주세요." }, { status: 413 }))
  await settleUploads()
  assert.equal(h.notice()!.message, "그림이 들어가지 않았습니다.\n앞먼저.png: 확장자를 맞춰 주세요.\n앞나중.png: 크기를 줄여 주세요.")
  assert.equal(h.pending.at(-1), 0)
  assert.match(h.changes.at(-1)!, /assets\/success.png/)
})

test("서로 다른 실패 묶음의 파일명·고칠 점이 같아도 각 묶음의 오류를 유지한다", async (context) => {
  const h = await uploadHarness(context)
  h.dispatch("paste", ["같은이름.png"])
  h.dispatch("drop", ["같은이름.png"])
  h.requests[0].finish(Response.json({ message: "확장자를 맞춰 주세요." }, { status: 415 }))
  await settleUploads()
  h.requests[1].finish(Response.json({ message: "확장자를 맞춰 주세요." }, { status: 415 }))
  await settleUploads()
  assert.equal(h.notice()!.message, "그림이 들어가지 않았습니다.\n같은이름.png: 확장자를 맞춰 주세요.\n같은이름.png: 확장자를 맞춰 주세요.")
  assert.equal(h.pending.at(-1), 0)
})

test("대화 상자 폼 안에 숨기지 않은 진행 상태를 두고 취소 단추를 유지한다", () => {
  const render = (pending: boolean) => renderToStaticMarkup(<Dialog.Root open><RichImageUploadForm
    pending={pending} initialValues={{ src: "assets/old.png", altText: "기존 설명", title: "기존 제목" }} onSave={() => {}}
  /></Dialog.Root>)
  const uploading = render(true)
  assert.match(uploading, /<form[^>]*>[\s\S]*role="status"[^>]*>그림 올리는 중[\s\S]*<\/form>/)
  assert.doesNotMatch(uploading, /aria-hidden="true"|hidden=""/)
  assert.match(uploading, /<button type="submit" disabled=""/)
  assert.match(uploading, /<button type="button"[^>]*>취소<\/button>/)
  assert.match(uploading, /value="assets\/old.png"/)
  assert.match(uploading, /value="기존 설명"/)
  assert.match(uploading, /value="기존 제목"/)
  assert.doesNotMatch(render(false), /role="status"/)
})
