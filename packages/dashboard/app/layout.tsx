import type { Metadata } from "next"
import { Nav } from "./components/Nav"
import "./globals.css"

export const metadata: Metadata = {
  title: "Naia ADK",
  description: "AI Development Kit Dashboard",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="bg-neutral-950 text-neutral-100 antialiased">
        <Nav />
        <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  )
}
