"use client"

import React, { Component, useCallback, useState, type ComponentType } from "react"
import dynamic from "next/dynamic"
import { convertWikiLinks, resolveRelativePath } from "./markdown"
import { richDocHasHardBreak, richDocNeedsHtmlFallback } from "./rich-editor-html"
import { uploadRichEditorImage, RichEditorUploadCancelledError, type RichEditorUploadBatch, type RichEditorUploadSettlement } from "./rich-editor-upload"
import { RichEditorPreservationSession } from "./rich-editor-preservation"

export interface RichDocEditorProps {
  source: string
  path: string
  content: string
  onChange: (markdown: string) => void
  disabled?: boolean
  onUploadPendingChange?: (count: number) => void
  onUnpreservedLinesChange?: (count: number) => void
  preservationSession?: RichEditorPreservationSession
}

export interface RichDocEditorComponentProps {
  markdown: string
  onChange: (markdown: string, initialMarkdownNormalize?: boolean) => string | void
  onError: (payload: { error: string; source: string }) => void
  readOnly: boolean
  imagePreviewHandler: (src: string) => Promise<string>
  imageUploadHandler?: (file: File, batch?: RichEditorUploadBatch) => Promise<string>
  onImageUploadSettled?: (settlement?: RichEditorUploadSettlement) => void
}

export const RICH_DOC_FALLBACK_NOTICE = "이 문서는 서식 편집으로 열기 어려워 원문 편집으로 표시합니다"
export const RICH_DOC_HTML_FALLBACK_NOTICE = "HTML·JSX 구문을 그대로 보존하기 위해 원문 편집으로 표시합니다"
export const RICH_DOC_BREAK_FALLBACK_NOTICE = "줄 끝 강제 줄바꿈을 그대로 보존하기 위해 원문 편집으로 표시합니다"

const ClientEditor = dynamic<RichDocEditorComponentProps>(
  () => import("./RichDocEditorClient"),
  {
    ssr: false,
    loading: () => <div role="status" className="p-4 text-sm text-neutral-400">서식 편집기를 여는 중입니다.</div>,
  },
)

// 미리보기와 같은 문서 기준 경로를 쓰며, 저장할 마크다운의 그림 주소는 바꾸지 않는다.
export function resolveRichEditorImageUrl(source: string, path: string, src: string): string {
  if (!source || !path || !src || /^(https?:\/\/|\/)/i.test(src)) return src
  const resolved = resolveRelativePath(path, src)
  return `/api/portal/asset?source=${encodeURIComponent(source)}&path=${encodeURIComponent(resolved)}`
}

export type RichDocEditorBoundaryProps = RichDocEditorProps & {
  EditorComponent: ComponentType<RichDocEditorComponentProps>
  imagePreviewHandler: RichDocEditorComponentProps["imagePreviewHandler"]
  onUploadError?: (message: string | null, dismiss?: () => void) => void
}

function fallbackState(content: string) {
  if (richDocNeedsHtmlFallback(content)) return { failed: true, notice: RICH_DOC_HTML_FALLBACK_NOTICE }
  if (richDocHasHardBreak(content)) return { failed: true, notice: RICH_DOC_BREAK_FALLBACK_NOTICE }
  return { failed: convertWikiLinks(content) !== content, notice: RICH_DOC_FALLBACK_NOTICE }
}

export class RichDocEditorBoundary extends Component<RichDocEditorBoundaryProps, { failed: boolean; notice: string }> {
  // 처음 원문으로 연 문서는 입력 중 특수 구문을 지워도 같은 편집기를 유지한다.
  state = fallbackState(this.props.content)
  private mounted = false
  private disposed = false
  private generation = 0
  private pendingError = false
  private preservation = this.props.preservationSession ?? new RichEditorPreservationSession(this.props.content)
  private acceptedContent = this.props.content
  private uploadPending = 0
  private uploadBatchSequence = new WeakMap<RichEditorUploadBatch, number>()
  private nextUploadBatchSequence = 0
  private uploadFailures = new Map<number, RichEditorUploadBatch>()
  private singleUploadError: string | null = null

