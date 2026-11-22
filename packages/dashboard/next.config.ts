import type { NextConfig } from "next"
import path from "node:path"

const apiTarget = `http://127.0.0.1:${process.env.NAIA_API_PORT || 3141}`

const nextConfig: NextConfig = {
  output: "standalone",
  // Core exposes TypeScript source to the schedule pages in the workspace.
  transpilePackages: ["@naia-adk/core"],
  // The custom dashboard server loads the Matrix package at runtime.
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  outputFileTracingIncludes: {
    "/*": ["./ax-messenger-gateway.mjs", "./messenger-gate.mjs", "../ax-messenger/package.json", "../ax-messenger/dist/**/*"],
  },
  // 포털 API만 백엔드로 넘긴다. Matrix API는 대시보드 커스텀 서버가 직접 처리한다.
  // 전부 넘기면 대시보드를 다른 기기에 열었을 때 /api/files로 작업 공간 전체 파일이 보이므로 포털만 넘긴다.
  rewrites: async () => [
    { source: "/api/portal", destination: `${apiTarget}/api/portal` },
    { source: "/api/portal/:path*", destination: `${apiTarget}/api/portal/:path*` },
  ],
}

export default nextConfig
