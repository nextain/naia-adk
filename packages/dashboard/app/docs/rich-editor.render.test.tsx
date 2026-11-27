import assert from "node:assert/strict"
import test from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { DocEditor, EDITOR_MODE_KEY, type DocEditorProps } from "./DocEditor"
import { DocMarkdown } from "./DocMarkdown"
import { DocsView } from "./DocsView"
import {
  RichDocEditorBoundary,
  RichDocEditorWithComponent,
  RICH_DOC_FALLBACK_NOTICE,
  RICH_DOC_BREAK_FALLBACK_NOTICE,
  RICH_DOC_HTML_FALLBACK_NOTICE,
  type RichDocEditorBoundaryProps,
  type RichDocEditorComponentProps,
  type RichDocEditorProps,
} from "./RichDocEditor"
import { discardRichEditorHtmlPaste, richDocHasHardBreak, richDocNeedsHtmlFallback } from "./rich-editor-html"
import { hardBreakExportVisitor, historyChangedTable } from "./table-cell-changes"
import { MSG_CONFLICT_DOC, MSG_CONFIRM_DISCARD } from "./kinds"
import type { StorageLike } from "./panel-size"
import { uploadRichEditorImage, RichEditorUploadError, type RichEditorUploadBatch } from "./rich-editor-upload"

const BASE_HASH = "1".repeat(64)
const NEXT_HASH = "2".repeat(64)

test("그림을 원시 바이트로 올리고 상대 경로를 반환한다", async (context) => {
  const file = new File([new Uint8Array([137, 80, 78, 71])], "원래 이름.png", { type: "image/png" })
  context.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const query = new URL(url, "http://localhost").searchParams
    assert.equal(query.get("source"), "company:문서")
    assert.equal(query.get("path"), "원고/index.md")
    assert.equal(query.get("name"), file.name)
    assert.equal(init.method, "POST")
    assert.deepEqual(init.headers, { "Content-Type": "application/octet-stream" })
    assert.equal(init.body, file)
    return Response.json({ path: "assets/원래-이름.png", size: file.size, sha256: NEXT_HASH })
  })
  assert.equal(await uploadRichEditorImage("company:문서", "원고/index.md", file), "assets/원래-이름.png")
})

test("실패 알림을 편집기 위에 표시하고 실패한 그림 없이 기존 내용을 저장한다", async (context) => {
  const file = new File(["위장"], "위장.jpg", { type: "image/jpeg" })
  const message = "실제 그림 형식과 확장자를 맞춰 주세요."
  const saved: string[] = []
  context.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    if (init.method === "POST") return Response.json({ error: "type_mismatch", message }, { status: 415 })
    saved.push(JSON.parse(String(init.body)).content)
    return Response.json({ sha256: NEXT_HASH })
  })
  const renderDoc = hookRender(DocEditor, editorProps())
  const props = richProps(renderDoc())
  const renderRich = hookRender(RichDocEditorWithComponent, { ...props, EditorComponent: FakeMdxEditor })
  const child = elements(renderRich()).find((element) => element.type === RichDocEditorBoundary)!
  const boundary = mountBoundary(child.props as unknown as RichDocEditorBoundaryProps)
  const editor = boundary.render() as React.ReactElement<RichDocEditorComponentProps>
  await assert.rejects(editor.props.imageUploadHandler!(file), (error: Error) => error instanceof RichEditorUploadError && error.message === `${file.name}: ${message}`)
  editor.props.onImageUploadSettled!()
  const failedTree = renderRich()
  const alert = elements(failedTree).find((element) => element.props.role === "alert")
  assert.ok(alert)
  assert.match(renderToStaticMarkup(alert), /위장.jpg: 실제 그림 형식과 확장자를 맞춰 주세요/)
  assert.equal(elements(failedTree).findIndex((element) => element.props.role === "alert") < elements(failedTree).findIndex((element) => element.type === RichDocEditorBoundary), true)
  assert.equal(richProps(renderDoc()).content, props.content)
  await button(renderDoc(), "저장").props.onClick()
  assert.deepEqual(saved, [props.content])
  assert.doesNotMatch(saved[0], /위장|assets\//)
  button(failedTree, "닫기").props.onClick()
  assert.equal(elements(renderRich()).some((element) => element.props.role === "alert"), false)
  boundary.componentWillUnmount()
})

