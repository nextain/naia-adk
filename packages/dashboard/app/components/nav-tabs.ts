// Top tabs and main-area width. hasMessenger is /api/portal messenger.enabled: the 대화 tab hides only
// when the server says the messenger is off; older servers that omit it keep the tab.
import type { Locale } from "../i18n/types.ts"

export type TopNavTabId = "docs" | "schedule" | "decisions" | "work" | "messages" | "ax-messenger"

export interface TopNavTabItem {
  id: TopNavTabId
  label: string
  href: string
  requiresBoard: boolean
}

export const TOP_NAV_TABS: readonly TopNavTabItem[] = [
  { id: "docs", label: "문서", href: "/docs", requiresBoard: false },
  { id: "schedule", label: "일정", href: "/schedule", requiresBoard: false },
  { id: "decisions", label: "결정", href: "/decisions", requiresBoard: false },
  { id: "work", label: "작업", href: "/work", requiresBoard: true },
  { id: "messages", label: "대화", href: "/messages", requiresBoard: false },
  { id: "ax-messenger", label: "Matrix 대화", href: "/ax/messenger", requiresBoard: false },
]

const TOP_NAV_TAB_LABELS: Record<Locale, Record<TopNavTabId, string>> = {
  ko: {
    docs: "문서",
    schedule: "일정",
    decisions: "결정",
    work: "작업",
    messages: "대화",
    "ax-messenger": "Matrix 대화",
  },
  en: {
    docs: "Docs",
    schedule: "Schedule",
    decisions: "Decisions",
    work: "Work",
    messages: "Chat",
    "ax-messenger": "Matrix Chat",
  },
}

export function topNavTabLabel(id: TopNavTabId, locale: Locale = "ko"): string {
  return TOP_NAV_TAB_LABELS[locale === "en" ? "en" : "ko"][id] ?? id
}

export function topNavTabs(locale: Locale = "ko"): readonly TopNavTabItem[] {
  return TOP_NAV_TABS.map((tab) => ({ ...tab, label: topNavTabLabel(tab.id, locale) }))
}

export function visibleTopNavTabs(
  hasMessenger: boolean | null | undefined,
  hasAxMessenger?: boolean | null,
  locale: Locale = "ko",
): readonly TopNavTabItem[] {
  return topNavTabs(locale).filter(tab => (tab.id !== "messages" || hasMessenger !== false) && (tab.id !== "ax-messenger" || hasAxMessenger === true))
}

const under = (pathname: string | null, href: string) =>
  pathname !== null && (pathname === href || pathname.startsWith(`${href}/`))

export function isMessagesPath(pathname: string | null): boolean {
  return under(pathname, "/messages")
}

export function isTopNavTabActive(tab: TopNavTabItem, pathname: string | null): boolean {
  return under(pathname, tab.href)
}

export function mainClassForPath(pathname: string | null): string {
  // The messages screen fills the space under the nav bar; its message list scrolls by itself.
  if (isMessagesPath(pathname) || under(pathname, "/ax/messenger")) return "w-full"
  return "max-w-7xl mx-auto px-6 py-8"
}
