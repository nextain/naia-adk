import React from "react"
import type { Metadata } from "next"
import { Nav } from "./components/Nav"
import { MainArea } from "./components/MainArea"
import { buildThemeInitScript } from "./theme-prefs"
import "./globals.css"

export const metadata: Metadata = {
  title: "Naia ADK",
  description: "AI Development Kit Dashboard",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: buildThemeInitScript() }} />
      </head>
      <body className="bg-neutral-950 text-neutral-100 antialiased">
        <Nav />
        <MainArea>{children}</MainArea>
      </body>
    </html>
  )
}
