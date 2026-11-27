// 문서 지문(sha256 64자 16진) 정규화 및 응답 머리글 읽기 도우미.

export const MSG_DOC_HASH_MISSING = "문서 지문을 받지 못해 저장하지 않았습니다. 새로 고침 뒤 다시 시도해 주세요."

// 앞뒤 공백, W/ 약한 지문 접두어, 따옴표를 벗기고 64자 16진(소문자)일 때만 돌려준다.
// 그 밖에는 빈 문자열("")을 돌려준다.
export function normalizeDocHash(value: unknown): string {
  if (typeof value !== "string") return ""
  let s = value.trim()
  if (/^w\//i.test(s)) {
    s = s.slice(2).trim()
  }
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    s = s.slice(1, -1).trim()
  } else {
    s = s.replace(/^"+|"+$/g, "").trim()
  }
  if (/^w\//i.test(s)) {
    s = s.slice(2).trim()
    s = s.replace(/^"+|"+$/g, "").trim()
  }
  const lower = s.toLowerCase()
  return /^[0-9a-f]{64}$/.test(lower) ? lower : ""
}

// 응답에서 X-Doc-Sha256 머리글을 먼저 읽고, 없거나 정규화 결과가 비면 ETag를 읽어 정규화한다.
export function docHashFromResponse(
  res: { headers?: { get?: (name: string) => string | null } | null } | null | undefined,
): string {
  const getHeader = (name: string): string | null => {
    try {
      return res?.headers?.get ? res.headers.get(name) : null
    } catch {
      return null
    }
  }
  const xDoc = normalizeDocHash(getHeader("x-doc-sha256") ?? getHeader("X-Doc-Sha256"))
  if (xDoc) return xDoc
  return normalizeDocHash(getHeader("etag") ?? getHeader("ETag"))
}