test("다음 성공은 오류를 지우고 그림 삽입은 문서를 바꾸되 저장은 단추를 기다린다", async (context) => {
  let succeeds = false
  let saves = 0
  context.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    if (init.method === "PUT") { saves++; return Response.json({ sha256: NEXT_HASH }) }
    return succeeds ? Response.json({ path: "assets/image.png" }) : Response.json({ message: "크기를 줄여 주세요." }, { status: 413 })
  })
  const renderDoc = hookRender(DocEditor, editorProps())
  const props = richProps(renderDoc())
  const renderRich = hookRender(RichDocEditorWithComponent, { ...props, EditorComponent: FakeMdxEditor })
  const boundary = mountBoundary(elements(renderRich()).find((element) => element.type === RichDocEditorBoundary)!.props as unknown as RichDocEditorBoundaryProps)
  const editor = boundary.render() as React.ReactElement<RichDocEditorComponentProps>
  const file = new File(["png"], "image.png", { type: "image/png" })
  await assert.rejects(editor.props.imageUploadHandler!(file))
  editor.props.onImageUploadSettled!()
  assert.ok(elements(renderRich()).some((element) => element.props.role === "alert"))
  succeeds = true
  const relative = await editor.props.imageUploadHandler!(file)
  assert.equal(relative, "assets/image.png")
  assert.equal(elements(renderRich()).some((element) => element.props.role === "alert"), false)
  // 실제 그림 플러그인도 업로드 성공 뒤 이 onChange 경로를 통해 문서를 갱신한다.
  editor.props.onChange(`${props.content}\n![그림](${relative})\n`)
  editor.props.onImageUploadSettled!()
  assert.match(richProps(renderDoc()).content, /!\[그림\]\(assets\/image.png\)/)
  assert.equal(saves, 0)
  await button(renderDoc(), "저장").props.onClick()
  assert.equal(saves, 1)
  boundary.componentWillUnmount()
})

test("그림 오류 닫기 단추는 모든 표시 묶음과 그 묶음의 늦은 실패를 함께 닫는다", async (context) => {
  const responses = new Map<string, (response: Response) => void>()
  context.mock.method(globalThis, "fetch", (url: string) => new Promise<Response>((resolve) => {
    responses.set(new URL(url, "http://localhost").searchParams.get("name")!, resolve)
  }))
  const render = hookRender(RichDocEditorWithComponent, { ...editorProps(), content: "본문", onChange() {}, EditorComponent: FakeMdxEditor })
  const boundary = mountBoundary(elements(render()).find((element) => element.type === RichDocEditorBoundary)!.props as unknown as RichDocEditorBoundaryProps)
  context.after(() => boundary.componentWillUnmount())
  const editor = (boundary.render() as React.ReactElement<RichDocEditorComponentProps>).props
  const batch = (): RichEditorUploadBatch => ({ kind: "paste", pending: 2, errors: [], cancelled: false, dismissed: false })
  const first = batch(), second = batch()
  const fail = async (name: string, batch: RichEditorUploadBatch) => {
    await assert.rejects(editor.imageUploadHandler!(new File(["png"], name), batch), (error: Error) => {
      batch.errors.push(error.message)
      return error instanceof RichEditorUploadError
    })
    batch.pending--
    editor.onImageUploadSettled!({ batch, complete: batch.pending === 0 })
  }
  const earlyFirst = fail("앞먼저.png", first), lateFirst = fail("앞나중.png", first)
  const earlySecond = fail("뒤먼저.png", second), lateSecond = fail("뒤나중.png", second)
  const reject = (name: string) => responses.get(name)!(Response.json({ message: "형식을 바꿔 주세요." }, { status: 415 }))
  reject("앞먼저.png")
  await earlyFirst
  reject("뒤먼저.png")
  await earlySecond
  const alert = elements(render()).find((element) => element.props.role === "alert")
  assert.ok(alert)
  assert.match(renderToStaticMarkup(alert), /앞먼저.png: 형식을 바꿔 주세요/)
  assert.match(renderToStaticMarkup(alert), /뒤먼저.png: 형식을 바꿔 주세요/)
  button(render(), "닫기").props.onClick()
  assert.equal(first.dismissed, true)
  assert.equal(second.dismissed, true)
  reject("앞나중.png")
  reject("뒤나중.png")
  await Promise.all([lateFirst, lateSecond])
  assert.equal(elements(render()).some((element) => element.props.role === "alert"), false)
  const next = fail("새묶음.png", { ...batch(), pending: 1 })
  reject("새묶음.png")
  await next
  const nextAlert = elements(render()).find((element) => element.props.role === "alert")
  assert.ok(nextAlert)
  assert.match(renderToStaticMarkup(nextAlert), /새묶음.png: 형식을 바꿔 주세요/)
  assert.doesNotMatch(renderToStaticMarkup(nextAlert), /앞먼저|앞나중|뒤먼저|뒤나중/)
})

test("연결 실패와 잘못된 응답도 파일 이름과 한국어 고칠점을 돌려준다", async (context) => {
  const file = new File(["png"], "그림.png")
  const fetchMock = context.mock.method(globalThis, "fetch", async () => { throw new TypeError("Failed to fetch") })
  await assert.rejects(uploadRichEditorImage("adk", "index.md", file), /그림.png: 그림을 올리지 못했습니다/)
  fetchMock.mock.mockImplementation(async () => Response.json({ path: "../outside.png" }))
  await assert.rejects(uploadRichEditorImage("adk", "index.md", file), /그림.png: 그림을 올리지 못했습니다/)
})

