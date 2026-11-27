import { useEffect } from "react"
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext"
import {
  addExportVisitor$,
  addTableCellEditorChild$,
  createRootEditorSubscription$,
  NESTED_EDITOR_UPDATED_COMMAND,
  realmPlugin,
} from "@mdxeditor/editor"

// MDXEditor 4.0.4 normally exports table cells only on blur, Tab, or Enter.
// Every cell editor gets this listener when it mounts, so the first keystroke
// right after focusing a cell is not missed. Selection-only updates are ignored.
export function TableCellChangeListener() {
  const [editor] = useLexicalComposerContext()
  useEffect(() => editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
    if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return
    editor.dispatchCommand(NESTED_EDITOR_UPDATED_COMMAND, undefined)
  }), [editor])
  return null
}

export const tableCellChangesPlugin = realmPlugin({
  init(realm) {
    realm.pub(addTableCellEditorChild$, TableCellChangeListener)
  },
})

interface HistoryUpdate {
  tags: Set<string>
  dirtyElements: Map<string, unknown>
  dirtyLeaves: Set<string>
  editorState: { _nodeMap: Map<string, { getType(): string }> }
  prevEditorState: { _nodeMap: Map<string, { getType(): string }> }
}

// 표 칸 편집기는 처음 만든 내용을 계속 보여 주므로, 되돌리기·다시하기가 표를 바꾸면
// 편집기 전체를 지금 마크다운으로 다시 연다.
export function historyChangedTable(update: HistoryUpdate): boolean {
  if (!update.tags.has("historic")) return false
  const keys = [...update.dirtyElements.keys(), ...update.dirtyLeaves]
  return keys.some((key) =>
    update.editorState._nodeMap.get(key)?.getType() === "table"
    || update.prevEditorState._nodeMap.get(key)?.getType() === "table",
  )
}

export const tableHistoryReloadPlugin = realmPlugin<{ onTableHistory: () => void }>({
  init(realm, params) {
    realm.pub(createRootEditorSubscription$, (editor) => editor.registerUpdateListener((update) => {
      if (historyChangedTable(update as unknown as HistoryUpdate)) params?.onTableHistory()
    }))
  },
})

// 기본 방문기는 Shift+Enter 줄바꿈을 보통 글자 "\n"으로 내보내 다시 열면 한 줄로 합쳐진다.
// 마크다운 강제 줄바꿈으로 저장하고, 그런 문서는 다음에 원문 편집으로 연다.
export const hardBreakExportVisitor = {
  priority: 1,
  testLexicalNode: (node: { getType?: () => string } | null | undefined) => node?.getType?.() === "linebreak",
  visitLexicalNode: ({ mdastParent, actions }: {
    mdastParent: unknown
    actions: { appendToParent: (parent: unknown, node: { type: "break" }) => unknown }
  }) => {
    actions.appendToParent(mdastParent, { type: "break" })
  },
}

export const hardBreakExportPlugin = realmPlugin({
  init(realm) {
    realm.pub(addExportVisitor$, hardBreakExportVisitor as never)
  },
})
