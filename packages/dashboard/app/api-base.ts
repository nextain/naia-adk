/**
 * 서버 전용 API 기본 URL 생성 함수 (FE 8장 127행)
 * - 서버 전용으로 동작하며, 요청마다 process.env["NAIA_API_PORT"]를 읽어 주소를 동적으로 결정한다.
 * - 기본 포트는 3141이다.
 */
export function apiBase(): string {
  const port = process.env["NAIA_API_PORT"] || "3141"
  return `http://127.0.0.1:${port}`
}

export default apiBase
