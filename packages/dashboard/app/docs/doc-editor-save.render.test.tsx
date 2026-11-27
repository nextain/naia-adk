import assert from "node:assert/strict"
import test from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { DocEditor, EDITOR_MODE_KEY, type DocEditorProps } from "./DocEditor"
import { RichDocEditorBoundary, type RichDocEditorComponentProps, type RichDocEditorProps } from "./RichDocEditor"

const BASE_HASH = "1".repeat(64)
const NEXT_HASH = "2".repeat(64)
const ORIGINAL = "# 원문  \r\n\r\n*   간격 유지\r\n\r\n| 값 | 메모 |\r\n|:---|---:|\r\n| A | 그대로 |\r\n"

type Element = React.ReactElement<Record<string, any>>

function elements(node: React.ReactNode): Element[] {
  if (!React.isValidElement<Record<string, any>>(node)) return []
  const element = node as Element
  return [element, ...React.Children.toArray(element.props.children).flatMap(elements)]
}

function button(tree: React.ReactNode, name: string): Element {
  const found = elements(tree).find((element) => element.type === "button" && element.props.children === name)
  assert.ok(found, `${name} 단추가 있어야 한다`)
  return found
}

function FakeRichEditor({ content }: RichDocEditorProps) {
  return <div>{content}</div>
}

function richProps(tree: React.ReactNode): RichDocEditorProps {
  const found = elements(tree).find((element) => element.type === FakeRichEditor)
  assert.ok(found, "서식 편집기가 있어야 한다")
  return found.props as unknown as RichDocEditorProps
}

// 기존 렌더 시험처럼 컴포넌트가 반환한 실제 이벤트를 실행한다.
// useRef도 렌더 사이에 보존하여 비동기 응답과 최신 입력을 함께 확인한다.
function renderEditor(overrides: Partial<DocEditorProps> = {}) {
  const props: DocEditorProps = {
    source: "adk", path: "common/save.md", initialContent: ORIGINAL,
    initialBaseHash: BASE_HASH, richEditorComponent: FakeRichEditor,
    storage: { getItem: () => null, setItem() {} }, ...overrides,
  }
  const values: unknown[] = []
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  return {
    props,
    render() {
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
        useRef(initial: unknown) {
          const index = cursor++
          if (!(index in values)) values[index] = { current: initial }
          return values[index]
        },
        useEffect() {},
      }
      try { return DocEditor(props) } finally { internals.H = previous }
    },
  }
}

function mountRichEditor(editor: ReturnType<typeof renderEditor>, initialExport: string) {
  const boundary = new RichDocEditorBoundary({
    ...richProps(editor.render()), EditorComponent: () => null, imagePreviewHandler: async (src) => src,
  })
  boundary.componentDidMount()
  const component = (boundary.render() as React.ReactElement<RichDocEditorComponentProps>).props
  component.onChange(initialExport, true)
  return { boundary, change: component.onChange }
}

function sourceTextarea(tree: React.ReactNode): Element {
  const found = elements(tree).find((element) => element.type === "textarea" && element.props["aria-label"] === "문서 원문")
  assert.ok(found)
  return found
}

function saveDialog(tree: React.ReactNode) {
  return elements(tree).find((element) => element.props.role === "alertdialog")
}

