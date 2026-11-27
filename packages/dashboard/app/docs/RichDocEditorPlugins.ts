import React, { createElement, useId } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { Cell, useCellValue, usePublisher, type Realm } from "@mdxeditor/gurx"
import { COMMAND_PRIORITY_CRITICAL, DROP_COMMAND, PASTE_COMMAND } from "lexical"
import {
  frontmatterPlugin,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  linkDialogPlugin,
  tablePlugin,
  imagePlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  markdownShortcutPlugin,
  realmPlugin,
  closeImageDialog$,
  imageDialogState$,
  editorRootElementRef$,
  saveImage$,
  createActiveEditorSubscription$,
  syntaxExtensions$,
  rootEditor$,
  activeEditor$,
} from "@mdxeditor/editor"
import type { RichDocEditorComponentProps } from "./RichDocEditor"
import { hardBreakExportPlugin, tableCellChangesPlugin, tableHistoryReloadPlugin } from "./table-cell-changes"
import { singleTildeSyntax } from "./rich-editor-preservation"
import { RichEditorUploadCancelledError, type RichEditorUploadBatch } from "./rich-editor-upload"

const codeBlockLanguages = {
  "": "Text",
  ts: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  bash: "Bash",
  sh: "Shell",
  css: "CSS",
  html: "HTML",
  yaml: "YAML",
  python: "Python",
  sql: "SQL",
  mermaid: "Mermaid",
}

const dialogUploadPending$ = Cell(0)

export function RichImageUploadForm({ pending, initialValues = {}, onSave }: {
  pending: boolean
  initialValues?: { src?: string; altText?: string; title?: string }
  onSave: (values: { file: FileList; src: string; altText: string; title: string }) => void
}) {
  const id = useId()
  const fieldClass = "w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
  const field = (name: "src" | "altText" | "title", label: string) => createElement("label", { className: "grid gap-1" },
    label, createElement("input", { name, type: "text", defaultValue: initialValues[name] ?? "", disabled: pending, className: fieldClass }),
  )
  return createElement("form", {
    className: "grid gap-3",
    onSubmit: (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (pending) return
      const fields = event.currentTarget.elements
      onSave({
        file: (fields.namedItem("file") as HTMLInputElement).files,
        src: (fields.namedItem("src") as HTMLInputElement).value,
        altText: (fields.namedItem("altText") as HTMLInputElement).value,
        title: (fields.namedItem("title") as HTMLInputElement).value,
      })
    },
  },
  createElement("label", { htmlFor: `${id}-file`, className: "grid gap-1" }, "기기에서 그림 고르기",
    createElement("input", { id: `${id}-file`, name: "file", type: "file", accept: "image/*", disabled: pending })),
  field("src", "또는 그림 주소"), field("altText", "그림 설명"), field("title", "그림 제목"),
  pending && createElement("div", { role: "status", "aria-live": "polite", className: "text-sm text-neutral-300" }, "그림 올리는 중"),
  createElement("div", { className: "flex justify-end gap-2" },
    createElement("button", { type: "submit", disabled: pending, className: "rounded bg-neutral-100 px-3 py-1 text-neutral-900 disabled:opacity-50" }, "저장"),
    createElement(Dialog.Close, { asChild: true }, createElement("button", { type: "button", className: "rounded border border-neutral-700 px-3 py-1" }, "취소"))),
  )
}

function RichImageUploadDialog() {
  const state = useCellValue(imageDialogState$)
  const pending = useCellValue(dialogUploadPending$) > 0
  const editorRoot = useCellValue(editorRootElementRef$)
  const close = usePublisher(closeImageDialog$)
  const save = usePublisher(saveImage$)
  if (state.type === "inactive") return null
  return createElement(Dialog.Root, { open: true, onOpenChange: (open) => { if (!open) close() } },
    createElement(Dialog.Portal, { container: editorRoot?.current },
      createElement(Dialog.Overlay, { className: "fixed inset-0 z-50 bg-black/60" }),
      createElement(Dialog.Content, {
        className: "fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-neutral-700 bg-neutral-900 p-5 text-neutral-100 shadow-xl",
        "aria-describedby": undefined,
      },
      createElement(Dialog.Title, { className: "mb-4 font-semibold" }, "그림 넣기"),
      createElement(RichImageUploadForm, { pending, initialValues: state.type === "editing" ? state.initialValues : {}, onSave: save }))),
  )
}

function newUploadBatch(kind: RichEditorUploadBatch["kind"]): RichEditorUploadBatch {
  return { kind, pending: 0, errors: [], cancelled: false, dismissed: false }
}

class UploadBatches {
  private eventBatch: RichEditorUploadBatch | null = null
  private dialogRequests = new Map<RichEditorUploadBatch, Set<() => void>>()

  constructor(private realm: Realm) {
    // 같은 최고 우선순위의 기본 붙여넣기보다 먼저 등록하고 처리는 넘긴다.
    realm.pub(createActiveEditorSubscription$, (editor) => {
      const begin = (kind: "paste" | "drop", items: DataTransferItemList | undefined) => {
        const values = Array.from(items ?? [])
        // 설치된 붙여넣기는 그림만 있는 사건, 드롭은 그림 항목만 처리한다.
        if (!values.some((item) => item.type.includes("image")) || (kind === "paste" && values.some((item) => !item.type.includes("image")))) return false
        const batch = this.eventBatch = newUploadBatch(kind)
        queueMicrotask(() => { if (this.eventBatch === batch) this.eventBatch = null })
        return false
      }
      const unpaste = editor.registerCommand(PASTE_COMMAND, (event) => begin("paste", (event as ClipboardEvent).clipboardData?.items), COMMAND_PRIORITY_CRITICAL)
      const undrop = editor.registerCommand(DROP_COMMAND, (event) => begin("drop", event.dataTransfer?.items), COMMAND_PRIORITY_CRITICAL)
      return () => { unpaste(); undrop() }
    })
    realm.sub(imageDialogState$, (state) => {
      if (state.type !== "inactive") return
      for (const [batch, requests] of this.dialogRequests) {
        batch.cancelled = true
        for (const cancel of requests) cancel()
      }
      this.dialogRequests.clear()
      this.updateDialogPending()
    })
  }

