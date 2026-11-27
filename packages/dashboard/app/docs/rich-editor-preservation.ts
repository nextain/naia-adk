import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import { frontmatter } from "micromark-extension-frontmatter"
import { frontmatterFromMarkdown } from "mdast-util-frontmatter"
import { highlightMark } from "micromark-extension-highlight-mark"
import { highlightMarkFromMarkdown } from "mdast-util-highlight-mark"

// 편집기가 가져올 때 쓰는 강조·앞머리 확장을 의미 비교에도 적용한다.
const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(function editorSyntax() {
  const data = this.data()
  ;(data.micromarkExtensions ??= []).push(highlightMark(), frontmatter())
  ;(data.fromMarkdownExtensions ??= []).push(highlightMarkFromMarkdown, frontmatterFromMarkdown("yaml"))
})

export const RICH_EDITOR_MARKDOWN_OPTIONS = { bullet: "-", rule: "-", emphasis: "*", strong: "*", fences: true } as const

export function singleTildeSyntax() {
  const extension = parser.freeze().data("micromarkExtensions")![0]
  const tokenizers = extension.text![126]
  return { text: { 126: tokenizers }, insideSpan: { null: tokenizers }, attentionMarkers: { null: [126] } }
}

interface MarkdownNode {
  type: string
  children?: MarkdownNode[]
  url?: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  [key: string]: unknown
}

interface Block { type: string; body: string; before: string }
interface Blocks { blocks: Block[]; tail: string }
interface OutputBlock extends Block { exported: Block }

function blocks(markdown: string): Blocks {
  const parsed = parser.parse(markdown) as unknown as MarkdownNode
  const result: Block[] = []
  let end = 0
  for (const node of parsed.children ?? []) {
    const start = node.position?.start.offset
    const stop = node.position?.end.offset
    if (start === undefined || stop === undefined) throw new Error("Missing markdown block position")
    result.push({ type: node.type, body: markdown.slice(start, stop), before: markdown.slice(end, start) })
    end = stop
  }
  return { blocks: result, tail: markdown.slice(end) }
}

// Ordered matches retain repeated blocks as well as insertions and removals.
function matches<T>(left: T[], right: T[], equal: (a: T, b: T) => boolean): [number, number][] {
  if ((left.length + 1) * (right.length + 1) > 2_000_000) throw new Error("Markdown alignment limit")
  const rows = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1))
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) rows[i][j] = equal(left[i], right[j]) ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1])
  }
  const result: [number, number][] = []
  let i = 0, j = 0
  while (i < left.length && j < right.length) {
    if (equal(left[i], right[j])) { result.push([i++, j++]); continue }
    if (rows[i + 1][j] >= rows[i][j + 1]) i++
    else j++
  }
  return result
}

function lineGap(line: number, beforeLength: number, afterLength: number, alignment: [number, number][]): number {
  const previous = [...alignment].reverse().find(([index]) => index < line)
  const next = alignment.find(([index]) => index >= line)
  const end = next?.[0] ?? beforeLength
  if (line === end) return next?.[1] ?? afterLength
  return Math.min((previous?.[1] ?? -1) + 1 + line - ((previous?.[0] ?? -1) + 1), next?.[1] ?? afterLength)
}

function semantic(markdown: string): string {
  return JSON.stringify(parser.parse(markdown), (key, value) => {
    if (key === "position" || key === "spread") return undefined
    return key === "value" && typeof value === "string" ? value.replace(/\r\n/g, "\n") : value
  })
}