test("그림을 모두 삽입할 때까지 저장과 원문 전환을 막고 삽입된 본문을 저장한다", async (context) => {
  const requests: { content: string; baseHash: string }[] = []
  let cancelled = 0
  context.mock.method(globalThis, "fetch", async (_url: unknown, request: RequestInit) => {
    requests.push(JSON.parse(String(request.body)))
    return Response.json({ sha256: NEXT_HASH })
  })
  const editor = renderEditor({ onCancel: () => { cancelled++ } })
  const initial = editor.render()
  const rich = richProps(initial)
  rich.onUploadPendingChange!(2)
  let tree = editor.render()
  assert.equal(button(tree, "저장").props.disabled, true)
  assert.equal(button(tree, "읽기").props.disabled, true)
  assert.equal(button(tree, "원문").props.disabled, true)
  assert.equal(button(tree, "취소").props.disabled, true)
  assert.match(renderToStaticMarkup(tree), /그림 올리는 중/)
  // 이미 렌더된 이벤트가 실행되어도 ref를 통해 대기 상태를 확인한다.
  await button(initial, "저장").props.onClick()
  button(initial, "읽기").props.onClick()
  button(initial, "원문").props.onClick()
  button(initial, "취소").props.onClick()
  assert.equal(cancelled, 0)
  assert.deepEqual(requests, [])
  assert.ok(richProps(editor.render()))
  assert.equal(button(editor.render(), "서식 편집").props["aria-selected"], true)
  rich.onChange(`${ORIGINAL}\n![첫째](assets/one.png)\n`)
  rich.onUploadPendingChange!(1)
  assert.equal(button(editor.render(), "저장").props.disabled, true)
  const inserted = `${ORIGINAL}\n![첫째](assets/one.png)\n![둘째](assets/two.png)\n`
  rich.onChange(inserted)
  rich.onUploadPendingChange!(0)
  tree = editor.render()
  assert.equal(button(tree, "저장").props.disabled, false)
  assert.doesNotMatch(renderToStaticMarkup(tree), /그림 올리는 중/)
  await button(tree, "저장").props.onClick()
  assert.deepEqual(requests, [{ content: inserted, baseHash: BASE_HASH }])
})

test("저장 중 도착한 변경을 유지하고 다음 저장은 갱신된 지문을 쓴다", async (context) => {
  const requests: { content: string; baseHash: string }[] = []
  let finish!: (response: Response) => void
  context.mock.method(globalThis, "fetch", async (_url: unknown, request: RequestInit) => {
    requests.push(JSON.parse(String(request.body)))
    if (requests.length === 1) return new Promise<Response>((resolve) => { finish = resolve })
    return Response.json({ sha256: "3".repeat(64) })
  })
  const completed: string[] = []
  const changes: string[] = []
  const editor = renderEditor({ content: ORIGINAL, onSaveSuccess: (value) => completed.push(value) })
  editor.props.onChangeContent = (value) => {
    changes.push(value)
    editor.props.content = value
  }
  const initial = editor.render()
  const saving = button(initial, "저장").props.onClick()
  // 같은 렌더에서 두 번 눌려도 저장 요청은 하나다.
  await button(initial, "저장").props.onClick()
  assert.equal(requests.length, 1)
  let tree = editor.render()
  assert.equal(richProps(tree).disabled, true)
  const later = `${ORIGINAL}\n![늦게 들어온 그림](assets/later.png)\n`
  richProps(tree).onChange(later)
  tree = editor.render()
  assert.equal(richProps(tree).content, later)
  finish(Response.json({ sha256: NEXT_HASH }))
  await saving
  tree = editor.render()
  assert.equal(richProps(tree).content, later)
  assert.deepEqual(changes, [later])
  assert.deepEqual(completed, [], "이전 본문으로 부모 편집 화면을 닫으면 안 된다")
  assert.match(renderToStaticMarkup(tree), /다시 저장해 주세요/)
  await button(tree, "저장").props.onClick()
  assert.deepEqual(requests, [{ content: ORIGINAL, baseHash: BASE_HASH }, { content: later, baseHash: NEXT_HASH }])
  assert.deepEqual(completed, [later])
})

test("저장 응답보다 늦는 그림 업로드가 있으면 삽입과 추가 저장까지 화면을 유지한다", async (context) => {
  let finish!: (response: Response) => void
  const requests: { content: string; baseHash: string }[] = []
  context.mock.method(globalThis, "fetch", async (_url: unknown, request: RequestInit) => {
    requests.push(JSON.parse(String(request.body)))
    return requests.length === 1 ? new Promise<Response>((resolve) => { finish = resolve }) : Response.json({ sha256: "3".repeat(64) })
  })
  const completed: string[] = []
  const editor = renderEditor({ onSaveSuccess: (value) => completed.push(value) })
  const initial = editor.render()
  const saving = button(initial, "저장").props.onClick()
  richProps(initial).onUploadPendingChange!(1)
  finish(Response.json({ sha256: NEXT_HASH }))
  await saving
  let tree = editor.render()
  assert.deepEqual(completed, [])
  assert.equal(button(tree, "저장").props.disabled, true)
  const inserted = `${ORIGINAL}\n![그림](assets/upload.png)\n`
  richProps(tree).onChange(inserted)
  richProps(tree).onUploadPendingChange!(0)
  tree = editor.render()
  await button(tree, "저장").props.onClick()
  assert.deepEqual(requests.at(-1), { content: inserted, baseHash: NEXT_HASH })
  assert.deepEqual(completed, [inserted])
})