  private updateDialogPending() {
    this.realm.pub(dialogUploadPending$, Array.from(this.dialogRequests.values()).reduce((count, requests) => count + requests.size, 0))
  }

  batch() {
    return this.eventBatch ?? newUploadBatch(this.realm.getValue(imageDialogState$).type === "inactive" ? "single" : "dialog")
  }

  cancellation(batch: RichEditorUploadBatch) {
    let cancel = () => {}
    const promise = new Promise<never>((_resolve, reject) => { cancel = () => reject(new RichEditorUploadCancelledError()) })
    if (batch.kind === "dialog") {
      const requests = this.dialogRequests.get(batch) ?? new Set()
      requests.add(cancel)
      this.dialogRequests.set(batch, requests)
      this.updateDialogPending()
    }
    return { promise, finish: () => {
      const requests = this.dialogRequests.get(batch)
      requests?.delete(cancel)
      if (requests?.size === 0) this.dialogRequests.delete(batch)
      this.updateDialogPending()
    } }
  }

  closeDialog() { this.realm.pub(closeImageDialog$) }
}

const uploadBatches$ = Cell<UploadBatches | null>(null)
const uploadDialogPlugin = realmPlugin<{ onReady: (batches: UploadBatches) => void }>({
  init(realm, params) {
    const batches = new UploadBatches(realm)
    realm.pub(uploadBatches$, batches)
    params?.onReady(batches)
  },
  update: (realm, params) => params?.onReady(realm.getValue(uploadBatches$)),
})

const literalSingleTildePlugin = realmPlugin({
  init(realm) {
    realm.pub(syntaxExtensions$, realm.getValue(syntaxExtensions$).map((extension) =>
      extension.text?.[126] ? singleTildeSyntax() : extension,
    ))
  },
})

const uploadCompletionPlugin = realmPlugin<{ onReady: (flush: () => void) => void }>({
  init(realm, params) {
    params?.onReady(() => {
      // Lexical read flushes a pending insertion synchronously. Its update
      // listener exports Markdown before the caller can enable saving.
      realm.getValue(activeEditor$)?.read(() => {})
      realm.getValue(rootEditor$)?.read(() => {})
    })
  },
  update(realm, params) {
    params?.onReady(() => {
      realm.getValue(activeEditor$)?.read(() => {})
      realm.getValue(rootEditor$)?.read(() => {})
    })
  },
})

export function createRichDocEditorPlugins(
  imagePreviewHandler: RichDocEditorComponentProps["imagePreviewHandler"],
  onTableHistory: () => void = () => {},
  imageUploadHandler?: RichDocEditorComponentProps["imageUploadHandler"],
  onImageUploadSettled?: RichDocEditorComponentProps["onImageUploadSettled"],
) {
  let batches: UploadBatches
  let flushInsertion = () => {}
  const upload = imageUploadHandler && (async (file: File) => {
    const batch = batches.batch()
    batch.pending++
    const cancellation = batches.cancellation(batch)
    let failed = false
    try {
      const src = await Promise.race([imageUploadHandler(file, batch), cancellation.promise])
      console.log("PLUGIN-UPLOAD-RACED", file.name, batch.kind)
      if (batch.cancelled) throw new RichEditorUploadCancelledError()
      return src
    } catch (error) {
      if (!batch.cancelled && !(error instanceof RichEditorUploadCancelledError)) {
        const message = error instanceof Error ? error.message : "연결을 확인한 뒤 다시 올려 주세요."
        batch.errors.push(message.startsWith(`${file.name}:`) ? message : `${file.name}: ${message}`)
        failed = true
      }
      throw error
    } finally {
      batch.pending--
      cancellation.finish()
      // 실패 안내가 대화 상자의 초점 제한에 가려지지 않게 한다.
      if (failed && batch.kind === "dialog") batches.closeDialog()
      // Promise consumers (including paste/drop Promise.all) enqueue insertion
      // after this handler resolves. Run once those consumers have completed.
      setTimeout(() => {
        flushInsertion()
        onImageUploadSettled?.({ batch, complete: batch.pending === 0 })
      }, 0)
    }
  })
  return [
    frontmatterPlugin(),
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    thematicBreakPlugin(),
    linkPlugin(),
    linkDialogPlugin(),
    tablePlugin({ tableCellPadding: false, tablePipeAlign: false }),
    tableCellChangesPlugin(),
    tableHistoryReloadPlugin({ onTableHistory }),
    uploadDialogPlugin({ onReady: (controller) => { batches = controller } }),
    uploadCompletionPlugin({ onReady: (flush) => { flushInsertion = flush } }),
    imagePlugin({ imagePreviewHandler, imageUploadHandler: upload, ImageDialog: RichImageUploadDialog }),
    codeBlockPlugin({ defaultCodeBlockLanguage: "" }),
    codeMirrorPlugin({ codeBlockLanguages }),
    markdownShortcutPlugin(),
    hardBreakExportPlugin(),
    literalSingleTildePlugin(),
  ]
}
