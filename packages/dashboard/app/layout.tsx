import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Naia ADK",
  description: "AI Development Kit Dashboard",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="bg-neutral-950 text-neutral-100 antialiased">
        <nav className="border-b border-neutral-800 px-6 py-3 flex items-center gap-8">
          <a href="/" className="font-bold text-lg">Naia ADK</a>
          <a href="/workspace" className="text-sm text-neutral-400 hover:text-white">Workspace</a>
          <a href="/skills" className="text-sm text-neutral-400 hover:text-white">Skills</a>
          <a href="/settings" className="text-sm text-neutral-400 hover:text-white">Settings</a>
        </nav>
        <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  )
}