test("원문 대응 실패의 추가 변경 줄수를 확인하고 취소하거나 그대로 저장할 수 있다", async (context) => {
  const requests: string[] = []
  let cancelled = 0
  context.mock.method(globalThis, "fetch", async (_url: unknown, request: RequestInit) => {
    requests.push(JSON.parse(String(request.body)).content)
    return Response.json({ sha256: NEXT_HASH })
  })
  const editor = renderEditor({ onCancel: () => { cancelled++ } })
  const changed = "# 수정한 본문\n\n* 정규화된 줄\n"
  const rich = richProps(editor.render())
  rich.onChange(changed)
  rich.onUnpreservedLinesChange!(3)
  await button(editor.render(), "저장").props.onClick()
  let tree = editor.render()
  const dialog = elements(tree).find((element) => element.props.role === "alertdialog")
  assert.ok(dialog)
  assert.match(renderToStaticMarkup(dialog), /고친 곳 밖 3줄도 바뀝니다/)
  assert.deepEqual(requests, [])
  button(dialog, "취소").props.onClick()
  assert.equal(cancelled, 0)
  tree = editor.render()
  assert.equal(elements(tree).some((element) => element.props.role === "alertdialog"), false)
  assert.equal(richProps(tree).content, changed)
  await button(tree, "저장").props.onClick()
  await button(editor.render(), "그대로 저장").props.onClick()
  assert.deepEqual(requests, [changed])
})

test("저장 확인 뒤 본문이 바뀌면 이전 확인은 닫히고 새 내용을 다시 확인한다", async (context) => {
  const requests: string[] = []
  context.mock.method(globalThis, "fetch", async (_url: unknown, request: RequestInit) => {
    requests.push(JSON.parse(String(request.body)).content)
    return Response.json({ sha256: NEXT_HASH })
  })
  const editor = renderEditor()
  richProps(editor.render()).onUnpreservedLinesChange!(2)
  await button(editor.render(), "저장").props.onClick()
  const oldDialog = elements(editor.render()).find((element) => element.props.role === "alertdialog")
  assert.ok(oldDialog)
  const changed = `${ORIGINAL}\n다음 편집\n`
  richProps(editor.render()).onChange(changed)
  let tree = editor.render()
  assert.equal(elements(tree).some((element) => element.props.role === "alertdialog"), false)
  assert.deepEqual(requests, [])
  // 이미 전달된 확인 이벤트도 예전 본문에 대한 동의를 새 본문에 쓰지 않는다.
  await button(oldDialog, "그대로 저장").props.onClick()
  assert.deepEqual(requests, [])
  tree = editor.render()
  assert.ok(elements(tree).some((element) => element.props.role === "alertdialog"))
  await button(tree, "그대로 저장").props.onClick()
  assert.deepEqual(requests, [changed])
})

test("손대지 않은 서식 편집과 원문 전환 모두 원래 문자열을 그대로 저장한다", async (context) => {
  const requests: string[] = []
  const completed: string[] = []
  context.mock.method(globalThis, "fetch", async (_url: unknown, request: RequestInit) => {
    requests.push(JSON.parse(String(request.body)).content)
    return Response.json({ sha256: NEXT_HASH })
  })
  for (const sourceMode of [false, true]) {
    const stored: Record<string, string> = {}
    const editor = renderEditor({
      storage: { getItem: (key) => stored[key] ?? null, setItem: (key, value) => { stored[key] = value } },
      onSaveSuccess: (value) => completed.push(value),
    })
    let tree = editor.render()
    if (sourceMode) {
      button(tree, "원문").props.onClick()
      tree = editor.render()
      const textarea = elements(tree).find((element) => element.type === "textarea")
      assert.equal(textarea?.props.value, ORIGINAL)
      assert.equal(stored[EDITOR_MODE_KEY], "source")
    }
    assert.equal(button(tree, "저장").props.disabled, false, "바꾸지 않은 문서도 저장할 수 있어야 한다")
    await button(tree, "저장").props.onClick()
  }
  assert.deepEqual(requests, [ORIGINAL, ORIGINAL])
  assert.deepEqual(completed, [ORIGINAL, ORIGINAL])
})

