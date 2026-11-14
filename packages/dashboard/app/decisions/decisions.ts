export interface DecisionConfig {
  source: string
  path: string
  pendingHeading: string
  doneHeading: string
}

export interface DecisionRow { number: string; title: string }

// The document is the source of truth. Headings are exact to avoid silently
// showing an unrelated table when a document is reorganized.
export function parseDecisionSection(markdown: string, heading: string): DecisionRow[] {
  const lines = markdown.split(/\r?\n/)
  const target = heading.trim()
  const matches = lines.map((line, index) => line.trim() === target ? index : -1).filter((index) => index >= 0)
  if (!target || matches.length !== 1) throw new Error(`제목을 하나만 찾을 수 없습니다: ${target}`)
  const start = matches[0]
  const level = /^(#{1,6})\s/.exec(target)?.[1].length
  if (!level) throw new Error("제목은 #과 공백으로 시작해야 합니다")
  let header: string[] | null = null
  let separator = false
  const result: DecisionRow[] = []
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim()
    const next = /^(#{1,6})\s/.exec(line)
    if (next && next[1].length <= level) break
    if (!line.startsWith("|")) { if (separator) break; continue }
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((s) => s.trim().replace(/\\\|/g, "|"))
    if (!header) { header = cells; continue }
    if (!separator) {
      if (cells.length !== header.length || !cells.every((s) => /^:?-{2,}:?$/.test(s))) throw new Error(`표 형식이 잘못되었습니다: ${target}`)
      separator = true; continue
    }
    const titleIndex = header.findIndex((s) => ["무엇", "결정", "내용", "제목"].includes(s))
    const numberIndex = header.findIndex((s) => ["#", "번호"].includes(s))
    const title = cells[titleIndex < 0 ? 1 : titleIndex]
    if (title) result.push({ number: cells[numberIndex < 0 ? 0 : numberIndex] ?? "", title })
  }
  if (!header || !separator) throw new Error(`표를 찾지 못했습니다: ${target}`)
  return result
}

export function plainDecisionText(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)]+\)/g, "$1").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim()
}