  constructor(props: RichDocEditorBoundaryProps) {
    super(props)
    this.preservation.beginRich(props.content)
  }

  static getDerivedStateFromProps(props: RichDocEditorBoundaryProps, state: { failed: boolean }) {
    if (!state.failed) {
      const next = fallbackState(props.content)
      if (next.failed) return next.notice === RICH_DOC_FALLBACK_NOTICE ? { failed: true } : next
    }
    return null
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidMount() {
    this.mounted = true
    this.disposed = false
    if (this.pendingError) this.setState({ failed: true })
    // Strict Mode가 같은 인스턴스를 다시 열면 자식 콜백도 새 세대로 연결한다.
    else if (this.generation > 0) this.forceUpdate()
  }

  componentWillUnmount() {
    this.mounted = false
    this.disposed = true
    this.generation++
    if (this.uploadPending) this.props.onUploadPendingChange?.(0)
    this.uploadPending = 0
  }

  componentDidUpdate(previous: RichDocEditorBoundaryProps) {
    if (this.props.content !== previous.content && this.props.content !== this.acceptedContent) {
      const result = this.preservation.editSource(this.props.content)
      this.acceptedContent = this.props.content
      this.props.onUnpreservedLinesChange?.(result.unpreservedLines)
    }
  }

  private handleError = () => {
    this.pendingError = true
    // 파싱 오류는 자식의 초기 렌더링 중에도 오므로 렌더링을 마친 뒤 전환한다.
    queueMicrotask(() => {
      if (this.mounted) this.setState({ failed: true })
    })
  }

  private handleChange = (markdown: string, initialMarkdownNormalize = false) => {
    if (this.disposed) return this.acceptedContent
    if (initialMarkdownNormalize) {
      this.preservation.setInitialExport(markdown)
      return this.acceptedContent
    }
    const result = this.state.failed ? this.preservation.editSource(markdown) : this.preservation.preserve(markdown)
    this.acceptedContent = result.markdown
    this.props.onUnpreservedLinesChange?.(result.unpreservedLines)
    if (result.markdown !== this.props.content) this.props.onChange(result.markdown)
    return result.markdown
  }

  private handleImageUploadSettled = (settlement?: RichEditorUploadSettlement) => {
    this.uploadPending = Math.max(0, this.uploadPending - 1)
    if (this.mounted) this.props.onUploadPendingChange?.(this.uploadPending)
    if (!this.mounted || !settlement) return
    const { batch, complete } = settlement
    const sequence = this.uploadBatchSequence.get(batch) ?? 0
    if (batch.cancelled || batch.dismissed) return
    if (batch.errors.length) {
      this.uploadFailures.set(sequence, batch)
    } else if (complete) {
      this.uploadFailures.delete(sequence)
    }
    this.publishUploadErrors()
  }

  private dismissUploadErrors = () => {
    for (const batch of this.uploadFailures.values()) batch.dismissed = true
    this.uploadFailures.clear()
    this.singleUploadError = null
    this.publishUploadErrors()
  }

  private publishUploadErrors = () => {
    const errors = [...this.uploadFailures].sort(([left], [right]) => left - right)
      .flatMap(([, batch]) => batch.errors)
    const messages = [...(errors.length ? ["그림이 들어가지 않았습니다.", ...errors] : []), ...(this.singleUploadError ? [this.singleUploadError] : [])]
    this.props.onUploadError?.(messages.length ? messages.join("\n") : null, this.dismissUploadErrors)
  }

  private handleImageUpload = async (file: File, batch?: RichEditorUploadBatch): Promise<string> => {
    const generation = this.generation
    if (this.disposed) throw new RichEditorUploadCancelledError()
    if (batch && !this.uploadBatchSequence.has(batch)) this.uploadBatchSequence.set(batch, ++this.nextUploadBatchSequence)
    this.uploadPending++
    this.props.onUploadPendingChange?.(this.uploadPending)
    try {
      const relativePath = await uploadRichEditorImage(this.props.source, this.props.path, file)
      if (generation !== this.generation || this.disposed) {
        if (batch) batch.cancelled = true
        throw new RichEditorUploadCancelledError()
      }
      if (!batch && this.mounted) {
        this.singleUploadError = null
        this.publishUploadErrors()
      }
      return relativePath
    } catch (error) {
      if (!batch && this.mounted && !(error instanceof RichEditorUploadCancelledError)) {
        this.singleUploadError = (error as Error).message
        this.publishUploadErrors()
      }
      throw error
    }
  }

  render() {
    const { content, disabled, EditorComponent, imagePreviewHandler } = this.props
    const generation = this.generation
    if (this.state.failed) {
      return (
        <div className="flex h-full min-w-0 flex-col gap-2">
          <div role="status" className="rounded border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
            {this.state.notice}
          </div>
          <textarea
            aria-label="원문 편집"
            value={content}
            onChange={(event) => { if (!disabled) this.handleChange(event.target.value) }}
            disabled={disabled}
            spellCheck={false}
            className="min-h-80 w-full min-w-0 flex-1 resize-none rounded border border-neutral-800 bg-neutral-950 p-4 font-mono text-sm text-neutral-200 outline-none focus:border-neutral-600 disabled:opacity-60"
          />
        </div>
      )
    }

    return (
      <EditorComponent
        markdown={content}
        onChange={(markdown, initialMarkdownNormalize) => generation === this.generation
          ? this.handleChange(markdown, initialMarkdownNormalize) : this.acceptedContent}
        onError={this.handleError}
        readOnly={Boolean(disabled)}
        imagePreviewHandler={imagePreviewHandler}
        imageUploadHandler={(file, batch) => generation === this.generation
          ? this.handleImageUpload(file, batch) : Promise.reject(new RichEditorUploadCancelledError())}
        onImageUploadSettled={(settlement) => {
          if (generation === this.generation) this.handleImageUploadSettled(settlement)
        }}
      />
    )
  }
}

// 실 편집기와 같은 오류·변경 경계를 가벼운 편집기 대역으로 검증할 수 있다.
export function RichDocEditorWithComponent({
  EditorComponent,
  ...props
}: RichDocEditorProps & { EditorComponent: ComponentType<RichDocEditorComponentProps> }) {
  const documentKey = JSON.stringify([props.source, props.path])
  const [uploadError, setUploadError] = useState<{ key: string; message: string; dismiss?: () => void } | null>(null)
  const onUploadError = useCallback((message: string | null, dismiss?: () => void) => {
    setUploadError(message ? { key: documentKey, message, dismiss } : null)
  }, [documentKey])
  const imagePreviewHandler = useCallback(
    (src: string) => Promise.resolve(resolveRichEditorImageUrl(props.source, props.path, src)),
    [props.source, props.path],
  )

  return (
    <div data-rich-doc-editor className="h-[600px] min-w-0 max-w-full overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950">
      {uploadError?.key === documentKey && (
        <div role="alert" className="flex items-start gap-2 border-b border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          <span className="min-w-0 flex-1 whitespace-pre-line break-words">{uploadError.message}</span>
          <button type="button" onClick={() => {
            uploadError.dismiss?.()
            setUploadError(null)
          }} aria-label="그림 올리기 오류 닫기">닫기</button>
        </div>
      )}
      <RichDocEditorBoundary
        key={documentKey}
        {...props}
        EditorComponent={EditorComponent}
        imagePreviewHandler={imagePreviewHandler}
        onUploadError={onUploadError}
      />
    </div>
  )
}

export function RichDocEditor(props: RichDocEditorProps) {
  return <RichDocEditorWithComponent {...props} EditorComponent={ClientEditor} />
}

export default RichDocEditor