test("그림 붙여넣기는 막지 않고 HTML과 함께 온 그림도 파일만 다시 보낸다", () => {
  const file = new File(["png"], "그림.png", { type: "image/png" })
  const calls: string[] = []
  const event = {
    clipboardData: { files: [file], types: ["Files"], getData: () => "" } as unknown as DataTransfer,
    preventDefault: () => { calls.push("prevent") },
    stopPropagation: () => { calls.push("stop") },
    target: { dispatchEvent: () => { calls.push("dispatch"); return true } } as unknown as EventTarget,
  }
  discardRichEditorHtmlPaste(event)
  assert.deepEqual(calls, [])
  event.clipboardData = { ...event.clipboardData, files: [file], types: ["Files", "text/html", "text/plain"] } as unknown as DataTransfer
  discardRichEditorHtmlPaste(event, () => { throw new Error("그림을 일반 글자로 바꾸면 안 된다") }, (files) => {
    assert.deepEqual(files, [file])
    calls.push("files")
    return {} as Event
  })
  assert.deepEqual(calls, ["prevent", "stop", "files", "dispatch"])
})

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const values = { ...initial }
  return {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => { values[key] = value },
  }
}

// DOM 의존성을 추가하지 않고 실제 컴포넌트가 반환한 이벤트와 상태를 실행한다.
// 화면 배치는 별도로 React 서버 렌더링을 사용해 확인한다.
function hookRender<Props>(Component: (props: Props) => React.ReactNode, props: Props, effects: (() => void)[] = []) {
  const values: unknown[] = []
  const internals = (React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown }
  }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  return () => {
    let cursor = 0
    const previous = internals.H
    internals.H = {
      useState(initial: unknown) {
        const index = cursor++
        if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial
        return [values[index], (next: unknown) => {
          values[index] = typeof next === "function" ? next(values[index]) : next
        }]
      },
      useEffect(effect: () => void) { effects.push(effect) },
      useCallback(callback: unknown) { return callback },
      useRef(initial: unknown) {
        const index = cursor++
        if (!(index in values)) values[index] = { current: initial }
        return values[index]
      },
    }
    try {
      return Component(props)
    } finally {
      internals.H = previous
    }
  }
}

type Element = React.ReactElement<Record<string, any>>

function elements(node: React.ReactNode): Element[] {
  if (!React.isValidElement<Record<string, any>>(node)) return []
  const element = node as Element
  return [element, ...React.Children.toArray(element.props.children).flatMap(elements)]
}

function button(tree: React.ReactNode, label: string): Element {
  const found = elements(tree).find((element) => element.type === "button" && element.props.children === label)
  assert.ok(found, `${label} 단추가 있어야 한다`)
  return found
}

function FakeRichEditor({ content }: RichDocEditorProps) {
  return <div data-testid="fake-rich-editor">{content}</div>
}

function editorProps(overrides: Partial<DocEditorProps> = {}): DocEditorProps {
  return {
    source: "data:company",
    path: "guide/start.md",
    initialContent: "# 원래 내용\n\n![그림](images/a.png)\n",
    initialBaseHash: BASE_HASH,
    storage: memoryStorage(),
    richEditorComponent: FakeRichEditor,
    ...overrides,
  }
}

function richProps(tree: React.ReactNode): RichDocEditorProps {
  const found = elements(tree).find((element) => element.type === FakeRichEditor)
  assert.ok(found, "서식 편집기가 있어야 한다")
  return found.props as unknown as RichDocEditorProps
}

