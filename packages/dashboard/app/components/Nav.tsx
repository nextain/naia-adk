"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"

interface PortalData {
  board: { port: number } | null
}

const tabClass = (active: boolean) =>
  `whitespace-nowrap px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
    active ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-white hover:bg-neutral-900"
  }`

export function Nav() {
  const pathname = usePathname() || "/"
  const [hasBoard, setHasBoard] = useState<boolean | null>(null)

  useEffect(() => {
    fetch("/api/portal")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: PortalData | null) => setHasBoard(Boolean(data?.board?.port)))
      .catch(() => setHasBoard(false))
  }, [])

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`)

  return (
    <nav className="sticky top-0 z-10 h-14 border-b border-neutral-800 bg-neutral-950 px-4 sm:px-6 flex items-center gap-3 sm:gap-6">
      <Link href="/docs" className="font-bold text-lg text-white shrink-0 whitespace-nowrap">
        Naia ADK
      </Link>

      <div className="flex items-center gap-1">
        <Link href="/docs" className={tabClass(isActive("/docs"))}>
          문서
        </Link>
        {hasBoard === false ? (
          <span
            className="px-3 py-1.5 text-sm font-medium text-neutral-600 cursor-not-allowed"
            title="회사 설정이 없어 작업보드가 없습니다. pnpm adk:setup으로 회사 설정을 먼저 하세요."
          >
            작업
          </span>
        ) : (
          <Link href="/work" className={tabClass(isActive("/work"))}>
            작업
          </Link>
        )}
      </div>

      {/* 개발자용 화면은 뒤로 뺀다. 좁은 화면에서는 숨긴다. */}
      <div className="ml-auto hidden md:flex items-center gap-1">
        <span className="px-2 text-xs text-neutral-600 whitespace-nowrap">개발자 도구</span>
        <Link href="/" className={tabClass(pathname === "/")}>
          Overview
        </Link>
        <Link href="/workspace" className={tabClass(isActive("/workspace"))}>
          Workspace
        </Link>
        <Link href="/skills" className={tabClass(isActive("/skills"))}>
          Skills
        </Link>
        <Link href="/settings" className={tabClass(isActive("/settings"))}>
          Settings
        </Link>
      </div>
    </nav>
  )
}
