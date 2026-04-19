import type { NextConfig } from "next"

const apiTarget = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3141"

const nextConfig: NextConfig = {
  output: "standalone",
  rewrites: async () => [
    { source: "/api/:path*", destination: `${apiTarget}/api/:path*` },
  ],
}

export default nextConfig
