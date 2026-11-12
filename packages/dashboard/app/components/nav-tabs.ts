// Top tabs and main-area width. hasMessenger is /api/portal messenger.enabled: the 대화 tab hides only
// when the server says the messenger is off; older servers that omit it keep the tab.
export type TopNavTabId = "docs" | "schedule" | "work" | "messages"

export interface TopNavTabItem {
  id: TopNavTabId
  label: string
  href: string
  requiresBoard: boolean
}

export const TOP_NAV_TABS: readonly TopNavTabItem[] = [
  { id: "docs", label: "문서", href: "/docs", requiresBoard: false },
  { id: "schedule", label: "일정", href: "/schedule", requiresBoard: false },
  { id: "work", label: "작업", href: "/work", requiresBoard: true },
  { id: "messages", label: "대화", href: "/messages", requiresBoard: false },
]

export function visibleTopNavTabs(hasMessenger: boolean | null | undefined): readonly TopNavTabItem[] {
  return hasMessenger === false ? TOP_NAV_TABS.filter((tab) => tab.id !== "messages") : TOP_NAV_TABS
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
  if (isMessagesPath(pathname)) return "w-full"
  return "max-w-7xl mx-auto px-6 py-8"
}
