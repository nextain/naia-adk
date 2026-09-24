import type { NextConfig } from "next"

const apiTarget = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3141"

const nextConfig: NextConfig = {
  output: "standalone",
  // 브라우저가 부르는 API는 문서 화면(/api/portal)뿐이다. 나머지 화면은 서버 쪽에서 API를 직접 부른다.
  // 전부 넘기면 대시보드를 다른 기기에 열었을 때 /api/files로 작업 공간 전체 파일이 보이므로 포털만 넘긴다.
  rewrites: async () => [
    { source: "/api/portal", destination: `${apiTarget}/api/portal` },
    { source: "/api/portal/:path*", destination: `${apiTarget}/api/portal/:path*` },
  ],
}

export default nextConfig
