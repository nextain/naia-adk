import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { setTimeout } from "node:timers/promises"
import test, { type TestContext } from "node:test"
import React from "react"
import { createRichDocEditorPlugins } from "./RichDocEditorPlugins"
import { DocEditor, saveDocument } from "./DocEditor"
import { RichDocEditorBoundary, type RichDocEditorProps } from "./RichDocEditor"
import { cleanRichEditorMarkdown, RichEditorPreservation, RichEditorPreservationSession, RICH_EDITOR_MARKDOWN_OPTIONS } from "./rich-editor-preservation"
import { TableCellChangeListener } from "./table-cell-changes"

const dashboardRequire = createRequire(__filename)
const editorRequire = createRequire(dashboardRequire.resolve("@mdxeditor/editor"))
const { Realm } = editorRequire("@mdxeditor/gurx")
const core = dashboardRequire("@mdxeditor/editor")
const lexical = editorRequire("lexical")

async function documentEditor(source: string) {
  const preservation = new RichEditorPreservation(source)
  let saved = source
  const warnings: number[] = []
  const exports: string[] = []
  const errors: unknown[] = []
  const plugins = [
    core.corePlugin({
      initialMarkdown: source,
      iconComponentFor: () => null,
      translation: (_key: string, fallback: string) => fallback,
      suppressHtmlProcessing: true,
      toMarkdownOptions: RICH_EDITOR_MARKDOWN_OPTIONS,
      onChange(markdown: string, initial: boolean) {
        const cleaned = cleanRichEditorMarkdown(markdown)
        exports.push(cleaned)
        if (initial) preservation.setInitialExport(cleaned)
        else {
          const result = preservation.preserve(cleaned)
          saved = result.markdown
          warnings.push(result.unpreservedLines)
        }
      },
      onError(error: unknown) { errors.push(error) },
    }),
    ...createRichDocEditorPlugins(async (src) => src),
  ]
  const realm = new Realm()
  for (const plugin of plugins) plugin.init?.(realm)
  for (const plugin of plugins) plugin.postInit?.(realm)
  await setTimeout(0)
  const editor = realm.getValue(core.rootEditor$)
  editor._headless = true
  return { realm, editor, errors, warnings, exports, saved: () => saved }
}

const fixture = readFileSync(new URL("./fixtures/rich-editor-preservation.md", import.meta.url), "utf8")

function assertRawModePreserved(source: string, initialExport: string) {
  const values: unknown[] = []
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const FakeRich = (_props: RichDocEditorProps) => null
  const render = () => {
    let cursor = 0
    const previous = internals.H
    internals.H = {
      useState(initial: unknown) {
        const index = cursor++
        if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial
        return [values[index], (next: unknown) => { values[index] = typeof next === "function" ? next(values[index]) : next }]
      },
      useRef(initial: unknown) { const index = cursor++; return values[index] ??= { current: initial } },
      useEffect() {},
      useCallback(callback: unknown) { return callback },
    }
    try { return DocEditor({ source: "adk", path: "trial.md", initialContent: source, initialBaseHash: "1".repeat(64), richEditorComponent: FakeRich }) }
    finally { internals.H = previous }
  }
  const elements = (node: React.ReactNode): React.ReactElement<Record<string, any>>[] => {
    if (!React.isValidElement<Record<string, any>>(node)) return []
    const element = node as React.ReactElement<Record<string, any>>
    return [element, ...React.Children.toArray(element.props.children).flatMap(elements)]
  }
  let tree = render()
  const rich = elements(tree).find((node) => node.type === FakeRich)!
  const boundary = new RichDocEditorBoundary({ ...rich.props as unknown as RichDocEditorProps, EditorComponent: () => null, imagePreviewHandler: async (src) => src })
  const child = boundary.render() as React.ReactElement<{ onChange(markdown: string, initial: boolean): void }>
  child.props.onChange(initialExport, true)
  tree = render()
  elements(tree).find((node) => node.type === "button" && node.props.children === "원문")!.props.onClick()
  assert.equal(elements(render()).find((node) => node.type === "textarea")!.props.value, source)
}

test("실제 편집기 초기 내보내기·선택 이동은 원문 바이트를 유지하고 한 줄 수정만 반영한다", async () => {
  const result = await documentEditor(fixture)
  assert.deepEqual(result.errors, [])
  assert.equal(result.saved(), fixture)
  result.editor.update(() => lexical.$getRoot().getFirstChild().selectEnd(), { discrete: true })
  assert.equal(result.saved(), fixture)
  result.editor.update(() => {
    const text = lexical.$getRoot().getAllTextNodes().find((node: { getTextContent(): string }) => node.getTextContent() === "상태: 사전검수 기다림")
    assert.ok(text, "실제 상태 줄 TextNode를 찾아야 한다")
    text.setTextContent("상태: 승인 요청")
  }, { discrete: true })
  assert.equal(result.saved(), fixture.replace("상태: 사전검수 기다림", "상태: 승인 요청"))
  assert.ok(result.warnings.every((count) => count === 0))
})