test("서식 편집·읽기·원문 세 탭은 서식 편집으로 열리고 본문 전체 폭을 쓴다", () => {
  const storage = memoryStorage()
  const render = hookRender(DocEditor, editorProps({ storage }))
  let tree = render()
  const tabs = elements(tree).filter((element) => element.props.role === "tab")
  assert.deepEqual(tabs.map((element) => element.props.children), ["서식 편집", "읽기", "원문"])
  assert.deepEqual(tabs.map((element) => element.props["aria-selected"]), [true, false, false])
  assert.equal(elements(tree).filter((element) => element.props.role === "tablist").length, 1)
  for (const tab of tabs) {
    const target = elements(tree).find((element) => element.props.id === tab.props["aria-controls"])
    assert.ok(target, "탭이 제어하는 본문 영역이 있어야 한다")
    assert.equal(target.props.role, "tabpanel")
    assert.equal(target.props["aria-labelledby"], tab.props.id)
  }
  assert.deepEqual(elements(tree).filter((element) => element.props.role === "tabpanel" && !element.props.hidden).map((element) => element.props.id), ["doc-editor-rich-panel"])
  const richPanel = elements(tree).find((element) => element.props.id === "doc-editor-rich-panel")
  assert.ok(richPanel)
  assert.equal(richPanel.props.role, "tabpanel")
  assert.notEqual(richPanel.props.hidden, true)
  assert.match(richPanel.props.className, /\bw-full\b/)
  const html = renderToStaticMarkup(tree)
  assert.match(html, /data-testid="fake-rich-editor"/)
  assert.doesNotMatch(html, /editor-resizer|--editor-split|md:flex-row/)
  assert.equal(elements(tree).some((element) => element.type === "button" && ["편집", "미리보기"].includes(element.props.children)), false)

  button(tree, "원문").props.onClick()
  tree = render()
  assert.equal(button(tree, "원문").props["aria-selected"], true)
  assert.equal(storage.getItem(EDITOR_MODE_KEY), "source")
  const textarea = elements(tree).find((element) => element.type === "textarea")
  assert.equal(textarea?.props.value, editorProps().initialContent)
  assert.doesNotMatch(renderToStaticMarkup(tree), /data-testid="fake-rich-editor"/)

  textarea!.props.onChange({ target: { value: "# 원문에서 수정\n" } })
  tree = render()
  button(tree, "서식 편집").props.onClick()
  tree = render()
  assert.equal(storage.getItem(EDITOR_MODE_KEY), "rich")
  assert.equal(richProps(tree).content, "# 원문에서 수정\n")
  assert.equal(richProps(tree).source, "data:company")
  assert.equal(richProps(tree).path, "guide/start.md")
})

test("읽기는 저장 전 내용을 표시하며 직전 서식·원문 편집 상태를 숨겨 보존한다", () => {
  for (const mode of ["서식 편집", "원문"] as const) {
    const storage = memoryStorage()
    const render = hookRender(DocEditor, editorProps({
      storage,
      renderPreview: (content) => <div data-testid="read-renderer">{content}</div>,
    }))
    let tree = render()
    if (mode === "원문") {
      button(tree, "원문").props.onClick()
      tree = render()
    }
    const changed = `# ${mode}에서 저장 전 수정\n`
    if (mode === "서식 편집") richProps(tree).onChange(changed)
    else elements(tree).find((element) => element.type === "textarea")!.props.onChange({ target: { value: changed } })
    tree = render()
    const panelId = mode === "서식 편집" ? "doc-editor-rich-panel" : "doc-editor-source-panel"
    const previousPanel = elements(tree).find((element) => element.props.id === panelId)!
    const previousEditor = elements(previousPanel).find((element) => element.type === FakeRichEditor || element.type === "textarea")!
    const storedMode = storage.getItem(EDITOR_MODE_KEY)
    button(tree, "읽기").props.onClick()
    tree = render()
    assert.deepEqual(elements(tree).filter((element) => element.props.role === "tab").map((element) => element.props["aria-selected"]), [false, true, false])
    const readPanel = elements(tree).find((element) => element.props.id === "doc-editor-read-panel")
    assert.ok(readPanel)
    assert.notEqual(readPanel.props.hidden, true)
    assert.deepEqual(elements(tree).filter((element) => element.props.role === "tabpanel" && !element.props.hidden).map((element) => element.props.id), ["doc-editor-read-panel"])
    const preview = elements(readPanel).find((element) => element.props["data-testid"] === "read-renderer")
    assert.equal(preview?.props.children, changed)
    const hiddenPanel = elements(tree).find((element) => element.props.id === panelId)!
    assert.equal(hiddenPanel.props.hidden, true)
    const hiddenEditor = elements(hiddenPanel).find((element) => element.type === previousEditor.type)!
    assert.equal(hiddenEditor.key, previousEditor.key)
    assert.equal(hiddenEditor.props.content ?? hiddenEditor.props.value, changed)
    if (mode === "서식 편집") assert.equal(hiddenEditor.props.preservationSession, previousEditor.props.preservationSession)
    assert.equal(storage.getItem(EDITOR_MODE_KEY), storedMode, "읽기는 편집 방식 선택을 덮어쓰지 않는다")
    button(tree, mode).props.onClick()
    tree = render()
    assert.equal(button(tree, mode).props["aria-selected"], true)
    assert.notEqual(elements(tree).find((element) => element.props.id === panelId)!.props.hidden, true)
    assert.equal(elements(tree).some((element) => element.props["data-testid"] === "read-renderer"), false)
  }
})