test("손대지 않은 서식에서 읽기 왕복 뒤에도 최초 바이트와 보존 상태로 저장한다", async (context) => {
  const requests: string[] = []
  context.mock.method(globalThis, "fetch", async (_url: unknown, request: RequestInit) => {
    requests.push(JSON.parse(String(request.body)).content)
    return Response.json({ sha256: NEXT_HASH })
  })
  const editor = renderEditor({ renderPreview: (content) => <div data-testid="read-content">{content}</div> })
  const exported = ORIGINAL.replace(/\r\n/g, "\n").replace("*   간격 유지", "* 간격 유지")
  const mounted = mountRichEditor(editor, exported)
  context.after(() => mounted.boundary.componentWillUnmount())
  const session = richProps(editor.render()).preservationSession
  button(editor.render(), "읽기").props.onClick()
  const read = editor.render()
  assert.equal(button(read, "읽기").props["aria-selected"], true)
  assert.equal(elements(read).find((element) => element.props["data-testid"] === "read-content")?.props.children, ORIGINAL)
  assert.equal(richProps(read).preservationSession, session)
  button(read, "서식 편집").props.onClick()
  assert.equal(richProps(editor.render()).preservationSession, session)
  await button(editor.render(), "저장").props.onClick()
  assert.equal(saveDialog(editor.render()), undefined)
  assert.equal(requests.length, 1)
  assert.deepEqual(Buffer.from(requests[0], "utf8"), Buffer.from(ORIGINAL, "utf8"))
})

test("원문에서 읽기를 거쳐 서식으로 돌아와도 기존 추가 변경 경고 판정이 같다", async (context) => {
  const requests: string[] = []
  context.mock.method(globalThis, "fetch", async (_url: unknown, request: RequestInit) => {
    requests.push(JSON.parse(String(request.body)).content)
    return Response.json({ sha256: NEXT_HASH })
  })
  const warnings: string[] = []
  const finalContent = "다시 고친 본문!"
  for (const visitRead of [false, true]) {
    const editor = renderEditor({ initialContent: "[링크]: https://example.com\n\n본문\n" })
    const first = mountRichEditor(editor, "본문")
    first.change("고친 본문")
    button(editor.render(), "원문").props.onClick()
    first.boundary.componentWillUnmount()
    sourceTextarea(editor.render()).props.onChange({ target: { value: "다시 고친 본문" } })
    if (visitRead) {
      button(editor.render(), "읽기").props.onClick()
      assert.equal(button(editor.render(), "읽기").props["aria-selected"], true)
      assert.equal(sourceTextarea(editor.render()).props.value, "다시 고친 본문")
    }
    button(editor.render(), "서식 편집").props.onClick()
    const returned = mountRichEditor(editor, "다시 고친 본문")
    returned.change(finalContent)
    await button(editor.render(), "저장").props.onClick()
    const dialog = saveDialog(editor.render())
    assert.ok(dialog, "원문에서 사라진 링크 정의의 경고를 읽기 전환으로 승인하면 안 된다")
    const warning = renderToStaticMarkup(dialog).match(/고친 곳 밖 \d+줄도 바뀝니다/)?.[0]
    assert.ok(warning)
    warnings.push(warning)
    assert.equal(requests.length, visitRead ? 1 : 0, "확인 전에는 새 저장 요청이 없어야 한다")
    await button(dialog, "그대로 저장").props.onClick()
    returned.boundary.componentWillUnmount()
  }
  assert.equal(warnings[1], warnings[0], "읽기를 거친 경우도 기존 원문→서식 전환과 같은 경고여야 한다")
  assert.deepEqual(requests, [finalContent, finalContent])
})

