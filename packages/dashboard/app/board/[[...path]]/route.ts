// 회사가 정한 작업보드를 대시보드와 같은 주소(/board/...)로 넘겨준다.
// 작업보드 포트는 회사 설정(adk-company.json)에서 읽으므로 사람은 대시보드 주소 하나만 기억하면 된다.

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3141"
const BOARD_HOST = process.env.ADK_BOARD_HOST || "127.0.0.1"

// 작업보드 관리 기능이 쓰는 헤더만 넘긴다(쿠키 등 대시보드 쪽 헤더는 넘기지 않는다).
const REQUEST_HEADERS = ["content-type", "authorization", "if-match", "x-board-actor", "x-board-request-id"]
const RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "www-authenticate", "allow"]

export const dynamic = "force-dynamic"

async function boardPort(): Promise<number | null> {
  try {
    const res = await fetch(`${API}/api/portal`, { cache: "no-store" })
    if (!res.ok) return null
    const data = (await res.json()) as { board?: { port?: number } | null }
    const port = data.board?.port
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
  } catch {
    return null
  }
}

async function proxy(req: Request, ctx: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  const { path = [] } = await ctx.params
  if (path.some((seg) => seg === ".." || seg === "." || seg.includes("/") || seg.includes("\\"))) {
    return new Response("not found\n", { status: 404 })
  }
  const port = await boardPort()
  if (!port) {
    return new Response("작업보드가 설정되지 않았습니다. pnpm adk:setup으로 회사 설정을 먼저 하세요.\n", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  }

  const search = new URL(req.url).search
  const target = `http://${BOARD_HOST}:${port}/${path.map(encodeURIComponent).join("/")}${search}`
  const headers = new Headers()
  for (const name of REQUEST_HEADERS) {
    const value = req.headers.get(name)
    if (value) headers.set(name, value)
  }

  let upstream: Response
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      cache: "no-store",
      redirect: "manual",
    })
  } catch {
    return new Response("작업보드에 연결하지 못했습니다. 작업보드가 켜져 있는지 확인하세요.\n", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  }

  const out = new Headers()
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) out.set(name, value)
  }
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

export const GET = proxy
export const HEAD = proxy
export const POST = proxy
