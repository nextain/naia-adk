import React from "react"
import type { Metadata } from "next"
import { Nav } from "./components/Nav"
import { MainArea } from "./components/MainArea"
import { buildThemeInitScript } from "./theme-prefs"
import { buildLocaleInitScript } from "./i18n/index.ts"
import { I18nProvider } from "./i18n/provider.tsx"
import type { Locale } from "./i18n/types.ts"

export const metadata: Metadata = {
  title: "Naia ADK",
  description: "AI Development Kit Dashboard",
}

export default function RootLayout({
  children,
  initialLocale = "ko",
}: {
  children: React.ReactNode
  initialLocale?: Locale
}) {
  const locale: Locale = initialLocale === "en" ? "en" : "ko"
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: buildThemeInitScript() }} />
        <script dangerouslySetInnerHTML={{ __html: buildLocaleInitScript() }} />
      </head>
      <body className="bg-neutral-950 text-neutral-100 antialiased">
        <I18nProvider initialLocale={locale}>
          <Nav />
          <MainArea>{children}</MainArea>
        </I18nProvider>
      </body>
    </html>
  )
}