for (const editSource of [false, true]) {
  test(`미닫힘 코드의 추가 변경 확인은 원문 왕복${editSource ? "과 다른 원문 줄 수정" : ""} 뒤에도 유지된다`, async (context) => {
    const original = "```text\n원래 코드\n"
    const initialExport = "```text\n원래 코드\n```"
    const inserted = `${initialExport}\n\n새 문단\n`
    const requests: string[] = []
    context.mock.method(globalThis, "fetch", async (_url: unknown, request: RequestInit) => {
      requests.push(JSON.parse(String(request.body)).content)
      return Response.json({ sha256: NEXT_HASH })
    })
    const editor = renderEditor({ initialContent: original })
    const first = mountRichEditor(editor, initialExport)
    first.change(`${initialExport}\n\n새 문단`)
    assert.equal(richProps(editor.render()).content, inserted)
    await button(editor.render(), "저장").props.onClick()
    assert.match(renderToStaticMarkup(saveDialog(editor.render())), /고친 곳 밖 1줄도 바뀝니다/)
    button(saveDialog(editor.render()), "취소").props.onClick()
    const session = richProps(editor.render()).preservationSession
    button(editor.render(), "원문").props.onClick()
    first.boundary.componentWillUnmount()
    let expected = inserted
    assert.equal(sourceTextarea(editor.render()).props.value, expected)
    if (editSource) {
      expected = expected.replace("새 문단", "원문에서 고친 문단")
      sourceTextarea(editor.render()).props.onChange({ target: { value: expected } })
      await button(editor.render(), "저장").props.onClick()
      assert.match(renderToStaticMarkup(saveDialog(editor.render())), /고친 곳 밖 \d+줄도 바뀝니다/)
      button(saveDialog(editor.render()), "취소").props.onClick()
    }
    button(editor.render(), "서식 편집").props.onClick()
    assert.equal(richProps(editor.render()).preservationSession, session)
    const returned = mountRichEditor(editor, expected.trimEnd())
    assert.equal(richProps(editor.render()).content, expected, "재진입의 초기 출력은 저장 내용을 바꾸지 않는다")
    expected = expected.replace("문단", "문단!")
    returned.change(expected.trimEnd())
    assert.equal(richProps(editor.render()).content, expected)
    await button(editor.render(), "저장").props.onClick()
    const dialog = saveDialog(editor.render())
    assert.ok(dialog)
    assert.match(renderToStaticMarkup(dialog), /고친 곳 밖 \d+줄도 바뀝니다/)
    assert.deepEqual(requests, [], "아직 확인하지 않은 정규화 변경은 전환으로 승인되지 않는다")
    await button(dialog, "그대로 저장").props.onClick()
    assert.deepEqual(requests, [expected])
    returned.boundary.componentWillUnmount()
  })
}

test("원문을 최초 원문으로 복원하면 즉시 경고·저장 확인·미저장 상태를 해제한다", async (context) => {
  const original = "```text\n원래 코드\n"
  const initialExport = "```text\n원래 코드\n```"
  const requests: string[] = []
  let confirmations = 0, cancelled = 0
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { confirm() { confirmations++; return false } } })
  context.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
  })
  context.mock.method(globalThis, "fetch", async (_url: unknown, request: RequestInit) => {
    requests.push(JSON.parse(String(request.body)).content)
    return Response.json({ sha256: NEXT_HASH })
  })
  const editor = renderEditor({ initialContent: original, onCancel: () => { cancelled++ } })
  const first = mountRichEditor(editor, initialExport)
  first.change(`${initialExport}\n\n새 문단`)
  await button(editor.render(), "저장").props.onClick()
  assert.ok(saveDialog(editor.render()))
  button(editor.render(), "원문").props.onClick()
  first.boundary.componentWillUnmount()
  const sourceTree = editor.render()
  sourceTextarea(sourceTree).props.onChange({ target: { value: original } })
  // A previously rendered save event must see both the restored content and
  // the recomputed zero warning count, before the next React render.
  await button(sourceTree, "저장").props.onClick()
  assert.deepEqual(requests, [original])
  assert.equal(saveDialog(editor.render()), undefined)
  assert.equal(sourceTextarea(editor.render()).props.value, original)
  button(editor.render(), "취소").props.onClick()
  assert.equal(confirmations, 0)
  assert.equal(cancelled, 1)
  button(editor.render(), "서식 편집").props.onClick()
  const returned = mountRichEditor(editor, initialExport)
  returned.change(initialExport.replace("원래 코드", "원래 코드!"))
  await button(editor.render(), "저장").props.onClick()
  assert.equal(saveDialog(editor.render()), undefined, "복원 후 같은 블록만 고치면 이전 경고가 되살아나지 않는다")
  assert.deepEqual(requests, [original, "```text\n원래 코드!\n```\n"])
  returned.boundary.componentWillUnmount()
})

