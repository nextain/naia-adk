import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { hostGuard } from "./host-guard.mjs"
import { FRAME_ANCESTORS_CSP } from "./frame-policy.mjs"

export const config = {
  matcher: [
    "/:path*",
  ],
  runtime: "nodejs",
}

export function middleware(request: NextRequest) {
  const host = request.headers.get("host") || undefined
  if (!hostGuard(host)) {
    return new NextResponse("Misdirected Request", {
      status: 421,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    })
  }

  const response = NextResponse.next()
  response.headers.set("Content-Security-Policy", FRAME_ANCESTORS_CSP)
  return response
}