test("저장된 원문 모드와 잘못된 값·저장소 실패 모두 새 편집은 서식 편집으로 연다", () => {
  const restored = hookRender(DocEditor, editorProps({ storage: memoryStorage({ [EDITOR_MODE_KEY]: "source" }) }))()
  assert.equal(button(restored, "서식 편집").props["aria-selected"], true)
  assert.equal(elements(restored).some((element) => element.type === "textarea"), false)

  const invalid = hookRender(DocEditor, editorProps({ storage: memoryStorage({ [EDITOR_MODE_KEY]: "unknown" }) }))()
  assert.equal(button(invalid, "서식 편집").props["aria-selected"], true)

  const failingStorage: StorageLike = {
    getItem() { throw new Error("storage denied") },
    setItem() { throw new Error("storage full") },
  }
  const render = hookRender(DocEditor, editorProps({ storage: failingStorage }))
  let tree = render()
  assert.equal(button(tree, "서식 편집").props["aria-selected"], true)
  assert.doesNotThrow(() => button(tree, "원문").props.onClick())
  tree = render()
  assert.equal(button(tree, "원문").props["aria-selected"], true)
})

test("브라우저에 원문 선택이 남아 있어도 첫 렌더 뒤 서식 편집 기본값을 유지한다", () => {
  let reads = 0
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: {
      getItem(key: string) { reads++; return key === EDITOR_MODE_KEY ? "source" : null },
      setItem() {},
    },
  } })
  try {
    const effects: (() => void)[] = []
    const render = hookRender(DocEditor, editorProps({ storage: undefined }), effects)
    let tree = render()
    assert.equal(button(tree, "서식 편집").props["aria-selected"], true)
    assert.equal(reads, 0, "첫 렌더에서는 브라우저 모드를 읽지 않아야 한다")
    effects.forEach((effect) => effect())
    tree = render()
    assert.equal(button(tree, "서식 편집").props["aria-selected"], true)
    assert.equal(reads, 0)
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})

test("편집 중 읽기에는 저장 전 본문을 기존 DocMarkdown 렌더러와 문서 경로로 전달한다", () => {
  const render = hookRender<React.ComponentProps<typeof DocsView>>(DocsView, {
    activeTab: "common", sources: [], tabSections: [],
    currentSource: "adk", currentPath: "guide/start.md", viewMode: "doc",
    docContent: "# 저장된 본문\n", docBaseHash: BASE_HASH,
    isEditing: true, editContent: "# 저장 전 본문\n",
  })
  const editor = elements(render()).find((element) => element.type === DocEditor)
  assert.ok(editor)
  const read = editor.props.renderPreview("# 아직 저장하지 않은 다음 본문\n") as Element
  assert.equal(read.type, DocMarkdown)
  assert.equal(read.props.content, "# 아직 저장하지 않은 다음 본문\n")
  assert.equal(read.props.sourceId, "adk")
  assert.equal(read.props.path, "guide/start.md")
  assert.equal(read.props.activeTab, "common")
})

const FakeMdxEditor = ({ markdown }: RichDocEditorComponentProps) => <div>{markdown}</div>

function boundaryProps(overrides: Partial<RichDocEditorBoundaryProps> = {}): RichDocEditorBoundaryProps {
  return {
    source: "data:company",
    path: "guide/start.md",
    content: "# 원래 내용\n",
    onChange() {},
    EditorComponent: FakeMdxEditor,
    imagePreviewHandler: async (src) => src,
    ...overrides,
  }
}

// React 서버 렌더링은 오류 경계를 실행하지 않는다. 경계 lifecycle만 직접 실행한다.
function mountBoundary(props: RichDocEditorBoundaryProps) {
  const boundary = new RichDocEditorBoundary(props)
  boundary.setState = ((next: { failed?: boolean }) => {
    boundary.state = { ...boundary.state, ...next }
  }) as typeof boundary.setState
  boundary.componentDidMount()
  return boundary
}

const htmlFallbackCases = [
  ["이벤트 속성이 있는 HTML", '<div onclick="alert(1)">누르기</div>'],
  ["HTML 주석", "<!-- 메모: 그대로 유지 -->"],
  ["식별자가 있는 HTML", '<sup id="fnref-1">1</sup>'],
  ["JSX 흐름 요소", "<Callout count={1} />"],
  ["JSX 본문 요소", "문장 <Callout count={1} /> 뒤"],
  ["밑줄 JSX 이름", "<_Widget />"],
  ["달러 JSX 이름", "<$Widget />"],
  ["유니코드 JSX 이름", "<한글 />"],
] as const