for (const undoSource of ["none", "same-entry", "after-rich"] as const) {
  test(`원문 ${undoSource === "none" ? "직접 수정 없이 " : undoSource === "after-rich" ? "서식 왕복 후 입력 취소와 " : "입력 취소와 "}서식 변경을 모두 되돌리면 왕복 뒤에도 최초 바이트와 경고0을 복원한다`, async (context) => {
    const original = "```text\n원래 코드\n"
    const initialExport = "```text\n원래 코드\n```"
    const requests: string[] = []
    let confirmations = 0, cancelled = 0
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", { configurable: true, value: { confirm() { confirmations++; return false } } })
    context.after(() => {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
    })
    context.mock.method(globalThis, "fetch", async (_url: unknown, request: RequestInit) => {
      requests.push(JSON.parse(String(request.body)).content)
      return Response.json({ sha256: NEXT_HASH })
    })
    const editor = renderEditor({ initialContent: original, onCancel: () => { cancelled++ } })
    const first = mountRichEditor(editor, initialExport)
    first.change(`${initialExport}\n\n새 문단`)
    await button(editor.render(), "저장").props.onClick()
    assert.ok(saveDialog(editor.render()))
    button(editor.render(), "원문").props.onClick()
    first.boundary.componentWillUnmount()
    const content = sourceTextarea(editor.render()).props.value
    if (undoSource !== "none") {
      const manual = content.replace("새 문단", "새 문단!")
      sourceTextarea(editor.render()).props.onChange({ target: { value: manual } })
      if (undoSource === "after-rich") {
        button(editor.render(), "서식 편집").props.onClick()
        const intermediate = mountRichEditor(editor, manual.trimEnd())
        intermediate.change(manual.trimEnd())
        button(editor.render(), "원문").props.onClick()
        intermediate.boundary.componentWillUnmount()
      }
      sourceTextarea(editor.render()).props.onChange({ target: { value: content } })
    }
    button(editor.render(), "서식 편집").props.onClick()
    const returned = mountRichEditor(editor, content.trimEnd())
    returned.change(initialExport)
    assert.equal(richProps(editor.render()).content, original)
    assert.equal(saveDialog(editor.render()), undefined)
    button(editor.render(), "취소").props.onClick()
    assert.equal(confirmations, 0)
    assert.equal(cancelled, 1)
    await button(editor.render(), "저장").props.onClick()
    assert.deepEqual(requests, [original])
    returned.boundary.componentWillUnmount()
  })
}

for (const remaining of ["*같음*\n\n고친 문단", "원문에서 고친 문단\n\n*같음*\n\n고친 문단"]) {
  test(`원문에서 반복 문단 일부를 바꾼 뒤에도 남은 정규화는 저장 확인을 요구한다: ${remaining.split("\n")[0]}`, async (context) => {
    const original = "*같음*\n\n_같음_\n\n다른 문단"
    const exported = "*같음*\n\n*같음*\n\n다른 문단"
    const requests: string[] = []
    context.mock.method(globalThis, "fetch", async (_url: unknown, request: RequestInit) => {
      requests.push(JSON.parse(String(request.body)).content)
      return Response.json({ sha256: NEXT_HASH })
    })
    const editor = renderEditor({ initialContent: original })
    const first = mountRichEditor(editor, exported)
    first.change(exported.replace("다른 문단", "고친 문단"))
    button(editor.render(), "원문").props.onClick()
    first.boundary.componentWillUnmount()
    const source = editor.render()
    sourceTextarea(source).props.onChange({ target: { value: remaining } })
    await button(source, "저장").props.onClick()
    assert.deepEqual(requests, [], "반복 블록 일부를 직접 바꾼 일은 남은 블록의 정규화 승인이 아니다")
    assert.match(renderToStaticMarkup(saveDialog(editor.render())), /고친 곳 밖 \d+줄도 바뀝니다/)
    button(saveDialog(editor.render()), "취소").props.onClick()
    button(editor.render(), "서식 편집").props.onClick()
    const returned = mountRichEditor(editor, remaining)
    returned.change(`${remaining}!`)
    await button(editor.render(), "저장").props.onClick()
    const dialog = saveDialog(editor.render())
    assert.ok(dialog, "서식으로 다시 들어온 뒤에도 경고가 남아야 한다")
    assert.deepEqual(requests, [])
    await button(dialog, "그대로 저장").props.onClick()
    assert.deepEqual(requests, [`${remaining}!`])
    returned.boundary.componentWillUnmount()
  })
}

