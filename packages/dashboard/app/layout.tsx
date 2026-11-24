import React from "react"
import type { Metadata } from "next"
import "./globals.css"
import { Nav } from "./components/Nav"
import { MainArea } from "./components/MainArea"
import { buildThemeInitScript } from "./theme-prefs"
import { buildLocaleInitScript } from "./i18n/index.ts"
import { getRequestLocale } from "./i18n/server"
import { I18nProvider } from "./i18n/provider.tsx"
import type { Locale } from "./i18n/types.ts"
import { getWorkspaceDisplayName, resolveAdkWorkspaceRoot } from "@naia-adk/core/src/workspace-settings"

export async function generateMetadata(): Promise<Metadata> {
  const name = getWorkspaceDisplayName(resolveAdkWorkspaceRoot(process.cwd()))
  return {
    title: name,
    description: "AI Development Kit Dashboard",
  }
}

export default async function RootLayout({
  children,
  initialLocale,
}: {
  children: React.ReactNode
  initialLocale?: Locale
}) {
  // Per-request locale (cookie > Accept-Language > default) so SSR HTML and
  // <html lang> match the viewer's language. Unit renders pass initialLocale.
  const locale: Locale = initialLocale ?? (await getRequestLocale())
  const name = getWorkspaceDisplayName(resolveAdkWorkspaceRoot(process.cwd()))
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: buildThemeInitScript() }} />
        <script dangerouslySetInnerHTML={{ __html: buildLocaleInitScript() }} />
      </head>
      <body className="bg-neutral-950 text-neutral-100 antialiased">
        <I18nProvider initialLocale={locale}>
          <Nav workspaceDisplayName={name} />
          <MainArea>{children}</MainArea>
        </I18nProvider>
      </body>
    </html>
  )
}