for (const [label, syntax] of htmlFallbackCases) {
  test(`${label} 문서는 서식 편집기를 실행하지 않고 본문 수정 뒤에도 원문을 그대로 저장한다`, async (context) => {
    const original = `---\ntitle: "원본"\n---\n\n# 원래 제목\n\n본문 문장\n\n${syntax}\n\n끝 공백  \n`
    const changed = original.replace("본문 문장", "고친 본문 문장")
    let richEditorCalls = 0
    const ForbiddenRichEditor = (_props: RichDocEditorComponentProps): React.ReactNode => {
      richEditorCalls++
      throw new Error("HTML/JSX 문서는 서식 편집기로 전달하면 안 된다")
    }
    const CheckedRichEditor = (props: RichDocEditorProps) => (
      <RichDocEditorWithComponent {...props} EditorComponent={ForbiddenRichEditor} />
    )
    let request: RequestInit | undefined
    context.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
      request = init
      return new Response(JSON.stringify({ sha256: NEXT_HASH }), { status: 200 })
    })
    const render = hookRender(DocEditor, editorProps({ initialContent: original, richEditorComponent: CheckedRichEditor }))
    let tree = render()
    const html = renderToStaticMarkup(tree)
    assert.match(html, new RegExp(RICH_DOC_HTML_FALLBACK_NOTICE))
    assert.match(html, /aria-label="원문 편집"/)
    assert.equal(richEditorCalls, 0)
    assert.doesNotMatch(html, /<div onclick=|<sup id=|<!-- 메모/)

    await button(tree, "저장").props.onClick()
    const initiallySaved = JSON.parse(String(request?.body))
    assert.equal(initiallySaved.baseHash, BASE_HASH)
    assert.deepEqual(Buffer.from(initiallySaved.content, "utf8"), Buffer.from(original, "utf8"))
    tree = render()

    const rich = elements(tree).find((element) => element.type === CheckedRichEditor)
    assert.ok(rich)
    const boundary = mountBoundary(boundaryProps({ ...rich.props, EditorComponent: ForbiddenRichEditor }))
    const textarea = elements(boundary.render()).find((element) => element.type === "textarea")
    assert.ok(textarea)
    assert.equal(textarea.props.value, original)
    textarea.props.onChange({ target: { value: changed } })
    tree = render()
    await button(tree, "저장").props.onClick()
    const saved = JSON.parse(String(request?.body))
    assert.equal(saved.baseHash, NEXT_HASH)
    assert.deepEqual(Buffer.from(saved.content, "utf8"), Buffer.from(changed, "utf8"))
    assert.equal(richEditorCalls, 0)
    boundary.componentWillUnmount()
  })
}

test("중괄호 식은 서식 편집기에서 보통 글자이므로 서식 편집을 유지한다", () => {
  for (const content of ["{1 + 1}\n", "문장 {1 + 1} 뒤\n", "| 첫 인사 | 소개 양식 \"OOO {직급}입니다\" |\n|---|---|\n", "{a b} 와 <Callout />\n"]) {
    assert.equal(richDocNeedsHtmlFallback(content), content.includes("<Callout"), content)
  }
})

test("코드 블록·인라인 코드·머리말 안의 웹 태그와 MDX 식은 서식 편집을 유지한다", () => {
  const content = '---\ntitle: "<div onclick=\\"alert(1)\\"> {1 + 1}"\n---\n\n```html\n<div onclick="alert(1)">예시</div>\n<!-- 예시 주석 -->\n<Callout count={1} />\n{1 + 1}\n```\n\n`<sup id="fnref-1">1</sup>` 및 `{1 + 1}`\n'
  assert.equal(richDocNeedsHtmlFallback(content), false)
  const boundary = mountBoundary(boundaryProps({ content }))
  const editor = boundary.render() as React.ReactElement<RichDocEditorComponentProps>
  assert.equal(editor.type, FakeMdxEditor)
  assert.equal(editor.props.markdown, content)
  assert.doesNotMatch(renderToStaticMarkup(editor), /<textarea/)
  boundary.componentWillUnmount()
})

test("목록과 GFM 표에 들어 있는 HTML도 본문 전체 검사로 원문 전환한다", () => {
  assert.equal(richDocNeedsHtmlFallback('- 항목 <span data-id="x">값</span>\n'), true)
  assert.equal(richDocNeedsHtmlFallback('| 이름 | 값 |\n| --- | --- |\n| 표 | <sup id="ref">1</sup> |\n'), true)
})

test("일반 Markdown 비교 문장·자동 링크·이스케이프한 중괄호는 서식 편집을 유지한다", () => {
  for (const content of ["2 < 3이고 4 > 3입니다.\n", "2<3이고 4>3입니다.\n", "<https://example.com>\n", "문장 \\{1 + 1\\} 뒤\n"]) {
    assert.equal(richDocNeedsHtmlFallback(content), false, content)
    const boundary = mountBoundary(boundaryProps({ content }))
    assert.equal((boundary.render() as React.ReactElement).type, FakeMdxEditor)
    boundary.componentWillUnmount()
  }
})