test("수동 링크 정의가 서식 출력에서 빠져도 원문 바이트를 저장하고 이후 손실은 확인한다", async (context) => {
  const original = "본문\n"
  const exported = "본문"
  const manual = `[링크]: https://example.com\n\n${original}`
  const requests: string[] = []
  context.mock.method(globalThis, "fetch", async (_url: unknown, request: RequestInit) => {
    requests.push(JSON.parse(String(request.body)).content)
    return Response.json({ sha256: NEXT_HASH })
  })
  const editor = renderEditor({ initialContent: original })
  const first = mountRichEditor(editor, exported)
  button(editor.render(), "원문").props.onClick()
  first.boundary.componentWillUnmount()
  sourceTextarea(editor.render()).props.onChange({ target: { value: manual } })
  button(editor.render(), "서식 편집").props.onClick()
  const returned = mountRichEditor(editor, exported)
  returned.change(exported)
  assert.equal(richProps(editor.render()).content, manual)
  await button(editor.render(), "저장").props.onClick()
  assert.equal(saveDialog(editor.render()), undefined)
  assert.deepEqual(requests, [manual])
  returned.change(`${exported}!`)
  await button(editor.render(), "저장").props.onClick()
  const dialog = saveDialog(editor.render())
  assert.ok(dialog, "숨김 구문의 손실을 수동 입력 취소로 승인하지 않는다")
  assert.deepEqual(requests, [manual])
  await button(dialog, "그대로 저장").props.onClick()
  assert.deepEqual(requests, [manual, `${exported}!`])
  returned.boundary.componentWillUnmount()
})

test("원문에서 직접 추가한 코드 닫기는 최초 출력과 같아도 서식 복귀 뒤에 보존한다", async (context) => {
  const original = "```text\n원래 코드\n"
  const initialExport = "```text\n원래 코드\n```"
  const intentionalSource = `${initialExport}\n`
  const requests: string[] = []
  context.mock.method(globalThis, "fetch", async (_url: unknown, request: RequestInit) => {
    requests.push(JSON.parse(String(request.body)).content)
    return Response.json({ sha256: NEXT_HASH })
  })
  const editor = renderEditor({ initialContent: original })
  const first = mountRichEditor(editor, initialExport)
  button(editor.render(), "원문").props.onClick()
  first.boundary.componentWillUnmount()
  sourceTextarea(editor.render()).props.onChange({ target: { value: intentionalSource } })
  button(editor.render(), "서식 편집").props.onClick()
  const returned = mountRichEditor(editor, initialExport)
  returned.change(initialExport)
  assert.equal(richProps(editor.render()).content, intentionalSource)
  await button(editor.render(), "저장").props.onClick()
  assert.equal(saveDialog(editor.render()), undefined)
  assert.deepEqual(requests, [intentionalSource])
  returned.boundary.componentWillUnmount()
})

