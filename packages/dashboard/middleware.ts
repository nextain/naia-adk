import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { hostGuard } from "./host-guard.mjs"

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
  response.headers.set("Content-Security-Policy", "frame-ancestors 'self'")
  response.headers.set("X-Frame-Options", "SAMEORIGIN")
  return response
}