test("실제 내보내기는 단일 물결표·대괄호·등호를 보존하고 이중 취소선과 짧은 표를 유지한다", async () => {
  const result = await documentEditor(fixture)
  const exported = result.exports.at(-1)!
  assert.match(exported, /269~272줄과 60~67행, 2024~2026년, 2~9월, 값=내용/)
  assert.match(exported, /~~취소선~~/)
  assert.match(exported, /\[연구노트\]/)
  assert.match(exported, /\n- 첫 항목\n- 둘째 항목/)
  assert.match(exported, /\n---\n/)
  assert.match(exported, /주소: https:\/\/example.com\/guide/)
  assert.match(exported, /\|본문\|근거\|\n\|-+\|-+\|/)
  assert.doesNotMatch(exported, /\\[\[=~]/)
  const formats: { value: string; strike: boolean }[] = []
  result.editor.getEditorState().read(() => lexical.$getRoot().getAllTextNodes().forEach((node: { getTextContent(): string; hasFormat(format: string): boolean }) => formats.push({ value: node.getTextContent(), strike: node.hasFormat("strikethrough") })))
  assert.ok(formats.some((entry) => entry.value.includes("269~272") && !entry.strike))
  assert.ok(formats.some((entry) => entry.value === "취소선" && entry.strike))
})

test("블록 삽입·삭제·반복 블록을 순서대로 대응하고 원래 공백을 유지한다", () => {
  const original = "\n# 제목\n\n\n같은 문단\n\n같은 문단\n\n끝\n\n"
  const baseline = "# 제목\n\n같은 문단\n\n같은 문단\n\n끝"
  const preservation = new RichEditorPreservation(original)
  preservation.setInitialExport(baseline)
  assert.equal(preservation.preserve(baseline).markdown, original)
  assert.deepEqual(preservation.preserve("# 제목\n\n새 문단\n\n같은 문단\n\n같은 문단\n\n끝"), { markdown: "\n# 제목\n\n새 문단\n\n\n같은 문단\n\n같은 문단\n\n끝\n\n", unpreservedLines: 0 })
  assert.equal(preservation.preserve("# 제목\n\n같은 문단\n\n끝").markdown, "\n# 제목\n\n\n같은 문단\n\n끝\n\n")
})

test("제목 삭제 후 목록과 뒤 문단 사이에 빈 줄을 보충해 구조를 유지한다", async () => {
  const result = await documentEditor("- 항목\n# 제목\n이어지는 글\n")
  assert.deepEqual(result.errors, [])
  result.editor.update(() => {
    lexical.$getRoot().getChildren().find((node: { getType(): string }) => node.getType() === "heading").remove()
  }, { discrete: true })
  assert.equal(result.saved(), "- 항목\n\n이어지는 글\n")
  assert.ok(result.warnings.every((count) => count === 0))
})

test("닫히지 않은 코드 뒤에 넣은 문단이 코드 내용으로 들어가지 않는다", async () => {
  const result = await documentEditor("```text\n원래 코드\n")
  assert.deepEqual(result.errors, [])
  result.editor.update(() => {
    lexical.$getRoot().getLastChild().append(lexical.$createTextNode("새 문단"))
  }, { discrete: true })
  assert.equal(result.saved(), "```text\n원래 코드\n```\n\n새 문단\n")
  assert.ok(result.warnings.at(-1)! > 0, "코드 닫기 표시를 복원한 줄 수를 알린다")
})

test("빈 줄 보충으로도 구조가 같아지지 않으면 전체 출력과 추가 변경 줄 수를 반환한다", () => {
  const preservation = new RichEditorPreservation("1. 항목\n\n상태: 초안\n")
  preservation.setInitialExport("- 항목\n\n상태: 초안")
  const result = preservation.preserve("- 항목\n\n상태: 수정")
  assert.equal(result.markdown, "- 항목\n\n상태: 수정")
  assert.ok(result.unpreservedLines > 0)
})

test("동등한 강조 표기는 그대로 보존하며 다른 원문이 겹치는 반복 블록은 출력과 경고를 사용한다", () => {
  const distinct = new RichEditorPreservation("_첫 문단_\n\n상태: 초안\n")
  distinct.setInitialExport("*첫 문단*\n\n상태: 초안")
  assert.deepEqual(distinct.preserve("*첫 문단*\n\n상태: 수정"), { markdown: "_첫 문단_\n\n상태: 수정\n", unpreservedLines: 0 })

  const repeated = new RichEditorPreservation("*같음*\n\n_같음_\n")
  repeated.setInitialExport("*같음*\n\n*같음*")
  assert.equal(repeated.preserve("*같음*\n\n*같음*").markdown, "*같음*\n\n_같음_\n")
  const result = repeated.preserve("*같음*")
  assert.equal(result.markdown, "*같음*\n")
  assert.ok(result.unpreservedLines > 0, "반복 블록 중 어느 원문이 남았는지 식별할 수 없음을 알린다")
})

for (const remaining of ["*같음*\n\n고친 문단", "원문에서 고친 문단\n\n*같음*\n\n고친 문단"]) {
  test(`반복 블록 일부를 원문에서 삭제·수정해도 남은 출력의 경고를 유지한다: ${remaining.split("\n")[0]}`, () => {
    const original = "*같음*\n\n_같음_\n\n다른 문단"
    const exported = "*같음*\n\n*같음*\n\n다른 문단"
    const session = new RichEditorPreservationSession(original)
    session.beginRich(original)
    session.setInitialExport(exported)
    const changed = session.preserve(exported.replace("다른 문단", "고친 문단"))
    assert.ok(changed.unpreservedLines > 0)
    assert.ok(session.editSource(remaining).unpreservedLines > 0, "수동 수정한 반복 블록과 남은 블록의 원문을 단정하지 않는다")
    session.beginRich(remaining)
    session.setInitialExport(remaining)
    assert.ok(session.preserve(`${remaining}!`).unpreservedLines > 0)
    assert.deepEqual(session.editSource(original), { markdown: original, unpreservedLines: 0 })
  })
}

test("원문 입력을 되돌리면 이전 경고를 복구하고 남은 서식 수정 취소로 최초 바이트를 복원한다", () => {
  const original = "```text\n원래 코드\n"
  const exported = "```text\n원래 코드\n```"
  const session = new RichEditorPreservationSession(original)
  session.beginRich(original)
  session.setInitialExport(exported)
  const inserted = session.preserve(`${exported}\n\n새 문단`)
  assert.equal(inserted.unpreservedLines, 1)
  // Touch the actual warned line as well: reverting an input must restore its
  // warning rather than keep the temporary acknowledgement from that input.
  assert.ok(session.editSource(inserted.markdown.replace("\n```\n", "\n````\n")).unpreservedLines > 0)
  const undone = session.editSource(inserted.markdown)
  assert.equal(undone.markdown, inserted.markdown)
  assert.ok(undone.unpreservedLines > 0)
  session.beginRich(inserted.markdown)
  session.setInitialExport(inserted.markdown.trimEnd())
  assert.deepEqual(session.preserve(exported), { markdown: original, unpreservedLines: 0 })
})

test("서식 왕복 뒤 원문 입력을 이전 스냅샷으로 되돌려도 최초 바이트 복원을 허용한다", () => {
  const original = "```text\n원래 코드\n"
  const exported = "```text\n원래 코드\n```"
  const session = new RichEditorPreservationSession(original)
  session.beginRich(original)
  session.setInitialExport(exported)
  const inserted = session.preserve(`${exported}\n\n새 문단`)
  const manual = inserted.markdown.replace("새 문단", "새 문단!")
  session.editSource(manual)
  session.beginRich(manual)
  session.setInitialExport(manual.trimEnd())
  session.preserve(manual.trimEnd())
  assert.ok(session.editSource(inserted.markdown).unpreservedLines > 0, "입력 취소가 남은 정규화를 승인하지 않는다")
  session.beginRich(inserted.markdown)
  session.setInitialExport(inserted.markdown.trimEnd())
  assert.deepEqual(session.preserve(exported), { markdown: original, unpreservedLines: 0 })
})

test("서식 문단 추가가 사이에 끼어도 원문 입력 취소 뒤 최초 코드 바이트를 복원한다", () => {
  const original = "```text\n원래 코드\n"
  const exported = "```text\n원래 코드\n```"
  const session = new RichEditorPreservationSession(original)
  session.beginRich(original)
  session.setInitialExport(exported)
  const first = session.preserve(`${exported}\n\n문단 가`)
  assert.ok(first.unpreservedLines > 0)
  const manual = first.markdown.replace("문단 가", "문단 가!")
  session.editSource(manual)
  session.beginRich(manual)
  session.setInitialExport(manual.trimEnd())
  const second = session.preserve(`${manual.trimEnd()}\n\n문단 나`)
  const undone = second.markdown.replace("문단 가!", "문단 가")
  assert.ok(session.editSource(undone).unpreservedLines > 0, "느낌표 취소가 코드 닫기 경고를 승인하지 않는다")
  session.beginRich(undone)
  session.setInitialExport(undone.trimEnd())
  assert.deepEqual(session.preserve(exported), { markdown: original, unpreservedLines: 0 })
})

for (const [newline, finalNewline] of [["\n", false], ["\n", true], ["\r\n", false], ["\r\n", true]] as const) {
  test(`같은 문단을 서식에서도 고친 뒤 원문 느낌표와 두 문단을 지우면 최초 코드 바이트로 돌아간다: ${newline === "\n" ? "LF" : "CRLF"}, 마지막 줄끝 ${finalNewline}`, () => {
    const original = "```text" + newline + "원래 코드" + (finalNewline ? newline : "")
    const exported = "```text\n원래 코드\n```"
    const saved = (markdown: string) => markdown.replace(/\n/g, newline) + (finalNewline ? newline : "")
    const session = new RichEditorPreservationSession(original)
    session.beginRich(original)
    session.setInitialExport(exported)
    const first = session.preserve(`${exported}\n\n문단 가`)
    assert.equal(first.markdown, saved(`${exported}\n\n문단 가`))
    assert.ok(first.unpreservedLines > 0)
    const manual = first.markdown.replace("문단 가", "문단 가!")
    session.editSource(manual)
    session.beginRich(manual)
    session.setInitialExport(manual.trimEnd().replace(/\r\n/g, "\n"))
    const second = session.preserve(`${exported}\n\n문단 가!!\n\n문단 나`)
    assert.equal(second.markdown, saved(`${exported}\n\n문단 가!!\n\n문단 나`))
    const undone = session.editSource(second.markdown.replace("문단 가!!", "문단 가"))
    assert.ok(undone.unpreservedLines > 0, "느낌표 둘을 지워도 남은 코드 닫기 경고는 유지한다")
    session.beginRich(undone.markdown)
    session.setInitialExport(undone.markdown.trimEnd().replace(/\r\n/g, "\n"))
    const restored = session.preserve(exported)
    assert.deepEqual(Buffer.from(restored.markdown), Buffer.from(original))
    assert.equal(restored.unpreservedLines, 0)
  })
}

for (const [name, input] of [
  ["수동 링크 정의", "[링크]: https://example.com"],
  ["수동 주석", "<!-- 수동 메모 -->"],
  ["수동 코드 닫기 공백", "```  "],
]) {
  test(`같은 줄의 서식 수정과 원문 입력 취소가 ${name}의 보존·경고를 지우지 않는다`, () => {
    const original = "```text\n원래 코드\n", exported = "```text\n원래 코드\n```"
    const session = new RichEditorPreservationSession(original)
    session.beginRich(original)
    session.setInitialExport(exported)
    const first = session.preserve(`${exported}\n\n문단 가`)
    const typed = first.markdown.replace("문단 가", "문단 가!")
    const manual = name === "수동 코드 닫기 공백" ? typed.replace("\n```\n", `\n${input}\n`) : `${typed}\n${input}\n`
    session.editSource(manual)
    session.beginRich(manual)
    session.setInitialExport(`${exported}\n\n문단 가!`)
    const second = session.preserve(`${exported}\n\n문단 가!!\n\n문단 나`)
    const undone = session.editSource(second.markdown.replace("문단 가!!", "문단 가"))
    session.beginRich(undone.markdown)
    session.setInitialExport(`${exported}\n\n문단 가\n\n문단 나`)
    const result = session.preserve(exported)
    assert.notEqual(result.markdown, original, "남은 수동 입력까지 취소했다고 단정하지 않는다")
    assert.ok(result.markdown.includes(input) || result.unpreservedLines > 0, "수동 입력을 보존할 수 없으면 경고를 유지한다")
  })
}

test("다른 서식 수정 뒤 일부 원문 입력을 취소해도 남은 수동 주석을 지우지 않는다", () => {
  const original = "본문\n"
  const session = new RichEditorPreservationSession(original)
  session.beginRich(original)
  session.setInitialExport("본문")
  const manual = "<!-- 수동 주석 -->\n\n본문!\n"
  session.editSource(manual)
  session.beginRich(manual)
  session.setInitialExport("본문!")
  const rich = session.preserve("본문!\n\n서식 문단")
  const undone = rich.markdown.replace("본문!", "본문")
  session.editSource(undone)
  session.beginRich(undone)
  session.setInitialExport("본문\n\n서식 문단")
  const result = session.preserve("본문")
  assert.notEqual(result.markdown, original, "남은 수동 변경을 전체 취소로 오판하지 않는다")
  assert.ok(result.markdown.includes("<!-- 수동 주석 -->") || result.unpreservedLines > 0)
})

test("여러 원문 입력 사이에 서식을 고친 뒤 한번에 취소해도 현재 남은 차이만 판단한다", () => {
  const original = "```text\n원래 코드\n"
  const exported = "```text\n원래 코드\n```"
  const session = new RichEditorPreservationSession(original)
  session.beginRich(original)
  session.setInitialExport(exported)
  let content = session.preserve(`${exported}\n\n문단 가`).markdown
  for (const [before, after, paragraph] of [["문단 가", "문단 가!", "문단 나"], ["문단 가!", "문단 가!!", "문단 다"]]) {
    content = session.editSource(content.replace(before, after)).markdown
    session.beginRich(content)
    session.setInitialExport(content.trimEnd())
    content = session.preserve(`${content.trimEnd()}\n\n${paragraph}`).markdown
  }
  content = session.editSource(content.replace("문단 가!!", "문단 가")).markdown
  session.beginRich(content)
  session.setInitialExport(content.trimEnd())
  assert.deepEqual(session.preserve(exported), { markdown: original, unpreservedLines: 0 })
})

test("삭제한 링크 정의를 다른 위치에 넣는 수동 변경은 입력 취소로 오판하지 않는다", () => {
  const definition = "[참조]: https://example.com"
  const original = `${definition}\n본문\n`
  const session = new RichEditorPreservationSession(original)
  session.beginRich(original)
  session.setInitialExport("본문")
  session.editSource("본문\n")
  session.beginRich("본문\n")
  session.setInitialExport("본문")
  const added = session.preserve("본문\n\n서식 문단")
  const moved = `${added.markdown.trimEnd()}\n\n${definition}\n`
  session.editSource(moved)
  session.beginRich(moved)
  session.setInitialExport("본문\n\n서식 문단")
  const result = session.preserve("본문")
  assert.notEqual(result.markdown, original)
  assert.ok(result.markdown.includes(definition) || result.unpreservedLines > 0, "링크 정의를 원래 위치로 조용히 돌려놓지 않는다")
})

test("경고가 있는 내용의 줄끝만 원문에서 바꿔도 정규화를 승인하지 않는다", () => {
  const original = "*같음*\n\n_같음_\n\n다른 문단"
  const exported = "*같음*\n\n*같음*\n\n다른 문단"
  const session = new RichEditorPreservationSession(original)
  session.beginRich(original)
  session.setInitialExport(exported)
  const changed = session.preserve(exported.replace("다른 문단", "고친 문단"))
  const crlf = changed.markdown.replace(/\n/g, "\r\n")
  assert.ok(session.editSource(crlf).unpreservedLines > 0)
  session.beginRich(crlf)
  session.setInitialExport(changed.markdown)
  const result = session.preserve(changed.markdown)
  assert.equal(result.markdown, crlf)
  assert.ok(result.unpreservedLines > 0)
})

for (const [name, hidden] of [
  ["링크 정의", "[링크]: https://example.com"],
  ["주석", "<!-- 원문 메모 -->"],
  ["HTML 지시문", "<!DOCTYPE html>"],
]) {
  test(`서식 출력에서 빠진 ${name}의 수동 입력은 취소로 간주하지 않는다`, () => {
    const original = "본문\n"
    const exported = "본문"
    const manual = `${hidden}\n\n${original}`
    const session = new RichEditorPreservationSession(original)
    session.beginRich(original)
    session.setInitialExport(exported)
    assert.deepEqual(session.editSource(manual), { markdown: manual, unpreservedLines: 0 })
    session.beginRich(manual)
    session.setInitialExport(exported)
    assert.deepEqual(session.preserve(exported), { markdown: manual, unpreservedLines: 0 })
    const typed = manual.replace("본문", "본문!")
    session.editSource(typed)
    session.beginRich(typed)
    session.setInitialExport(`${exported}!`)
    session.preserve(`${exported}!`)
    session.editSource(manual)
    session.beginRich(manual)
    session.setInitialExport(exported)
    assert.deepEqual(session.preserve(exported), { markdown: manual, unpreservedLines: 0 }, "이후 입력 취소가 먼저 입력한 숨김 구문의 기록을 지우지 않는다")
    const changed = session.preserve(`${exported}!`)
    assert.equal(changed.markdown, `${exported}!`)
    assert.ok(changed.unpreservedLines > 0, "수동 바이트를 보존할 수 없으면 확인을 요구한다")
  })
}

test("원문에서 직접 넣은 코드 닫기의 공백도 최초 출력 복원으로 지우지 않는다", () => {
  const original = "```text\n원래 코드\n"
  const exported = "```text\n원래 코드\n```"
  const session = new RichEditorPreservationSession(original)
  session.beginRich(original)
  session.setInitialExport(exported)
  const manual = "```text\n원래 코드\n```  \n"
  session.editSource(manual)
  session.beginRich(manual)
  session.setInitialExport(exported)
  assert.deepEqual(session.preserve(exported), { markdown: manual, unpreservedLines: 0 })
})

test("함께 입력한 원문 변경 일부를 서식에서 취소해도 수동 코드 닫기를 보존한다", () => {
  const original = "```text\n원래 코드\n"
  const exported = "```text\n원래 코드\n```"
  const session = new RichEditorPreservationSession(original)
  session.beginRich(original)
  session.setInitialExport(exported)
  const inserted = session.preserve(`${exported}\n\n새 문단`)
  const manual = inserted.markdown.replace("\n```\n", "\n```  \n").replace("새 문단", "원문에서 고친 문단")
  session.editSource(manual)
  session.beginRich(manual)
  session.setInitialExport(`${exported}\n\n원문에서 고친 문단`)
  assert.deepEqual(session.preserve(exported), { markdown: `${exported}  \n`, unpreservedLines: 0 })
})

test("실제 편집기로 본문만 바꿔도 앞머리 역빗금과 바이트를 유지한다", async () => {
  const source = "---\r\npath: C:\\[dir]\r\nlabel: 값\\=내용\\~끝\r\n---\r\n\r\n상태: 초안\r\n"
  const result = await documentEditor(source)
  assert.deepEqual(result.errors, [])
  assert.equal(result.saved(), source)
  assert.equal(result.exports.at(-1)!.split("---")[1], "\npath: C:\\[dir]\r\nlabel: 값\\=내용\\~끝\n")
  result.editor.update(() => {
    lexical.$getRoot().getAllTextNodes().find((node: { getTextContent(): string }) => node.getTextContent() === "상태: 초안").setTextContent("상태: 수정")
  }, { discrete: true })
  assert.equal(result.saved(), source.replace("상태: 초안", "상태: 수정"))
  assert.ok(result.warnings.every((count) => count === 0))
})

test("대응 불가한 초기 블록은 정규화된 줄 수를 알린다", () => {
  const preservation = new RichEditorPreservation("[링크]: https://example.com\n\n본문\n")
  preservation.setInitialExport("본문")
  const result = preservation.preserve("고친 본문")
  assert.equal(result.markdown, "고친 본문")
  assert.ok(result.unpreservedLines > 0)
})

test("표 history 재열기 초기 이벤트가 원문 비교 기준과 이전 수정 내용을 덮어쓰지 않는다", () => {
  const source = "상태: 초안\n\n- 항목\n"
  const preservation = new RichEditorPreservation(source)
  preservation.setInitialExport("상태: 초안\n\n- 항목")
  assert.equal(preservation.preserve("상태: 수정\n\n- 항목").markdown, "상태: 수정\n\n- 항목\n")
  preservation.setInitialExport("상태: 수정\n\n- 항목")
  assert.equal(preservation.preserve("상태: 수정\n\n- 변경").markdown, "상태: 수정\n\n- 변경\n")
  assert.equal(preservation.preserve("상태: 초안\n\n- 항목").markdown, source)
})

test("첫 편집 전 재초기화도 최초 출력 보존 기준을 덮어쓰지 않는다", () => {
  const source = "_원래 문단_\n"
  const preservation = new RichEditorPreservation(source)
  preservation.setInitialExport("*원래 문단*")
  preservation.setInitialExport("*원래 문단*\n\n재초기화 문단")
  assert.deepEqual(preservation.preserve("*원래 문단*"), { markdown: source, unpreservedLines: 0 })
})

test("수정하지 않은 블록의 혼합 줄끝·파일 끝 공백은 그대로 남는다", () => {
  const source = "# 제목\r\n\r\n첫 줄\n둘째 줄\r\n\r\n상태: 초안\r\n\r\n"
  const preservation = new RichEditorPreservation(source)
  preservation.setInitialExport("# 제목\n\n첫 줄\n둘째 줄\n\n상태: 초안")
  assert.equal(preservation.preserve("# 제목\n\n첫 줄\n둘째 줄\n\n상태: 수정").markdown, source.replace("상태: 초안", "상태: 수정"))
})

test("불필요한 escape만 지우며 코드·실제 링크·참조 링크는 의미를 바꾸지 않는다", () => {
  assert.equal(cleanRichEditorMarkdown("\\[일반 글자] 값\\=내용 1\\~3"), "[일반 글자] 값=내용 1~3")
  assert.equal(cleanRichEditorMarkdown("\\[링크](https://example.com)"), "\\[링크](https://example.com)")
  assert.equal(cleanRichEditorMarkdown("`\\[코드]`"), "`\\[코드]`")
  assert.equal(cleanRichEditorMarkdown("`[https://example.com](https://example.com)`"), "`[https://example.com](https://example.com)`")
  assert.equal(cleanRichEditorMarkdown("\\[참조]\n\n[참조]: https://example.com"), "\\[참조]\n\n[참조]: https://example.com")
  assert.doesNotMatch(cleanRichEditorMarkdown("\\=\\=literal\\=\\="), /==literal==/)
  assert.equal(cleanRichEditorMarkdown("\\===강조=="), "\\===강조==")
  assert.equal(cleanRichEditorMarkdown("---\npath: C:\\[dir]\n---\n\n값\\=내용"), "---\npath: C:\\[dir]\n---\n\n값=내용")
  assert.equal(cleanRichEditorMarkdown("---\npath: C:\\[dir]\nstate: 초안\n---"), "---\npath: C:\\[dir]\nstate: 초안\n---")
})

test("일반 등호 뒤의 실제 강조 구문은 보정과 본문 수정 뒤에도 유지한다", async () => {
  const source = "\\===강조==\n\n상태: 초안\n"
  const result = await documentEditor(source)
  assert.deepEqual(result.errors, [])
  const formats: { value: string; highlight: boolean }[] = []
  result.editor.getEditorState().read(() => lexical.$getRoot().getAllTextNodes().forEach((node: { getTextContent(): string; hasFormat(format: string): boolean }) => formats.push({ value: node.getTextContent(), highlight: node.hasFormat("highlight") })))
  assert.ok(formats.some((entry) => entry.value === "강조" && entry.highlight))
  assert.match(result.exports.at(-1)!, /\\===강조==/)
  result.editor.update(() => {
    lexical.$getRoot().getAllTextNodes().find((node: { getTextContent(): string }) => node.getTextContent() === "상태: 초안").setTextContent("상태: 수정")
  }, { discrete: true })
  assert.equal(result.saved(), source.replace("상태: 초안", "상태: 수정"))

  const literal = await documentEditor(cleanRichEditorMarkdown("\\=\\=literal\\=\\="))
  literal.editor.getEditorState().read(() => {
    const nodes = lexical.$getRoot().getAllTextNodes()
    assert.equal(nodes.map((node: { getTextContent(): string }) => node.getTextContent()).join(""), "==literal==")
    assert.ok(nodes.every((node: { hasFormat(format: string): boolean }) => !node.hasFormat("highlight")))
  })
})

// Private complete originals remain scratch input. CI always runs the redacted
// fixture above; the local verification command also exercises both originals.
for (const name of ["sample-research-note-20261101.md", "sample-blog-4-stages-20261101.md"]) {
  test(`전체 원본 ${name}: no-op 및 상태 한 줄 수정`, { skip: !process.env.RICH_EDITOR_ORIGINALS_DIR }, async () => {
    const source = readFileSync(`${process.env.RICH_EDITOR_ORIGINALS_DIR}/${name}`, "utf8")
    const result = await documentEditor(source)
    assert.deepEqual(result.errors, [])
    assert.equal(result.saved(), source)
    assertRawModePreserved(source, result.exports.at(-1)!)
    let old = "", next = ""
    result.editor.update(() => {
      const text = lexical.$getRoot().getAllTextNodes().find((node: { getTextContent(): string }) => node.getTextContent().includes("상태:"))
      assert.ok(text)
      old = text.getTextContent()
      next = old.replace("상태:", "상태: 검증 완료 ·")
      text.setTextContent(next)
    }, { discrete: true })
    assert.equal(result.saved(), source.replace(old, next))
    assert.ok(result.warnings.every((count) => count === 0))
  })
}

type Element = React.ReactElement<Record<string, any>>

function elements(node: React.ReactNode): Element[] {
  if (!React.isValidElement<Record<string, any>>(node)) return []
  const element = node as React.ReactElement<Record<string, any>>
  return [element, ...React.Children.toArray(element.props.children).flatMap(elements)]
}

// 표 칸 시험과 같은 실제 TableEditor·CellEditor·변경 리스너를 실행한다.
function renderWithRealm(element: Element, realm: any, context: unknown = realm) {
  const effects: (() => void | (() => void))[] = []
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const previous = internals.H
  internals.H = {
    useState: (initial: any) => [typeof initial === "function" ? initial() : initial, () => {}],
    useMemo: (calculate: () => unknown) => calculate(),
    useCallback: (callback: unknown) => callback,
    useContext: () => context,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
    useEffect: (effect: () => void | (() => void)) => { effects.push(effect) },
  }
  try { return { tree: (element.type as (props: any) => Element)(element.props), effects } }
  finally { internals.H = previous }
}

async function editTableCell(context: TestContext, result: Awaited<ReturnType<typeof documentEditor>>, old: string, next: string) {
  const tableElement = result.editor.getEditorState().read(() => {
    const node = lexical.$getRoot().getChildren().find((node: any) => node.getType() === "table" && JSON.stringify(node.getMdastNode()).includes(old))
    assert.ok(node, "지정 문구를 가진 실제 표 블록이 있어야 한다")
    return node.decorate(result.editor)
  })
  const table = renderWithRealm(tableElement, result.realm).tree
  const cell = elements(table).find((element) => element.props.contents && JSON.stringify(element.props.contents).includes(old))
  assert.ok(cell, "지정 문구의 실제 표 칸을 찾아야 한다")
  const cellElement = renderWithRealm(cell, result.realm).tree.props.children
  const rendered = renderWithRealm(cellElement, result.realm)
  const editor = rendered.tree.props.initialEditor
  await setTimeout(0)
  editor._headless = true
  const listeners = elements(rendered.tree).filter((element) => element.type === TableCellChangeListener)
  assert.equal(listeners.length, 1)
  const effects = [...rendered.effects, ...listeners.flatMap((element) => renderWithRealm(element, result.realm, [editor, {}]).effects)]
  const cleanups = effects.map((effect) => effect())
  context.after(() => cleanups.forEach((cleanup) => { if (typeof cleanup === "function") cleanup() }))
  editor.update(() => {
    const text = lexical.$getRoot().getAllTextNodes().find((node: any) => node.getTextContent().includes(old))
    assert.ok(text, "중첩 표 칸 편집기 안에서 문구를 찾아야 한다")
    text.setTextContent(text.getTextContent().replace(old, next))
  }, { discrete: true })
  await setTimeout(0)
}

test("표 칸 하나를 고치면 나머지 표 행의 공백과 정렬을 그대로 보존한다", async (context) => {
  const source = "| 제목 | 내용 |\n|:---:|---|\n| 하나 | 원래 칸 |\n| 둘 | 그대로 |\n\n끝\n"
  const result = await documentEditor(source)
  await editTableCell(context, result, "원래 칸", "고친 칸")
  const before = source.split("\n"), after = result.saved().split("\n")
  assert.equal(after.length, before.length)
  assert.deepEqual(before.flatMap((line, index) => line === after[index] ? [] : [index]), [2])
  assert.match(after[2], /고친 칸/)
  assert.ok(result.warnings.length > 0 && result.warnings.every((count) => count === 0))
  assert.deepEqual(result.errors, [])
})

test("두 번째 알파 원본: 무변경 바이트 보존과 105줄 표 칸만 수정", { skip: !process.env.RICH_EDITOR_ORIGINALS_DIR_B }, async (context) => {
  const original = readFileSync(`${process.env.RICH_EDITOR_ORIGINALS_DIR_B}/report-before.md`)
  const source = original.toString("utf8")
  const result = await documentEditor(source)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(Buffer.from(result.saved()), original)
  assertRawModePreserved(source, result.exports.at(-1)!)
  const requests: string[] = []
  const save = () => saveDocument({
    source: "adk", path: "report-before.md", content: result.saved(), baseHash: "1".repeat(64),
    fetchFn: async (_url, request) => {
      requests.push(JSON.parse(String(request?.body)).content)
      return Response.json({ sha256: "2".repeat(64) })
    },
  })
  assert.equal((await save()).ok, true)
  assert.deepEqual(Buffer.from(requests[0]), original)
  const old = "Naia 0.2.4(스팀·macOS) 공개", next = "Naia 0.2.5 출시, 웹판 추가 출시"
  assert.ok(source.split("\n")[104].includes(old))
  await editTableCell(context, result, old, next)
  assert.equal((await save()).ok, true)
  const before = source.split("\n"), after = requests[1].split("\n")
  assert.equal(after.length, before.length)
  assert.deepEqual(before.flatMap((line, index) => line === after[index] ? [] : [index + 1]), [105])
  assert.ok(after[104].includes(next))
  assert.ok(!after[104].includes(old))
  assert.ok(result.warnings.length > 0 && result.warnings.every((count) => count === 0))
  assert.deepEqual(result.errors, [])
})
