import type { ClipboardEvent } from "react"
import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import { mdxFromMarkdown } from "mdast-util-mdx"
import { mdxjs } from "micromark-extension-mdxjs"
import { splitFrontmatter } from "./markdown"

const markdownParser = unified().use(remarkParse).use(remarkGfm)
const mdxParser = unified().use(remarkParse).use(remarkGfm)
  .data("micromarkExtensions", [mdxjs()])
  .data("fromMarkdownExtensions", mdxFromMarkdown())

// 서식 편집기는 MDX 확장 없이 읽으므로 중괄호 식은 보통 글자로 남는다. JSX 모양만 원문으로 보낸다.
const htmlNodeTypes = new Set([
  "html",
  "mdxJsxFlowElement",
  "mdxJsxTextElement",
])

interface SyntaxNode {
  type: string
  value?: string
  children?: SyntaxNode[]
}

function hasMdxCandidate(node: SyntaxNode): boolean {
  if (node.type === "code" || node.type === "inlineCode") return false
  // MDX의 식별자는 $, _, 유니코드도 허용한다. 후보는 넓게 잡고 AST로 판정한다.
  if (node.type === "text" && /<[^ \t\r\n0-9=]/.test(node.value ?? "")) return true
  return node.children?.some(hasMdxCandidate) ?? false
}

function hasHtmlNode(node: SyntaxNode): boolean {
  if (htmlNodeTypes.has(node.type)) return true
  if (node.type === "code" || node.type === "inlineCode") return false
  return node.children?.some(hasHtmlNode) ?? false
}

// 원문은 검사만 한다. 코드 예시와 머리말을 제외한 HTML·MDX를 편집기에 넘기지 않는다.
export function richDocNeedsHtmlFallback(content: string): boolean {
  const { body } = splitFrontmatter(content)
  try {
    // MDX는 HTML 주석을 파싱하지 못하므로 일반 마크다운을 먼저 검사한다.
    const markdownTree = markdownParser.parse(body)
    if (hasHtmlNode(markdownTree)) return true
    if (!hasMdxCandidate(markdownTree)) return false
    return hasHtmlNode(mdxParser.parse(body))
  } catch {
    return true
  }
}

function hasBreakNode(node: SyntaxNode): boolean {
  if (node.type === "break") return true
  return node.children?.some(hasBreakNode) ?? false
}

// 서식 편집기는 강제 줄바꿈(줄 끝 공백 두 칸·역빗금)을 보통 줄바꿈으로 저장하므로 원문으로 연다.
export function richDocHasHardBreak(content: string): boolean {
  try {
    return hasBreakNode(markdownParser.parse(splitFrontmatter(content).body))
  } catch {
    return true
  }
}

type PasteEvent = Pick<ClipboardEvent, "clipboardData" | "preventDefault" | "stopPropagation"> & { target: EventTarget | null }

function createPlainTextPaste(text: string): Event | null {
  try {
    const data = new DataTransfer()
    data.setData("text/plain", text)
    return new window.ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
  } catch {
    return null
  }
}

function createImagePaste(files: File[]): Event | null {
  try {
    const data = new DataTransfer()
    files.forEach((file) => data.items.add(file))
    return new window.ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
  } catch {
    return null
  }
}

// HTML과 HTML 노드를 담을 수 있는 Lexical 조각은 버리고, 함께 온 일반 글자만 다시 붙여 넣는다.
export function discardRichEditorHtmlPaste(
  event: PasteEvent,
  createPaste: (text: string) => Event | null = createPlainTextPaste,
  createFilePaste: (files: File[]) => Event | null = createImagePaste,
): void {
  // 파일 붙여넣기는 그림 플러그인의 업로드 처리기로 넘긴다.
  const images = Array.from(event.clipboardData.files ?? []).filter((file) => file.type.startsWith("image/"))
  if (images.length) {
    // 그림과 HTML이 함께 오면 그림만 다시 보내 플러그인의 혼합 본문 거절을 피한다.
    if (Array.from(event.clipboardData.types).some((type) => type.toLowerCase().startsWith("text/") || type === "application/x-lexical-editor")) {
      event.preventDefault()
      event.stopPropagation()
      const paste = createFilePaste(images)
      if (paste && event.target) event.target.dispatchEvent(paste)
    }
    return
  }
  if (!Array.from(event.clipboardData.types).some((type) =>
    ["text/html", "application/x-lexical-editor"].includes(type.toLowerCase()),
  )) return
  event.preventDefault()
  event.stopPropagation()
  const text = event.clipboardData.getData("text/plain")
  if (!text || !event.target) return
  const plain = createPaste(text)
  if (plain) event.target.dispatchEvent(plain)
}