// The exporter escapes literal labels and single =/~ even when no Markdown
// construct follows. Remove an escape only when parsing proves it is literal.
export function cleanRichEditorMarkdown(markdown: string): string {
  const signature = semantic(markdown)
  const first = (parser.parse(markdown) as unknown as MarkdownNode).children?.[0]
  // 앞머리는 마크다운의 역빗금 문법을 쓰지 않으므로 보정 대상에서 뺀다.
  const offset = first?.type === "yaml" ? first.position?.end.offset ?? 0 : 0
  const prefix = markdown.slice(0, offset)
  let result = markdown.slice(offset)
  const equivalent = (candidate: string) => semantic(prefix + candidate) === signature
  for (const character of ["[", "=", "~"]) {
    const escaped = `\\${character}`
    const candidate = result.split(escaped).join(character)
    if (equivalent(candidate)) result = candidate
    else {
      let offset = 0
      while ((offset = result.indexOf(escaped, offset)) !== -1) {
        const next = result.slice(0, offset) + character + result.slice(offset + 2)
        if (equivalent(next)) result = next
        offset++
      }
    }
  }
  // A URL whose label is the URL itself can retain its original bare form.
  for (const match of [...result.matchAll(/\[(https?:\/\/[^\]\s]+)\]\(\1\)|<(https?:\/\/[^>\s]+)>/g)].reverse()) {
    const url = match[1] ?? match[2]
    const candidate = result.slice(0, match.index) + url + result.slice(match.index! + match[0].length)
    if (equivalent(candidate)) result = candidate
  }
  return prefix + result
}

