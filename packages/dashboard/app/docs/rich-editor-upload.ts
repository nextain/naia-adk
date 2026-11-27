export class RichEditorUploadError extends Error {}

export class RichEditorUploadCancelledError extends RichEditorUploadError {
  constructor() { super("그림 올리기를 취소했습니다.") }
}

// 한 번의 붙여넣기·끌어놓기·대화 상자 저장을 각각 구분한다.
export interface RichEditorUploadBatch {
  kind: "dialog" | "paste" | "drop" | "single"
  pending: number
  errors: string[]
  cancelled: boolean
  dismissed: boolean
}

export interface RichEditorUploadSettlement {
  batch: RichEditorUploadBatch
  complete: boolean
}

export async function uploadRichEditorImage(source: string, path: string, file: File): Promise<string> {
  const fallback = "그림을 올리지 못했습니다. 연결을 확인한 뒤 다시 올려 주세요."
  try {
    const query = new URLSearchParams({ source, path, name: file.name })
    const response = await fetch(`/api/portal/doc-assets?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    })
    const result = await response.json() as { path?: unknown; message?: unknown }
    if (!response.ok) throw new RichEditorUploadError(`${file.name}: ${typeof result.message === "string" ? result.message : fallback}`)
    if (typeof result.path !== "string" || !/^assets\/[\p{L}\p{N}_-]+\.(png|jpg|gif|webp)$/u.test(result.path)) throw new RichEditorUploadError(`${file.name}: ${fallback}`)
    return result.path
  } catch (error) {
    if (error instanceof RichEditorUploadError) throw error
    throw new RichEditorUploadError(`${file.name}: ${fallback}`)
  }
}