test("편집 중 새 HTML 구문이 들어와도 다음 렌더 전에 원문으로 전환한다", () => {
  const boundary = mountBoundary(boundaryProps())
  const content = '# 바뀐 내용\n\n<div onclick="alert(1)">내용</div>\n'
  const props = { ...boundary.props, content }
  const next = RichDocEditorBoundary.getDerivedStateFromProps(props, boundary.state)
  assert.ok(next)
  Object.assign(boundary, { props, state: { ...boundary.state, ...next } })
  const fallback = boundary.render()
  assert.match(renderToStaticMarkup(fallback), new RegExp(RICH_DOC_HTML_FALLBACK_NOTICE))
  assert.equal(elements(fallback).find((element) => element.type === "textarea")?.props.value, content)
  boundary.componentWillUnmount()
})

test("HTML 파싱에 실패해도 내용을 바꾸지 않고 원문 편집을 사용한다", () => {
  const content = "# 제목\n\n<Component value={\n"
  const boundary = mountBoundary(boundaryProps({ content }))
  assert.equal(elements(boundary.render()).find((element) => element.type === "textarea")?.props.value, content)
  boundary.componentWillUnmount()
})

test("HTML 붙여넣기는 HTML을 버리고 함께 온 일반 글자만 다시 붙여 넣는다", () => {
  for (const types of [["text/html", "text/plain"], ["application/x-lexical-editor", "text/plain"]]) {
    const calls: string[] = []
    const dispatched: string[] = []
    const target = { dispatchEvent(event: Event) { dispatched.push(event.type); return true } } as unknown as EventTarget
    discardRichEditorHtmlPaste({
      clipboardData: { types, getData: (type: string) => type === "text/plain" ? "붙여 넣을 글" : "<b>굵게</b>" } as unknown as DataTransfer,
      preventDefault() { calls.push("preventDefault") },
      stopPropagation() { calls.push("stopPropagation") },
      target,
    }, (text) => {
      calls.push(`plain:${text}`)
      return { type: "paste" } as Event
    })
    assert.deepEqual(calls, ["preventDefault", "stopPropagation", "plain:붙여 넣을 글"])
    assert.deepEqual(dispatched, ["paste"])
  }
  const htmlOnly: string[] = []
  discardRichEditorHtmlPaste({
    clipboardData: { types: ["text/html"], getData: () => "" } as unknown as DataTransfer,
    preventDefault() { htmlOnly.push("preventDefault") },
    stopPropagation() { htmlOnly.push("stopPropagation") },
    target: null,
  }, () => { htmlOnly.push("plain"); return null })
  assert.deepEqual(htmlOnly, ["preventDefault", "stopPropagation"])
  const calls: string[] = []
  discardRichEditorHtmlPaste({
    clipboardData: { types: ["text/plain"], getData: () => "글" } as unknown as DataTransfer,
    preventDefault() { calls.push("preventDefault") },
    stopPropagation() { calls.push("stopPropagation") },
    target: null,
  })
  assert.deepEqual(calls, [])
})

test("줄 끝 강제 줄바꿈이 있는 문서는 원문 편집으로 열고 코드 안의 같은 모양은 그대로 둔다", () => {
  assert.equal(richDocHasHardBreak("첫 줄  \n둘째 줄\n"), true)
  assert.equal(richDocHasHardBreak("첫 줄\\\n둘째 줄\n"), true)
  assert.equal(richDocHasHardBreak("---\ntitle: 글\n---\n\n첫 줄\n둘째 줄\n"), false)
  assert.equal(richDocHasHardBreak("```\n코드  \n다음\n```\n"), false)
  const boundary = mountBoundary(boundaryProps({ content: "첫 줄  \n둘째 줄\n" }))
  assert.equal(boundary.state.failed, true)
  assert.equal(boundary.state.notice, RICH_DOC_BREAK_FALLBACK_NOTICE)
  boundary.componentWillUnmount()
})

test("Shift+Enter 줄바꿈은 마크다운 강제 줄바꿈으로 내보낸다", () => {
  const appended: unknown[] = []
  assert.equal(hardBreakExportVisitor.testLexicalNode({ getType: () => "linebreak" }), true)
  assert.equal(hardBreakExportVisitor.testLexicalNode({ getType: () => "text" }), false)
  hardBreakExportVisitor.visitLexicalNode({ mdastParent: "부모", actions: { appendToParent: (parent, node) => appended.push([parent, node]) } })
  assert.deepEqual(appended, [["부모", { type: "break" }]])
})