function openFence(block: Block): boolean {
  if (block.type !== "code") return false
  const lines = block.body.split(/\r?\n/)
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0])?.[1]
  if (!fence) return false
  const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`)
  return !lines.slice(1).some((line) => closing.test(line))
}

export interface PreservedMarkdown { markdown: string; unpreservedLines: number }

interface UnpreservedLine { line: number; removed?: string[] }

interface SourceEdit { before: string; after: string }

function lineChanges(before: string[], after: string[]) {
  const anchors = [...matches(before, after, (a, b) => a === b), [before.length, after.length] as [number, number]]
  const changes: { start: number; removed: number[]; added: number[] }[] = []
  let oldStart = 0, newStart = 0
  for (const [oldEnd, newEnd] of anchors) {
    if (oldEnd > oldStart || newEnd > newStart) changes.push({
      start: oldStart,
      removed: Array.from({ length: oldEnd - oldStart }, (_, index) => oldStart + index),
      added: Array.from({ length: newEnd - newStart }, (_, index) => newStart + index),
    })
    oldStart = oldEnd + 1
    newStart = newEnd + 1
  }
  return changes
}

// 다른 서식 수정이 끼어도 서로 취소된 원문 차이를 제거한다. 반복 줄은
// 대응을 확정할 수 없으므로 기록을 남겨 최초 바이트 복원을 막는다.
function netSourceEdits(edits: SourceEdit[], before: string, after: string): SourceEdit[] {
  try {
    const oldLines = before.split("\n"), newLines = after.split("\n")
    const parts = (edit: SourceEdit) => {
      const old = edit.before.split("\n"), next = edit.after.split("\n")
      return lineChanges(old, next).map(({ removed, added }) => ({
        removed: removed.map((index) => old[index]), added: added.map((index) => next[index]),
      }))
    }
    const unique = (values: string[], content: string) => values.every((value) => content.split("\n").filter((line) => line === value).length === 1)
    const result = [...edits]
    for (const { start, removed, added } of lineChanges(oldLines, newLines)) {
      const next = [...oldLines]
      next.splice(start, removed.length, ...added.map((index) => newLines[index]))
      const edit = { before, after: next.join("\n") }
      const change = parts(edit)[0]
      const continued = result.findLastIndex((previous) => {
        const changes = parts(previous)
        return changes.length === 1 && changes[0].added.length > 0 && JSON.stringify(changes[0].added) === JSON.stringify(change.removed)
          && unique(changes[0].removed, previous.before) && unique(changes[0].added, previous.after)
          && unique(change.removed, before) && unique(change.added, after)
      })
      if (continued < 0) result.push(edit)
      else {
        const previous = result[continued]
        const origin = previous.before.split("\n")
        const [previousChange] = lineChanges(origin, previous.after.split("\n"))
        origin.splice(previousChange.start, previousChange.removed.length, ...change.added)
        const combined = { before: previous.before, after: origin.join("\n") }
        if (combined.before === combined.after) result.splice(continued, 1)
        else result[continued] = combined
      }
    }
    return result
  } catch {
    return [...edits, { before, after }]
  }
}

// 서식에서 같은 일반 텍스트 줄을 고쳤으면 최근 수동 입력의 기준도 옮긴다.
// 숨은 구문·공백·반복 줄은 대응을 확정하지 않고 기존 기록을 유지한다.
function advanceSourceEdits(edits: SourceEdit[], before: string, after: string): SourceEdit[] {
  if (!edits.length || before === after) return edits
  try {
    const old = before.split("\n"), next = after.split("\n")
    const edit = edits.at(-1)!, source = edit.before.split("\n"), saved = edit.after.split("\n")
    const [tracked, ...other] = lineChanges(source, saved)
    if (!tracked || other.length || tracked.removed.length !== 1 || tracked.added.length !== 1) return edits
    const unique = (lines: string[], value: string) => lines.filter((line) => line === value).length === 1
    const plain = (line: string) => {
      const value = line.endsWith("\r") ? line.slice(0, -1) : line
      const children = (parser.parse(value) as unknown as MarkdownNode).children
      return children?.length === 1 && children[0].type === "paragraph"
        && children[0].children?.length === 1 && children[0].children[0].type === "text" && children[0].children[0].value === value
    }
    const origin = source[tracked.removed[0]], manual = saved[tracked.added[0]]
    if (!plain(origin) || !unique(source, origin) || !unique(saved, manual) || origin.endsWith("\r") !== manual.endsWith("\r")) return edits
    for (const { removed, added } of lineChanges(old, next)) {
      if (removed.length !== 1 || !added.length) continue
      const previous = old[removed[0]], current = next[added[0]]
      if (previous !== manual || !plain(previous) || !plain(current) || !unique(old, previous) || !unique(next, current)) continue
      if (previous.endsWith("\r") !== current.endsWith("\r") && removed[0] !== old.length - 1) continue
      // 마지막 줄 뒤에 문단이 붙으면 CRLF의 CR도 붙는다. 수동 차이만
      // 되돌린 현재 전체 문서를 기준으로 삼고 앞선 수동 입력은 유지한다.
      const restored = origin.replace(/\r$/, "") + (current.endsWith("\r") ? "\r" : "")
      const updated = { before: next.map((line, index) => index === added[0] ? restored : line).join("\n"), after }
      return [...edits.slice(0, -1), ...(updated.before === updated.after ? [] : [updated])]
    }
    return edits
  } catch { return edits }
}

export class RichEditorPreservation {
  private initialExport: string | undefined
  constructor(private readonly original: string) {}

  setInitialExport(markdown: string) {
    // A table undo can remount the editor with its current export. That is
    // still the same editing session, so retain the original comparison base.
    if (this.initialExport === undefined) this.initialExport = markdown
  }

  preserve(markdown: string): PreservedMarkdown {
    const initial = this.initialExport ?? this.original
    if (markdown === initial) return { markdown: this.original, unpreservedLines: 0 }
    try {
      const source = blocks(this.original)
      const baseline = blocks(initial)
      const edited = blocks(markdown)
      if (source.blocks.length !== baseline.blocks.length || source.blocks.some((block, index) => block.type !== baseline.blocks[index].type)) {
        return this.fallback(markdown, initial)
      }
      const anchors = [...matches(baseline.blocks, edited.blocks, (a, b) => a.body === b.body), [baseline.blocks.length, edited.blocks.length] as [number, number]]
      // 같은 편집기 출력에 서로 다른 원문이 대응하면 삭제된 반복 블록을
      // 식별할 수 없다. 임의의 원문을 고르는 대신 출력과 경고를 사용한다.
      const variants = new Map<string, number[]>()
      for (let index = 0; index < baseline.blocks.length; index++) {
        const key = baseline.blocks[index].body
        variants.set(key, [...(variants.get(key) ?? []), index])
      }
      const ambiguous = new Set([...variants].filter(([, indices]) => new Set(indices.map((index) => source.blocks[index].body)).size > 1).map(([body]) => body))
      const warned = new Set<string>()
      const output: OutputBlock[] = []
      const newline = this.original.includes("\r\n") ? "\r\n" : "\n"
      let oldStart = 0, newStart = 0
      let unpreservedLines = 0
      for (const [oldEnd, newEnd] of anchors) {
        const oldCount = oldEnd - oldStart, newCount = newEnd - newStart
        for (let index = newStart; index < newEnd; index++) {
          const pairedIndex = oldStart + index - newStart
          const paired = oldCount === newCount ? source.blocks[pairedIndex] : undefined
          let body = edited.blocks[index].body.replace(/\r?\n/g, newline)
          if (paired?.type === "table" && edited.blocks[index].type === "table") {
            const originalRows = paired.body.split(/\r?\n/)
            const initialRows = baseline.blocks[pairedIndex].body.split(/\r?\n/)
            const editedRows = body.split(newline)
            if (originalRows.length === initialRows.length && initialRows.length === editedRows.length) {
              body = editedRows.map((row, index) => row === initialRows[index] ? originalRows[index] : row).join(newline)
            }
          }
          output.push({ ...edited.blocks[index], body, before: paired?.before ?? edited.blocks[index].before.replace(/\r?\n/g, newline), exported: edited.blocks[index] })
        }
        if (oldCount && newCount && oldCount !== newCount) {
          unpreservedLines += this.normalizedLines(source.blocks.slice(oldStart, oldEnd).map((b) => b.body).join("\n"), baseline.blocks.slice(oldStart, oldEnd).map((b) => b.body).join("\n"), edited.blocks.slice(newStart, newEnd).map((b) => b.body).join("\n"))
        }
        if (oldEnd < baseline.blocks.length) {
          const exported = edited.blocks[newEnd]
          const body = baseline.blocks[oldEnd].body
          output.push({ ...source.blocks[oldEnd], ...(ambiguous.has(body) ? { body: exported.body.replace(/\r?\n/g, newline) } : {}), exported })
          if (ambiguous.has(body) && !warned.has(body)) {
            const indices = variants.get(body)!
            const original = indices.map((index) => source.blocks[index].body).join("\n")
            const initial = indices.map((index) => baseline.blocks[index].body).join("\n")
            unpreservedLines += Math.max(1, this.normalizedLines(original, initial, initial))
            warned.add(body)
          }
        }
        oldStart = oldEnd + 1
        newStart = newEnd + 1
      }
      // 닫히지 않은 코드는 마지막 줄끝을 블록 안에 포함한다. 그 블록을
      // 닫힌 출력으로 교체해도 파일 마지막 줄끝은 유지한다.
      const assemble = () => output.map((block, index) => (index === 0 ? source.blocks[0]?.before ?? "" : block.before || newline + newline) + block.body).join("")
        + (source.tail || (this.original.endsWith("\n") && output.length > 0 && !output.at(-1)!.body.endsWith("\n") ? newline : ""))
      const signature = semantic(markdown)
      let assembled = assemble()
      if (semantic(assembled) === signature) return { markdown: assembled, unpreservedLines }

      for (const block of output.slice(0, -1)) {
        // 빈 줄로 닫을 수 없는 코드 구간은 닫힌 편집기 출력으로 바꾼다.
        if (!openFence(block)) continue
        unpreservedLines += this.normalizedLines(block.body, block.exported.body, block.exported.body)
        block.body = block.exported.body.replace(/\r?\n/g, newline)
      }
      for (let index = 1; index < output.length; index++) {
        const previous = output[index - 1].body, block = output[index]
        const before = block.before || newline + newline
        const separated = newline + newline
        if (semantic(previous + before + block.body) !== semantic(previous + separated + block.body)) block.before = separated
      }
      assembled = assemble()
      if (semantic(assembled) === signature) return { markdown: assembled, unpreservedLines }
      const fallback = this.fallback(markdown, initial)
      return { ...fallback, unpreservedLines: Math.max(unpreservedLines, fallback.unpreservedLines) }
    } catch {
      return this.fallback(markdown, initial)
    }
  }

  private normalizedLines(original: string, initial: string, edited: string): number {
    if (original === initial) return 0
    const source = original.split(/\r?\n/), exported = initial.split(/\r?\n/)
    try {
      const unchanged = new Set(matches(exported, edited.split(/\r?\n/), (a, b) => a === b).map(([index]) => index))
      const anchors = [...matches(source, exported, (a, b) => a === b), [source.length, exported.length] as [number, number]]
      let count = 0, sourceStart = 0, exportStart = 0
      for (const [sourceEnd, exportEnd] of anchors) {
        let directlyEdited = 0
        for (let index = exportStart; index < exportEnd; index++) if (!unchanged.has(index)) directlyEdited++
        count += Math.max(0, Math.max(sourceEnd - sourceStart, exportEnd - exportStart) - directlyEdited)
        sourceStart = sourceEnd + 1
        exportStart = exportEnd + 1
      }
      return count
    }
    catch { return Math.max(source.length, exported.length) }
  }

  private fallback(markdown: string, initial: string): PreservedMarkdown {
    return { markdown, unpreservedLines: this.normalizedLines(this.original, initial, markdown) }
  }

  // Keep the actual normalized lines, including gaps left by removed source
  // lines, so another editor import cannot silently acknowledge those changes.
  unpreservedLineLocations(markdown: string, count: number): UnpreservedLine[] {
    if (!count) return []
    const source = this.original.split(/\r?\n/), initial = (this.initialExport ?? this.original).split(/\r?\n/), saved = markdown.split(/\r?\n/)
    const locations: UnpreservedLine[] = []
    try {
      const exportAlignment = matches(initial, saved, (a, b) => a === b)
      const exported = new Map(exportAlignment)
      const sourceAlignment = matches(source, saved, (a, b) => a === b)
      const retained = new Set(sourceAlignment.map(([index]) => index))
      const anchors = [...matches(source, initial, (a, b) => a === b), [source.length, initial.length] as [number, number]]
      let sourceStart = 0, exportStart = 0
      for (const [sourceEnd, exportEnd] of anchors) {
        const remaining = Array.from({ length: exportEnd - exportStart }, (_, offset) => exported.get(exportStart + offset)).filter((line): line is number => line !== undefined)
        const missing = source.slice(sourceStart, sourceEnd).filter((_, offset) => !retained.has(sourceStart + offset))
        const changed = exportEnd - exportStart - remaining.length
        let pending = Math.max(0, Math.max(missing.length, exportEnd - exportStart) - changed)
        for (const line of remaining) {
          if (!pending || locations.length === count) break
          locations.push({ line })
          pending--
        }
        if (pending && locations.length < count) {
          const next = lineGap(exportEnd, initial.length, saved.length, exportAlignment)
          const removed = missing.slice(0, Math.min(pending, count - locations.length))
          for (const value of removed) locations.push({ line: next, removed: [value] })
        }
        sourceStart = sourceEnd + 1
        exportStart = exportEnd + 1
      }
      // Ambiguous repeated blocks can require confirmation even when their
      // normalized survivor matched a different occurrence in the line LCS.
      for (let index = 0; locations.length < count && index < source.length; index++) {
        if (retained.has(index)) continue
        const next = lineGap(index, source.length, saved.length, sourceAlignment)
        const location = { line: next, removed: [source[index]] }
        if (!locations.some((item) => item.line === next && item.removed?.[0] === source[index])) locations.push(location)
      }
    } catch {
      // The preservation fallback also uses a conservative count when the
      // alignment limit is exceeded. Retain that confirmation across modes.
    }
    while (locations.length < count) locations.push({ line: saved.length, removed: [""] })
    return locations.slice(0, count)
  }
}

// This object belongs to DocEditor, whose lifetime spans rich/source switches.
// Each rich import gets a local preservation base; the first file/export and
// still-unacknowledged normalization changes belong to the whole session.
export class RichEditorPreservationSession {
  private initialExport: string | undefined
  private sourceEdits: SourceEdit[] = []
  private sourceEntry: { content: string; warnings: UnpreservedLine[]; edits: SourceEdit[] } | undefined
  private conservativeWarnings = false
  private local: RichEditorPreservation
  private content: string
  private warnings: UnpreservedLine[] = []

  constructor(private readonly original: string) {
    this.content = original
    this.local = new RichEditorPreservation(original)
  }

  beginRich(content: string) {
    if (this.warnings.length) this.conservativeWarnings = true
    this.moveWarnings(content)
    this.sourceEntry = undefined
    this.local = new RichEditorPreservation(content)
  }

  setInitialExport(markdown: string) {
    // An initial source-mode edit is already intentional; only an import of
    // the original file can establish its immutable normalized counterpart.
    if (this.content === this.original) this.initialExport ??= markdown
    this.local.setInitialExport(markdown)
  }

  preserve(markdown: string): PreservedMarkdown {
    // Missing source bytes in a rich export do not prove that manual input
    // was undone. Only proven source-input cancellation can clear that record.
    if (this.initialExport !== undefined && markdown === this.initialExport && !this.sourceEdits.length) {
      this.moveWarnings(this.original)
      this.local = new RichEditorPreservation(this.original)
      this.local.setInitialExport(markdown)
      return this.currentResult()
    }
    const result = this.local.preserve(markdown)
    this.sourceEdits = advanceSourceEdits(this.sourceEdits, this.content, result.markdown)
    this.moveWarnings(result.markdown)
    const added = this.local.unpreservedLineLocations(result.markdown, result.unpreservedLines)
    const previous = new Map<string, number>()
    const key = (warning: UnpreservedLine) => JSON.stringify([warning.line, warning.removed])
    for (const warning of this.warnings) previous.set(key(warning), (previous.get(key(warning)) ?? 0) + 1)
    const occurrences = new Map<string, number>()
    // A current line is warned once even if multiple rich imports touch it.
    this.warnings = [...this.warnings, ...added.filter((item) => {
      const identity = key(item), occurrence = (occurrences.get(identity) ?? 0) + 1
      occurrences.set(identity, occurrence)
      return (previous.get(identity) ?? 0) < occurrence
    })]
    if (result.markdown === this.original) this.warnings = []
    return this.currentResult()
  }

  editSource(markdown: string): PreservedMarkdown {
    // Recompute from source entry, so typing and then undoing a character also
    // restores the warning and manual-edit state from before that input.
    this.sourceEntry ??= { content: this.content, warnings: this.warnings, edits: this.sourceEdits }
    const entry = this.sourceEntry
    this.content = entry.content
    this.warnings = entry.warnings
    if (this.warnings.length) this.conservativeWarnings = true
    // An exact earlier source snapshot also proves an undo across rich/source
    // switches; retain any manual inputs that preceded that snapshot.
    const reverted = entry.edits.findIndex((edit) => edit.before === markdown)
    this.sourceEdits = markdown === this.original ? []
      : markdown === entry.content ? entry.edits
      : reverted >= 0 ? entry.edits.slice(0, reverted)
      : netSourceEdits(entry.edits, entry.content, markdown)
    this.moveWarnings(markdown)
    if (markdown === this.original) this.sourceEntry = { content: markdown, warnings: [], edits: [] }
    this.local = new RichEditorPreservation(markdown)
    return this.currentResult()
  }

  private currentResult(): PreservedMarkdown {
    return { markdown: this.content, unpreservedLines: this.conservativeWarnings ? this.remainingDifferences() : this.warnings.length }
  }

  private remainingDifferences(): number {
    if (this.content === this.original) return 0
    // A mode switch or a repeated block can lose the source origin of a
    // warning. Recount the actual original/save diff instead of trusting it.
    // Only unique, still-present source inputs can exempt either side.
    const original = this.original.split("\n"), saved = this.content.split("\n")
    try {
      const manualOriginal = new Set<number>(), manualSaved = new Set<number>()
      const unique = (lines: string[], value: string) => lines.filter((line) => line === value).length === 1
      for (const edit of this.sourceEdits) {
        const before = edit.before.split("\n"), after = edit.after.split("\n")
        const originalAlignment = new Map(matches(before, original, (a, b) => a === b))
        const savedAlignment = new Map(matches(after, saved, (a, b) => a === b))
        for (const { removed, added } of lineChanges(before, after)) {
          // Deleting/changing one repeated line cannot acknowledge another
          // survivor of that same output, even when the selected LCS says so.
          if (removed.some((line) => !unique(before, before[line]) && after.includes(before[line]))) continue
          const currentAdditions = added.filter((line) => savedAlignment.has(line) && unique(after, after[line]) && unique(saved, after[line]) && !before.includes(after[line]))
          for (const line of removed) {
            const origin = originalAlignment.get(line)
            if (origin !== undefined && (!added.length || currentAdditions.length === added.length) && unique(before, before[line]) && unique(original, before[line]) && !saved.includes(before[line])) manualOriginal.add(origin)
          }
          for (const line of added) {
            const current = savedAlignment.get(line)
            if (current !== undefined && unique(after, after[line]) && unique(saved, after[line]) && !before.includes(after[line])) manualSaved.add(current)
          }
        }
      }
      const count = lineChanges(original, saved).reduce((sum, { removed, added }) => sum + Math.max(
        removed.filter((line) => !manualOriginal.has(line)).length,
        added.filter((line) => !manualSaved.has(line)).length,
      ), 0)
      return count
    } catch {
      return Math.max(1, original.length, saved.length)
    }
  }

  private moveWarnings(markdown: string) {
    if (markdown === this.content) return
    if (this.warnings.length) this.conservativeWarnings = true
    if (markdown === this.original) {
      this.warnings = []
      this.sourceEdits = []
      this.conservativeWarnings = false
    }
    else if (this.warnings.length) {
      const before = this.content.split(/\r?\n/), after = markdown.split(/\r?\n/)
      try {
        const aligned = matches(before, after, (a, b) => a === b)
        const retained = new Map(aligned)
        const restored = new Set<number>()
        this.warnings = this.warnings.flatMap((warning) => {
          if (!warning.removed) {
            const line = retained.get(warning.line)
            return line === undefined ? [] : [{ line }]
          }
          const previous = [...aligned].reverse().find(([line]) => line < warning.line)
          const next = aligned.find(([line]) => line >= warning.line)
          const start = (previous?.[1] ?? -1) + 1, end = next?.[1] ?? after.length
          const available = Array.from({ length: end - start }, (_, offset) => start + offset).filter((line) => !restored.has(line))
          const restoredLines = matches(warning.removed, available.map((line) => after[line]), (a, b) => a === b).map(([, line]) => available[line])
          if (restoredLines.length === warning.removed.length) {
            for (const line of restoredLines) restored.add(line)
            return []
          }
          return [{ ...warning, line: lineGap(warning.line, before.length, after.length, aligned) }]
        })
      } catch {
        // Retain the warning rather than clearing it on an oversized edit.
      }
    }
    this.content = markdown
  }
}
