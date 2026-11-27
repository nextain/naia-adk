"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import {
  MDXEditor,
  type MDXEditorMethods,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  ListsToggle,
  CreateLink,
  InsertImage,
  InsertTable,
  InsertThematicBreak,
  InsertCodeBlock,
} from "@mdxeditor/editor"
import "@mdxeditor/editor/style.css"
import styles from "./RichDocEditor.module.css"
import type { RichDocEditorComponentProps } from "./RichDocEditor"
import { createRichDocEditorPlugins } from "./RichDocEditorPlugins"
import { discardRichEditorHtmlPaste } from "./rich-editor-html"
import { RichEditorUploadCancelledError, RichEditorUploadError } from "./rich-editor-upload"
import { cleanRichEditorMarkdown, RICH_EDITOR_MARKDOWN_OPTIONS } from "./rich-editor-preservation"

export default function RichDocEditorClient({
  markdown,
  onChange,
  onError,
  readOnly,
  imagePreviewHandler,
  imageUploadHandler,
  onImageUploadSettled,
}: RichDocEditorComponentProps) {
  const editorRef = useRef<MDXEditorMethods>(null)
  const currentMarkdownRef = useRef(markdown)
  const acceptedMarkdownRef = useRef(markdown)
  const generationRef = useRef(0)
  const [reloadKey, setReloadKey] = useState(0)
  // 다시 열린 편집기는 마지막으로 내보낸 마크다운에서 시작한다.
  const reloadAfterTableHistory = useCallback(() => {
    setReloadKey(++generationRef.current)
  }, [])

  useEffect(() => {
    // Strict Mode가 효과를 다시 여는 경우에도 새 세대로 편집기를 연다.
    setReloadKey(generationRef.current)
    return () => { generationRef.current++ }
  }, [])

  useEffect(() => {
    // The parent acknowledges a preserved source string, which can differ from
    // the editor export. Reimporting that acknowledgement would reset selection
    // and undo history on every keystroke.
    if (markdown === acceptedMarkdownRef.current) return
    acceptedMarkdownRef.current = markdown
    currentMarkdownRef.current = markdown
    editorRef.current?.setMarkdown(markdown)
  }, [markdown])

  useEffect(() => {
    // 그림 플러그인이 다시 던지는 업로드 실패는 위쪽 알림에서 이미 처리했다.
    const handledUploadFailure = (event: PromiseRejectionEvent) => {
      if (event.reason instanceof RichEditorUploadError) event.preventDefault()
    }
    window.addEventListener("unhandledrejection", handledUploadFailure)
    return () => window.removeEventListener("unhandledrejection", handledUploadFailure)
  }, [])

  return (
    <div className="h-full min-w-0" onPasteCapture={discardRichEditorHtmlPaste}>
      <MDXEditor
        key={reloadKey}
        ref={editorRef}
        markdown={currentMarkdownRef.current}
        toMarkdownOptions={RICH_EDITOR_MARKDOWN_OPTIONS}
        onChange={(nextMarkdown, initialMarkdownNormalize) => {
          if (reloadKey !== generationRef.current) return
          const cleaned = cleanRichEditorMarkdown(nextMarkdown)
          currentMarkdownRef.current = cleaned
          const accepted = onChange(cleaned, initialMarkdownNormalize)
          acceptedMarkdownRef.current = typeof accepted === "string" ? accepted : cleaned
        }}
        onError={onError}
        readOnly={readOnly}
        suppressHtmlProcessing
        className={`dark-theme ${styles.editor}`}
        contentEditableClassName={styles.content}
        plugins={[
          ...createRichDocEditorPlugins(imagePreviewHandler, () => {
            if (reloadKey === generationRef.current) reloadAfterTableHistory()
          }, imageUploadHandler && (async (file, batch) => {
            const src = await imageUploadHandler(file, batch)
            if (reloadKey !== generationRef.current) {
              if (batch) batch.cancelled = true
              throw new RichEditorUploadCancelledError()
            }
            return src
          }), onImageUploadSettled),
          toolbarPlugin({
            toolbarClassName: styles.toolbar,
            toolbarContents: () => (
              <>
                <UndoRedo />
                <BoldItalicUnderlineToggles />
                <BlockTypeSelect />
                <ListsToggle />
                <CreateLink />
                <InsertImage />
                <InsertTable />
                <InsertThematicBreak />
                <InsertCodeBlock />
              </>
            ),
          }),
        ]}
      />
    </div>
  )
}