test("되돌리기·다시하기가 표를 바꿀 때만 편집기를 다시 연다", () => {
  const state = (types: Record<string, string>) => ({ _nodeMap: new Map(Object.entries(types).map(([key, type]) => [key, { getType: () => type }])) })
  const update = (tags: string[], dirty: string[]) => ({
    tags: new Set(tags),
    dirtyElements: new Map(dirty.map((key) => [key, true])),
    dirtyLeaves: new Set<string>(),
    editorState: state({ "1": "paragraph", "2": "table" }),
    prevEditorState: state({ "1": "paragraph", "3": "table" }),
  })
  assert.equal(historyChangedTable(update(["historic"], ["2"])), true)
  assert.equal(historyChangedTable(update(["historic"], ["3"])), true)
  assert.equal(historyChangedTable(update(["historic"], ["1"])), false)
  assert.equal(historyChangedTable(update([], ["2"])), false)
})

test("초기 마크다운 정규화만 무시하고 첫 실제 변경부터 전달한다", () => {
  const changes: string[] = []
  const boundary = mountBoundary(boundaryProps({ onChange: (value) => changes.push(value) }))
  const fake = boundary.render() as React.ReactElement<RichDocEditorComponentProps>
  fake.props.onChange("# 정규화된 문서\n", true)
  assert.deepEqual(changes, [])
  fake.props.onChange("# 첫 실제 입력\n", false)
  fake.props.onChange("# 두 번째 입력\n")
  assert.deepEqual(changes, ["# 첫 실제 입력\n", "# 두 번째 입력\n"])
  boundary.componentWillUnmount()
})

test("편집기 onError는 최신 내용과 출처·경로를 보존한 원문 편집으로 전환한다", async () => {
  const changes: string[] = []
  const props = boundaryProps({ onChange: (value) => changes.push(value) })
  const boundary = mountBoundary(props)
  let fake = boundary.render() as React.ReactElement<RichDocEditorComponentProps>
  const latestContent = "# 아직 저장하지 않은 최신 내용\n"
  fake.props.onChange(latestContent)
  // 부모가 편집 결과를 새 content prop으로 돌려주는 상황을 재현한다.
  Object.assign(boundary, { props: { ...props, content: changes[0] } })
  fake = boundary.render() as React.ReactElement<RichDocEditorComponentProps>
  fake.props.onError({ error: "unsupported syntax", source: "파서가 돌려준 다른 내용" })
  await Promise.resolve()
  const fallback = boundary.render()
  const html = renderToStaticMarkup(fallback)
  assert.match(html, new RegExp(RICH_DOC_FALLBACK_NOTICE))
  const textarea = elements(fallback).find((element) => element.type === "textarea")
  assert.equal(textarea?.props.value, latestContent)
  assert.equal(boundary.props.source, "data:company")
  assert.equal(boundary.props.path, "guide/start.md")
  assert.deepEqual(changes, [latestContent], "오류의 source가 문서 내용을 덮어쓰면 안 된다")
  textarea!.props.onChange({ target: { value: "# 원문으로 복구\n" } })
  assert.deepEqual(changes, [latestContent, "# 원문으로 복구\n"])
  boundary.componentWillUnmount()
})

test("가짜 편집기가 던진 예외는 오류 경계 lifecycle 이후 원문과 안내문을 렌더한다", () => {
  const failure = new Error("editor rendering failed")
  const ThrowingEditor = (_props: RichDocEditorComponentProps): React.ReactNode => { throw failure }
  const props = boundaryProps({ EditorComponent: ThrowingEditor, content: "# 예외 전 최신 내용\n" })
  const boundary = mountBoundary(props)
  const child = boundary.render() as React.ReactElement<RichDocEditorComponentProps>
  assert.equal(child.type, ThrowingEditor)
  assert.throws(() => ThrowingEditor(child.props), (error) => {
    assert.equal(error, failure)
    boundary.state = { ...boundary.state, ...RichDocEditorBoundary.getDerivedStateFromError() }
    return true
  })
  const html = renderToStaticMarkup(boundary.render())
  assert.match(html, new RegExp(RICH_DOC_FALLBACK_NOTICE))
  assert.match(html, /# 예외 전 최신 내용/)
  assert.match(html, /<textarea/)
  boundary.componentWillUnmount()
})

test("서식 그림 미리보기는 같은 출처의 상대 경로를 쓰고 저장할 마크다운은 보존한다", async () => {
  const content = "![그림](images/a.png)\n"
  const tree = hookRender(RichDocEditorWithComponent, {
    source: "data:company",
    path: "guide/start.md",
    content,
    onChange() {},
    EditorComponent: FakeMdxEditor,
  })()
  const element = elements(tree).find((node) => node.type === RichDocEditorBoundary)
  assert.ok(element)
  assert.equal(element.props.content, content)
  assert.equal(await element.props.imagePreviewHandler("images/a.png"), "/api/portal/asset?source=data%3Acompany&path=guide%2Fimages%2Fa.png")
  assert.equal(await element.props.imagePreviewHandler("https://example.com/a.png"), "https://example.com/a.png")
  assert.equal(element.props.source, "data:company")
  assert.equal(element.props.path, "guide/start.md")
})