test("원문에서 직접 고친 줄을 돌아온 서식의 보존 기준으로 쓰고 남은 원본 차이는 확인한다", async (context) => {
  const original = "1. 첫 항목\n\n상태: 초안"
  const requests: string[] = []
  context.mock.method(globalThis, "fetch", async (_url: unknown, request: RequestInit) => {
    requests.push(JSON.parse(String(request.body)).content)
    return Response.json({ sha256: NEXT_HASH })
  })
  const editor = renderEditor({ initialContent: original })
  const first = mountRichEditor(editor, "- 첫 항목\n\n상태: 초안")
  first.change("- 첫 항목\n\n상태: 수정")
  await button(editor.render(), "저장").props.onClick()
  assert.ok(saveDialog(editor.render()))
  button(editor.render(), "원문").props.onClick()
  first.boundary.componentWillUnmount()
  const source = "- 사람이 고친 항목\n\n상태: 수정"
  sourceTextarea(editor.render()).props.onChange({ target: { value: source } })
  button(editor.render(), "서식 편집").props.onClick()
  const returned = mountRichEditor(editor, source)
  const final = source.replace("상태: 수정", "상태: 수정!")
  returned.change(final)
  assert.equal(richProps(editor.render()).content, final)
  await button(editor.render(), "저장").props.onClick()
  const dialog = saveDialog(editor.render())
  assert.ok(dialog, "원문 밖에서 바뀐 나머지 줄은 보수적으로 확인한다")
  assert.deepEqual(requests, [])
  await button(dialog, "그대로 저장").props.onClick()
  assert.deepEqual(requests, [final])
  returned.boundary.componentWillUnmount()
})

test("원문 모드로 시작해 직접 고친 내용은 첫 서식 진입에서도 사용자 편집으로 남는다", async (context) => {
  const original = "_원래 문단_\n\n상태: 초안\n"
  const changed = "_원문에서 수정_\n\n상태: 초안\n"
  const requests: string[] = []
  context.mock.method(globalThis, "fetch", async (_url: unknown, request: RequestInit) => {
    requests.push(JSON.parse(String(request.body)).content)
    return Response.json({ sha256: NEXT_HASH })
  })
  const editor = renderEditor({ initialContent: original })
  button(editor.render(), "원문").props.onClick()
  sourceTextarea(editor.render()).props.onChange({ target: { value: changed } })
  button(editor.render(), "서식 편집").props.onClick()
  const returned = mountRichEditor(editor, "*원문에서 수정*\n\n상태: 초안")
  returned.change("*원문에서 수정*\n\n상태: 수정")
  const final = changed.replace("상태: 초안", "상태: 수정")
  assert.equal(richProps(editor.render()).content, final)
  await button(editor.render(), "저장").props.onClick()
  assert.equal(saveDialog(editor.render()), undefined)
  assert.deepEqual(requests, [final])
  returned.boundary.componentWillUnmount()
})

test("사라진 원문 줄의 경고도 원문 다른 줄 수정과 서식 왕복 뒤에 남는다", async (context) => {
  const original = "[링크]: https://example.com\n\n본문\n"
  const requests: string[] = []
  context.mock.method(globalThis, "fetch", async (_url: unknown, request: RequestInit) => {
    requests.push(JSON.parse(String(request.body)).content)
    return Response.json({ sha256: NEXT_HASH })
  })
  const editor = renderEditor({ initialContent: original })
  const first = mountRichEditor(editor, "본문")
  first.change("고친 본문")
  await button(editor.render(), "저장").props.onClick()
  const warning = renderToStaticMarkup(saveDialog(editor.render()))
  assert.match(warning, /고친 곳 밖 \d+줄도 바뀝니다/)
  button(saveDialog(editor.render()), "취소").props.onClick()
  button(editor.render(), "원문").props.onClick()
  first.boundary.componentWillUnmount()
  sourceTextarea(editor.render()).props.onChange({ target: { value: "다시 고친 본문" } })
  button(editor.render(), "서식 편집").props.onClick()
  const returned = mountRichEditor(editor, "다시 고친 본문")
  returned.change("다시 고친 본문!")
  await button(editor.render(), "저장").props.onClick()
  assert.match(renderToStaticMarkup(saveDialog(editor.render())), /고친 곳 밖 \d+줄도 바뀝니다/)
  assert.deepEqual(requests, [])
  returned.boundary.componentWillUnmount()
  button(editor.render(), "원문").props.onClick()
  const restored = "[링크]: https://example.com\n\n다시 고친 본문!\n"
  sourceTextarea(editor.render()).props.onChange({ target: { value: restored } })
  await button(editor.render(), "저장").props.onClick()
  const dialog = saveDialog(editor.render())
  assert.ok(dialog, "빠진 원문 줄을 복구해도 원문 밖에서 바꾼 본문은 보수적으로 확인한다")
  assert.deepEqual(requests, [])
  await button(dialog, "그대로 저장").props.onClick()
  assert.deepEqual(requests, [restored])
})