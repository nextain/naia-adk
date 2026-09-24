"use client"

import { useEffect, useState } from "react"
import Link from "next/link"

interface PortalData {
  board: { port: number } | null
}

export function Nav() {
  const [boardPort, setBoardPort] = useState<number | null>(null)
  const [hostname, setHostname] = useState<string>("localhost")

  useEffect(() => {
    if (typeof window !== "undefined") {
      setHostname(window.location.hostname)
    }

    fetch("/api/portal")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: PortalData | null) => {
        if (data?.board?.port) {
          setBoardPort(data.board.port)
        }
      })
      .catch(() => {
        // Portal API not reachable yet
      })
  }, [])

  const handleBoardClick = (e: React.MouseEvent) => {
    if (!boardPort) {
      e.preventDefault()
      alert("pnpm adk:setup으로 회사 설정을 먼저 하세요")
    }
  }

  const boardHref = boardPort ? `http://${hostname}:${boardPort}/` : "#"

  return (
    <nav className="border-b border-neutral-800 px-6 py-3 flex items-center gap-8">
      <Link href="/" className="font-bold text-lg text-white">
        Naia ADK
      </Link>

      <div className="flex items-center gap-4">
        {boardPort ? (
          <a
            href={boardHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-neutral-300 hover:text-white"
          >
            작업
          </a>
        ) : (
          <button
            type="button"
            onClick={handleBoardClick}
            className="text-sm font-medium text-neutral-500 opacity-50 cursor-not-allowed"
            title="pnpm adk:setup으로 회사 설정을 먼저 하세요"
          >
            작업
          </button>
        )}
        <span className="text-neutral-700">|</span>
        <Link href="/docs" className="text-sm font-medium text-neutral-300 hover:text-white">
          문서
        </Link>
      </div>

      <div className="flex items-center gap-6 ml-4">
        <Link href="/workspace" className="text-sm text-neutral-400 hover:text-white">
          Workspace
        </Link>
        <Link href="/skills" className="text-sm text-neutral-400 hover:text-white">
          Skills
        </Link>
        <Link href="/settings" className="text-sm text-neutral-400 hover:text-white">
          Settings
        </Link>
      </div>
    </nav>
  )
}
